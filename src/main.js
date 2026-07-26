// src/main.js — Entry point, router, init Supabase + realtime
// v1.9.2: Share target — anti race condition.
//   Saat share-target detected, skip pullFromCloud di boot. Pulling akan jalan via polling 10s.
//   Ini mencegah race antara pullFromCloud (yang lambat, 30+ detik) dengan createShareItem
//   yang juga akses Supabase. Sebelumnya: pullFromCloud.then() → navigateTo('vault') → 
//   renderList async baca IndexedDB saat pullFromCloud sedang merge/delete → race → "memuat terus".
// v1.9.0: Share target — SIMPLIFIED. Jangan proses share di init().
//   Hanya simpan ke sessionStorage, render app normal, lalu tampilkan
//   preview modal SETELAH app fully rendered. User konfirmasi → simpan.

import './styles/base.css';
import './styles/components.css';
import './styles/views.css';

import { getSession, onAuthChange } from './auth.js';
import { pullFromCloud, subscribeRealtime, unsubscribeRealtime, processSyncQueue } from './sync.js';
import { renderLogin } from './views/login.js';
import { renderMedia, startCaptureFlow, startDocumentFlow } from './views/media.js';
import { renderNotes, openNoteEditor } from './views/notes.js';
import { renderSettings } from './views/settings.js';
import { renderVault, isUserTogglingFolders } from './views/vault.js';
import { handleCreateFolder } from './views/vault.js';
import { showSharePreviewModal } from './share-target.js';  // v1.9.0

let _currentView = 'media';
let _realtimeBound = false;
let _pollTimer = null;
let _retryTimer = null;
let _lastPullAt = 0;
let _skipPullOnBoot = false;  // v1.9.2: true kalau share-target detected
const POLL_INTERVAL_MS = 10000;
const RETRY_INTERVAL_MS = 30000;

async function init() {
  // v1.9.0: Cek share-target route — HANYA simpan ke sessionStorage.
  // JANGAN proses apapun di sini. App render normal dulu.
  // Preview modal ditampilkan SETELAH showApp selesai.
  const currentUrl = new URL(window.location.href);
  const isShareTarget = currentUrl.pathname.endsWith('/share-target') ||
                        currentUrl.pathname.endsWith('/share-target/');

  if (isShareTarget) {
    // Simpan share data ke sessionStorage — akan diproses setelah app ready
    const params = currentUrl.searchParams;
    const shareData = {
      title: params.get('title') || '',
      text: params.get('text') || '',
      url: params.get('url') || ''
    };
    sessionStorage.setItem('rf_pending_share', JSON.stringify(shareData));
    // v1.9.2: Set flag — pullFromCloud di showApp akan skip jika true
    _skipPullOnBoot = true;
    console.log('[RecallFox] Share target detected — saved to sessionStorage:', shareData);

    // Clean URL IMMEDIATELY — hapus /share-target supaya SW navigation tidak loop
    try {
      window.history.replaceState({}, document.title, new URL('./', currentUrl).href);
    } catch (e) {}
  }

  // === RENDER APP NORMAL — tidak peduli share-target atau tidak ===
  const session = await getSession();
  if (session?.user) {
    await showApp(session.user);
    // v1.9.0: Setelah app fully rendered, cek apakah ada pending share
    const pending = sessionStorage.getItem('rf_pending_share');
    if (pending) {
      sessionStorage.removeItem('rf_pending_share');
      try {
        const data = JSON.parse(pending);
        // Tampilkan preview modal — user konfirmasi sebelum simpan
        setTimeout(() => showSharePreviewModal(data, session.user), 500);
      } catch (e) {
        console.error('[RecallFox] Pending share parse error:', e.message);
      }
    }
  } else {
    showLogin();
    // Kalau belum login + ada pending share, proses setelah login
    // (processPendingShare di onAuthChange akan handle)
  }

  onAuthChange(async (user) => {
    if (user) {
      await showApp(user);
      // v1.9.0: Cek pending share setelah login
      const pending = sessionStorage.getItem('rf_pending_share');
      if (pending) {
        sessionStorage.removeItem('rf_pending_share');
        try {
          const data = JSON.parse(pending);
          setTimeout(() => showSharePreviewModal(data, user), 500);
        } catch (e) {}
      }
    } else {
      stopPolling();
      stopRetryQueue();
      unsubscribeRealtime();
      _realtimeBound = false;
      showLogin();
    }
  });

  window.addEventListener('online', async () => {
    const session = await getSession();
    if (session?.user) {
      await processSyncQueue(session.user);
      await pullFromCloud(session.user);
    }
  });
}

function showLogin() {
  window.__rfUser = null;
  stopPolling();
  stopRetryQueue();
  unsubscribeRealtime();
  _realtimeBound = false;
  document.getElementById('app').innerHTML = '';
  renderLogin(async (user) => {
    await showApp(user);
  });
}

async function showApp(user) {
  window.__rfUser = user;
  renderShell(user);
  navigateTo(_currentView);

  // v1.9.2: Skip pullFromCloud di boot jika share-target detected.
  // Pulling akan jalan via polling 10s. Ini anti race condition.
  if (_skipPullOnBoot) {
    console.log('[RecallFox] Skipping pullFromCloud on boot (share-target mode)');
    _skipPullOnBoot = false;  // reset flag
    _lastPullAt = Date.now();  // supaya polling 10s tidak langsung re-pull
  } else {
    pullFromCloud(user).then(() => {
      navigateTo(_currentView);
      _lastPullAt = Date.now();
    }).catch(e => console.warn('[RecallFox] pull failed:', e.message));
  }

  processSyncQueue(user).catch(e => console.warn('[RecallFox] queue failed:', e.message));

  if (!_realtimeBound) {
    subscribeRealtime(user, () => {
      // v1.9.6: Anti-race — kalau user baru saja toggle folder, skip re-render
      if (_currentView === 'media' || _currentView === 'vault' || _currentView === 'notes') {
        if (_currentView === 'vault' && isUserTogglingFolders()) {
          console.log('[RecallFox] Realtime skip re-render vault (user toggling folders)');
        } else {
          navigateTo(_currentView);
        }
      }
    });
    _realtimeBound = true;
  }

  startPolling(user);
  startRetryQueue(user);
}

function startPolling(user) {
  if (_pollTimer) clearInterval(_pollTimer);
  _pollTimer = setInterval(async () => {
    if (!window.__rfUser) { stopPolling(); return; }
    if (!navigator.onLine) return;
    try {
      const { supabase, VAULT_TABLE, NOTES_TABLE } = await import('./supabase.js');
      const since = new Date(_lastPullAt - 5000).toISOString();
      const [vaultRes, notesRes] = await Promise.all([
        supabase.from(VAULT_TABLE).select('updated_at')
          .eq('user_id', user.id).gt('updated_at', since)
          .order('updated_at', { ascending: false }).limit(1),
        supabase.from(NOTES_TABLE).select('updated_at')
          .eq('user_id', user.id).gt('updated_at', since)
          .order('updated_at', { ascending: false }).limit(1)
      ]);
      if ((vaultRes.data?.length > 0) || (notesRes.data?.length > 0)) {
        await pullFromCloud(user);
        _lastPullAt = Date.now();
        // v1.9.6: Anti-race — kalau user baru saja toggle folder (< 2s),
        // skip re-render supaya tidak override visual expand/collapse state.
        if (_currentView === 'media' || _currentView === 'vault' || _currentView === 'notes') {
          if (_currentView === 'vault' && isUserTogglingFolders()) {
            console.log('[RecallFox] Polling skip re-render vault (user toggling folders)');
          } else {
            navigateTo(_currentView);
          }
        }
      }
    } catch (e) {}
  }, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
}

function startRetryQueue(user) {
  if (_retryTimer) clearInterval(_retryTimer);
  _retryTimer = setInterval(async () => {
    if (!window.__rfUser) { stopRetryQueue(); return; }
    try { await processSyncQueue(user); } catch (e) {}
  }, RETRY_INTERVAL_MS);
}

function stopRetryQueue() {
  if (_retryTimer) { clearInterval(_retryTimer); _retryTimer = null; }
}

function refreshCurrentView() {
  if (window.__rfUser) navigateTo(_currentView);
}

function renderShell(user) {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="app-shell">
      <main class="app-main" id="appMain"></main>
      <button class="fab" id="fabAdd" aria-label="Tambah">+</button>
      <nav class="bottom-nav">
        <button class="nav-btn ${_currentView === 'media' ? 'active' : ''}" data-view="media">
          <span class="nav-ic">📸</span><span class="nav-lb">Media</span>
        </button>
        <button class="nav-btn ${_currentView === 'vault' ? 'active' : ''}" data-view="vault">
          <span class="nav-ic">🗂️</span><span class="nav-lb">Vault</span>
        </button>
        <button class="nav-btn ${_currentView === 'notes' ? 'active' : ''}" data-view="notes">
          <span class="nav-ic">📝</span><span class="nav-lb">Catatan</span>
        </button>
        <button class="nav-btn ${_currentView === 'settings' ? 'active' : ''}" data-view="settings">
          <span class="nav-ic">⚙️</span><span class="nav-lb">Akun</span>
        </button>
      </nav>
    </div>
  `;
  document.querySelector('.bottom-nav').addEventListener('click', (e) => {
    const btn = e.target.closest('.nav-btn');
    if (!btn) return;
    navigateTo(btn.dataset.view);
  });
  document.getElementById('fabAdd').addEventListener('click', openFabMenu);
}

function openFabMenu() {
  const sheet = document.createElement('div');
  sheet.className = 'bottom-sheet';
  sheet.innerHTML = `
    <div class="sheet-backdrop"></div>
    <div class="sheet-content">
      <div class="sheet-handle"></div>
      <h3>Tambah Baru</h3>
      <button class="sheet-btn" data-action="camera">📷 Ambil Foto</button>
      <button class="sheet-btn" data-action="gallery">🖼️ Dari Galeri</button>
      <button class="sheet-btn" data-action="document">📄 Scan Dokumen</button>
      <button class="sheet-btn" data-action="paste">📋 Paste dari Clipboard</button>
      <button class="sheet-btn" data-action="note">📝 Catatan Baru</button>
      <button class="sheet-btn" data-action="folder">📁 Folder Baru</button>
      <button class="sheet-btn cancel" data-action="cancel">Batal</button>
    </div>
  `;
  document.body.appendChild(sheet);
  setTimeout(() => sheet.classList.add('open'), 10);
  sheet.addEventListener('click', (e) => {
    const btn = e.target.closest('.sheet-btn');
    const backdrop = e.target.classList.contains('sheet-backdrop');
    if (!btn && !backdrop) return;
    const action = btn?.dataset.action || 'cancel';
    sheet.remove();
    if (action === 'camera') startCaptureFlow('camera');
    else if (action === 'gallery') startCaptureFlow('gallery');
    else if (action === 'document') startDocumentFlow();
    else if (action === 'paste') startCaptureFlow('paste');
    else if (action === 'note') { navigateTo('notes'); setTimeout(openNoteEditor, 100); }
    else if (action === 'folder') { navigateTo('vault'); setTimeout(() => handleCreateFolder(), 100); }
  });
}

function navigateTo(view) {
  _currentView = view;
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  const user = window.__rfUser;
  if (!user) return;
  if (view === 'media') renderMedia(user, refreshCurrentView);
  else if (view === 'vault') renderVault(user, refreshCurrentView);
  else if (view === 'notes') renderNotes(user, refreshCurrentView);
  else if (view === 'settings') renderSettings(user, () => showLogin());
}

window.__rfNavigate = navigateTo;
window.__rfRefreshCurrent = refreshCurrentView;

init();
