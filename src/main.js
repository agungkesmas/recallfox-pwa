// src/main.js — Entry point, router, init Supabase + realtime
// v1.2.0: Realtime WS tidak broadcast (infrastruktur Supabase bermasalah).
//         Fallback ke polling 10 detik — pasti jalan, tidak bergantung Realtime.
// v1.1.0: Fix shell render bug — views render to #appMain, bottom nav persists.
// v1.1.0: FAB unified — 1 button for both media & catatan (minim klik).

import './styles/base.css';
import './styles/components.css';
import './styles/views.css';

import { getSession, onAuthChange } from './auth.js';
import { pullFromCloud, subscribeRealtime, unsubscribeRealtime, processSyncQueue } from './sync.js';
import { renderLogin } from './views/login.js';
import { renderMedia, startCaptureFlow, startDocumentFlow } from './views/media.js';
import { renderNotes, openNoteEditor } from './views/notes.js';
import { renderSettings } from './views/settings.js';

let _currentView = 'media';
let _realtimeBound = false;
let _pollTimer = null;
let _retryTimer = null;
let _lastPullAt = 0;
const POLL_INTERVAL_MS = 10000; // 10 detik
const RETRY_INTERVAL_MS = 30000; // 30 detik — retry sync queue yang gagal

async function init() {
  const session = await getSession();
  if (session?.user) {
    await showApp(session.user);
  } else {
    showLogin();
  }

  onAuthChange(async (user) => {
    if (user) {
      await showApp(user);
    } else {
      stopPolling();
      stopRetryQueue();
      unsubscribeRealtime();
      _realtimeBound = false;
      showLogin();
    }
  });

  window.addEventListener('online', async () => {
    console.log('[RecallFox] Back online — processing sync queue');
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
  // Render shell FIRST supaya UI langsung muncul (jangan tunggu pull)
  renderShell(user);
  navigateTo(_currentView);

  // Background: pull + subscribe (jangan block UI)
  pullFromCloud(user).then(() => {
    // Re-render setelah pull supaya data baru muncul
    navigateTo(_currentView);
    _lastPullAt = Date.now();
  }).catch(e => console.warn('[RecallFox] pull failed:', e.message));

  processSyncQueue(user).catch(e => console.warn('[RecallFox] queue failed:', e.message));

  // v1.2.0: Realtime WS tidak broadcast (infrastruktur Supabase bermasalah).
  // Tetap subscribe sebagai backup (kalau nanti Realtime di-fix di sisi server),
  // tapi ANDALKAN polling 10 detik untuk sinkronisasi cross-device.
  if (!_realtimeBound) {
    subscribeRealtime(user, () => {
      // Realtime event (kalau ada) → re-render current view
      if (_currentView === 'media' || _currentView === 'notes') {
        navigateTo(_currentView);
      }
    });
    _realtimeBound = true;
  }

  // v1.2.0: Polling 10 detik — paling pasti jalan, tidak bergantung Realtime.
  startPolling(user);
  // v1.6.0: Auto-retry sync queue 30 detik — anti-gagal save.
  startRetryQueue(user);
}

function startPolling(user) {
  // Clear existing timer
  if (_pollTimer) clearInterval(_pollTimer);

  _pollTimer = setInterval(async () => {
    if (!window.__rfUser) {
      stopPolling();
      return;
    }
    // v1.6.3: Skip polling kalau offline — supaya tidak spam error di console
    // dan tidak boros battery (request gagal terus).
    if (!navigator.onLine) {
      console.log('[RecallFox] Polling: offline, skip');
      return;
    }
    try {
      // Cek apakah ada perubahan di cloud dengan compare max(updated_at)
      // Kalau ada → pullFromCloud + re-render
      const { supabase, VAULT_TABLE, NOTES_TABLE } = await import('./supabase.js');
      const since = new Date(_lastPullAt - 5000).toISOString(); // 5s buffer

      const [vaultRes, notesRes] = await Promise.all([
        supabase.from(VAULT_TABLE).select('updated_at')
          .eq('user_id', user.id).gt('updated_at', since)
          .order('updated_at', { ascending: false }).limit(1),
        supabase.from(NOTES_TABLE).select('updated_at')
          .eq('user_id', user.id).gt('updated_at', since)
          .order('updated_at', { ascending: false }).limit(1)
      ]);

      const vaultChanged = vaultRes.data && vaultRes.data.length > 0;
      const notesChanged = notesRes.data && notesRes.data.length > 0;

      if (vaultChanged || notesChanged) {
        console.log('[RecallFox] Polling: cloud changed, pulling...', { vaultChanged, notesChanged });
        await pullFromCloud(user);
        _lastPullAt = Date.now();
        if (_currentView === 'media' || _currentView === 'notes') {
          navigateTo(_currentView);
        }
      }
    } catch (e) {
      console.warn('[RecallFox] Polling error:', e.message);
    }
  }, POLL_INTERVAL_MS);

  console.log(`[RecallFox] Polling started (every ${POLL_INTERVAL_MS / 1000}s)`);
}

function stopPolling() {
  if (_pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = null;
    console.log('[RecallFox] Polling stopped');
  }
}

// v1.6.0: Auto-retry sync queue setiap 30 detik — anti-gagal save.
// Sebelumnya: queue hanya diproses saat init atau saat event 'online'.
//   → kalau cloud timeout saat save, user lihat "Tersimpan lokal — retry otomatis"
//   tapi retry tidak pernah terjadi sampai user refresh page.
// Sekarang: setInterval 30s proses queue terus-menerus. Kalau ada item di queue
//   (upload screenshot/doc/note yang gagal), akan di-retry otomatis.
function startRetryQueue(user) {
  if (_retryTimer) clearInterval(_retryTimer);
  _retryTimer = setInterval(async () => {
    if (!window.__rfUser) {
      stopRetryQueue();
      return;
    }
    // v1.6.3: Skip retry queue kalau offline — supaya tidak spam error
    if (!navigator.onLine) {
      return;
    }
    try {
      await processSyncQueue(user);
    } catch (e) {
      // Silent fail — tidak perlu console.warn (queue akan retry lagi 30s lagi)
    }
  }, RETRY_INTERVAL_MS);
  console.log(`[RecallFox] Retry queue started (every ${RETRY_INTERVAL_MS / 1000}s)`);
}

function stopRetryQueue() {
  if (_retryTimer) {
    clearInterval(_retryTimer);
    _retryTimer = null;
    console.log('[RecallFox] Retry queue stopped');
  }
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
  // v1.3.0: FAB unified — 1 tap → bottom sheet dengan 5 opsi (Foto/Galeri/Paste/Dokumen/Catatan)
  // Minim klik: user bisa akses semua dari 1 tombol.
  const sheet = document.createElement('div');
  sheet.className = 'bottom-sheet';
  sheet.innerHTML = `
    <div class="sheet-backdrop"></div>
    <div class="sheet-content">
      <div class="sheet-handle"></div>
      <h3>Tambah Baru</h3>
      <button class="sheet-btn sheet-btn-doc" data-action="document">
        <span class="sheet-ic">📄</span>
        <div><div class="sheet-t">Scan Dokumen</div><div class="sheet-s">Foto dokumen, auto-rapihin + filter</div></div>
      </button>
      <button class="sheet-btn sheet-btn-primary" data-action="camera">
        <span class="sheet-ic">📷</span>
        <div><div class="sheet-t">Foto Kamera</div><div class="sheet-s">Buka kamera HP</div></div>
      </button>
      <button class="sheet-btn" data-action="gallery">
        <span class="sheet-ic">🖼️</span>
        <div><div class="sheet-t">Dari Galeri</div><div class="sheet-s">Pilih foto dari rol kamera</div></div>
      </button>
      <button class="sheet-btn" data-action="paste">
        <span class="sheet-ic">📋</span>
        <div><div class="sheet-t">Paste Gambar</div><div class="sheet-s">Dari clipboard HP</div></div>
      </button>
      <button class="sheet-btn sheet-btn-note" data-action="note">
        <span class="sheet-ic">📝</span>
        <div><div class="sheet-t">Catatan Baru</div><div class="sheet-s">Tulis catatan</div></div>
      </button>
      <button class="sheet-btn sheet-cancel" data-action="cancel">Batal</button>
    </div>
  `;
  document.body.appendChild(sheet);
  setTimeout(() => sheet.classList.add('open'), 10);

  const close = () => {
    sheet.classList.remove('open');
    setTimeout(() => { if (sheet.parentNode) document.body.removeChild(sheet); }, 200);
  };

  sheet.addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) {
      if (e.target.classList.contains('sheet-backdrop')) close();
      return;
    }
    const action = btn.dataset.action;
    if (action === 'cancel') { close(); return; }
    close();
    if (action === 'note') {
      openNoteEditor(null, refreshCurrentView);
    } else if (action === 'document') {
      // v1.3.0: Document flow (CamScanner-like)
      startDocumentFlow('camera', refreshCurrentView);
    } else {
      // Media capture flow
      startCaptureFlow(action, refreshCurrentView);
    }
  });
}

function navigateTo(view) {
  _currentView = view;
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  const user = window.__rfUser;
  if (!user) return;
  if (view === 'media') renderMedia(user, refreshCurrentView);
  else if (view === 'notes') renderNotes(user, refreshCurrentView);
  else if (view === 'settings') renderSettings(user, () => showLogin());
}

// Expose for views to call
window.__rfNavigate = navigateTo;
window.__rfRefreshCurrent = refreshCurrentView;

init();
