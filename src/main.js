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

import { getSession, onAuthChange, handleOAuthCallback } from './auth.js';
import { pullFromCloud, subscribeRealtime, unsubscribeRealtime, processSyncQueue, createFileItem } from './sync.js';
import { renderLogin, renderForgotPassword, renderResetPassword } from './views/login.js';
import { renderMedia, startCaptureFlow, startDocumentFlow } from './views/media.js';
import { renderNotes, openNoteEditor } from './views/notes.js';
import { renderSettings } from './views/settings.js';
import { renderVault, isUserTogglingFolders, handleCreateFolder } from './views/vault.js';
import { showSharePreviewModal } from './share-target.js';  // v1.9.0

let _currentView = 'media';
let _realtimeBound = false;
let _pollTimer = null;
let _retryTimer = null;
let _lastPullAt = 0;
let _skipPullOnBoot = false;  // v1.9.2: true kalau share-target detected
let _appRendered = false;  // v1.10.5: guard — showApp hanya boleh dipanggil sekali
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
  // v1.11.8: Proses token OAuth callback (Google login) yang balik di URL.
  // Harus dijalankan sebelum getSession() supaya session ter-set dulu.
  const handledOAuth = await handleOAuthCallback();

  const session = await getSession();

  // v1.11.4: Hash routing untuk auth pages (forgot-password, reset-password)
  const hash = window.location.hash || '';
  if (hash.startsWith('#/forgot-password')) {
    renderForgotPassword();
    onAuthChange(async (user) => {
      // Kalau user tiba-tiba login (misal session masih aktif), redirect ke app
      if (user) {
        window.location.hash = '';
        window.location.reload();
      }
    });
    return;
  }
  if (hash.startsWith('#/reset-password')) {
    renderResetPassword();
    return;
  }

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
      // v1.10.5: JANGAN showApp lagi kalau sudah dirender (init sudah panggil).
      // Sebelumnya: onAuthChange fire setelah init → showApp 2x → duplicate event listeners.
      if (!_appRendered) {
        await showApp(user);
      }
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
  _appRendered = false;  // v1.10.5: reset guard supaya showApp bisa jalan lagi setelah re-login
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
  // v1.10.5: Guard — showApp hanya boleh dipanggil sekali per session.
  // Sebelumnya: init() + onAuthChange keduanya panggil showApp → renderShell 2x
  // → FAB event listener bound 2x → klik FAB = buka sheet 2x = handleCreateFolder 2x
  // = 2 folder tercipta. Juga polling/realtime double-bind.
  if (_appRendered) {
    console.log('[RecallFox] showApp already rendered — skip duplicate');
    return;
  }
  _appRendered = true;

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
      <button class="sheet-btn" data-action="upload-file">📄 Upload File Teks</button>
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
    else if (action === 'document') startDocumentFlow('camera');
    else if (action === 'paste') startCaptureFlow('paste');
    else if (action === 'upload-file') openFileUploadSheet();
    else if (action === 'note') { navigateTo('notes'); setTimeout(openNoteEditor, 100); }
    else if (action === 'folder') { navigateTo('vault'); setTimeout(() => handleCreateFolder(), 100); }
  });
}

// v1.13.0: Upload File Teks — modal standar (mirror addon saveFileUploadSheet)
function openFileUploadSheet() {
  const sheet = document.createElement('div');
  sheet.className = 'bottom-sheet';
  sheet.innerHTML = `
    <div class="sheet-backdrop"></div>
    <div class="sheet-content">
      <div class="sheet-handle"></div>
      <h3>📄 Upload File Teks</h3>
      <div style="padding:0 4px">
        <label style="font-size:12px;font-weight:600;color:var(--text-muted)">Judul <span style="font-weight:400">(opsional)</span></label>
        <input type="text" id="fileTitle" placeholder="mis. Catatan rapat..." style="width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:8px;margin:4px 0 12px;font-size:14px;background:var(--surface);color:var(--text)">
        <label style="font-size:12px;font-weight:600;color:var(--text-muted)">Tag <span style="font-weight:400">(pisah koma)</span></label>
        <input type="text" id="fileTags" placeholder="catatan, rapat" style="width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:8px;margin:4px 0 12px;font-size:14px;background:var(--surface);color:var(--text)">
        <div id="fileDropzone" style="border:2px dashed var(--border-strong);border-radius:12px;padding:32px 16px;text-align:center;cursor:pointer;transition:border-color 0.2s,background 0.2s">
          <div style="font-size:40px;margin-bottom:8px">📄</div>
          <div style="font-weight:600;color:var(--text)">Klik untuk pilih file</div>
          <div style="font-size:12px;margin-top:4px;color:var(--text-muted)">atau drag & drop</div>
          <div style="font-size:11px;margin-top:4px;color:var(--text-subtle)">Format: .md, .txt, .json, .html, .csv, .yaml (max 2MB)</div>
        </div>
        <input type="file" id="fileInputHidden" accept=".md,.markdown,.txt,.json,.html,.htm,.csv,.yaml,.yml" style="display:none">
        <div id="filePreview" style="display:none;margin:12px 0">
          <div style="font-size:12px;color:var(--text-muted)" id="filePreviewMeta"></div>
          <div id="filePreviewText" style="font-size:11px;background:var(--surface-2);padding:8px 10px;border-radius:6px;margin-top:4px;max-height:120px;overflow-y:auto;white-space:pre-wrap;font-family:monospace"></div>
        </div>
        <div style="display:flex;gap:8px;margin-top:16px">
          <button class="btn btn-secondary" id="fileCancel" style="flex:1">Batal</button>
          <button class="btn btn-primary" id="fileSave" style="flex:1" disabled>Simpan File</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(sheet);
  setTimeout(() => sheet.classList.add('open'), 10);

  const FILE_WHITELIST = {
    '.md': { kind: 'md', mime: 'text/markdown' },
    '.markdown': { kind: 'md', mime: 'text/markdown' },
    '.txt': { kind: 'txt', mime: 'text/plain' },
    '.json': { kind: 'json', mime: 'application/json' },
    '.html': { kind: 'html', mime: 'text/html' },
    '.htm': { kind: 'html', mime: 'text/html' },
    '.csv': { kind: 'csv', mime: 'text/csv' },
    '.yaml': { kind: 'yaml', mime: 'text/yaml' },
    '.yml': { kind: 'yaml', mime: 'text/yaml' }
  };
  const MAX_BYTES = 2 * 1024 * 1024;
  let _fileContent = null, _fileName = '', _fileKind = null, _fileMime = 'text/plain';

  const dropzone = sheet.querySelector('#fileDropzone');
  const fileInput = sheet.querySelector('#fileInputHidden');

  function closeSheet() { sheet.remove(); }

  function detectKind(name) {
    const dot = name.lastIndexOf('.');
    if (dot < 0) return null;
    return FILE_WHITELIST[name.slice(dot).toLowerCase()] || null;
  }

  async function handleFile(file) {
    const info = detectKind(file.name);
    if (!info) { alert('Format tidak didukung: ' + file.name); return; }
    if (file.size > MAX_BYTES) { alert('File terlalu besar (max 2MB)'); return; }
    const text = await file.text();
    if (!text || text.length === 0) { alert('File kosong'); return; }
    _fileContent = text; _fileName = file.name; _fileKind = info.kind; _fileMime = info.mime;
    const meta = sheet.querySelector('#filePreviewMeta');
    const preview = sheet.querySelector('#filePreviewText');
    const box = sheet.querySelector('#filePreview');
    const sizeKb = (file.size / 1024).toFixed(1);
    meta.textContent = '📎 ' + file.name + ' · ' + sizeKb + ' KB · ' + info.kind;
    preview.textContent = text.slice(0, 500) + (text.length > 500 ? '\n... (' + text.length + ' chars)' : '');
    box.style.display = '';
    sheet.querySelector('#fileSave').disabled = false;
    const titleEl = sheet.querySelector('#fileTitle');
    if (!titleEl.value.trim()) titleEl.value = file.name.replace(/\.[^.]+$/, '').slice(0, 60);
  }

  dropzone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async (e) => { if (e.target.files[0]) await handleFile(e.target.files[0]); });
  dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.style.borderColor = 'var(--primary)'; dropzone.style.background = 'var(--primary-soft)'; });
  dropzone.addEventListener('dragleave', () => { dropzone.style.borderColor = 'var(--border-strong)'; dropzone.style.background = ''; });
  dropzone.addEventListener('drop', async (e) => { e.preventDefault(); dropzone.style.borderColor = 'var(--border-strong)'; dropzone.style.background = ''; if (e.dataTransfer.files[0]) await handleFile(e.dataTransfer.files[0]); });

  sheet.querySelector('#fileCancel').addEventListener('click', closeSheet);
  sheet.querySelector('.sheet-backdrop').addEventListener('click', closeSheet);

  sheet.querySelector('#fileSave').addEventListener('click', async () => {
    if (!_fileContent) { alert('Pilih file dulu'); return; }
    const user = window.__rfUser;
    if (!user) { alert('Belum login'); return; }
    const title = (sheet.querySelector('#fileTitle').value || '').trim() || _fileName;
    const tags = (sheet.querySelector('#fileTags').value || '').trim();
    const tagList = tags ? tags.split(',').map(s => s.trim()).filter(Boolean) : ['file', _fileKind];
    const btn = sheet.querySelector('#fileSave');
    btn.textContent = '⏳ Menyimpan...'; btn.disabled = true;
    try {
      const result = await createFileItem(user, {
        title, body: _fileContent, tags: tagList,
        source: { kind: _fileKind, mime: _fileMime, fileName: _fileName, size: _fileContent.length, uploadedFrom: 'pwa-upload', capturedAt: new Date().toISOString() }
      });
      if (result.ok) {
        closeSheet();
        navigateTo('vault');
        setTimeout(() => alert('📤 ' + _fileName + ' tersimpan ✓'), 100);
      } else {
        alert('⚠ Gagal simpan: ' + (result.error || 'unknown'));
        btn.textContent = 'Simpan File'; btn.disabled = false;
      }
    } catch (e) {
      alert('⚠ Error: ' + e.message);
      btn.textContent = 'Simpan File'; btn.disabled = false;
    }
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

// v1.11.9: Industry-standard session persistence — keep session alive indefinitely.
//
// Problem: User gets logged out after ~1 day of inactivity. This happens because:
//   1. When PWA tab is closed, autoRefreshToken doesn't run → access_token expires (1h)
//   2. When user reopens PWA after >1 day, refresh_token has also expired → logout
//
// Fix: Two-pronged approach:
//   1. Heartbeat: while tab is open, call getSession() every 30 min. This triggers
//      autoRefreshToken which rotates the refresh_token → extends its expiry.
//      As long as user opens PWA at least once every REFRESH_TOKEN_EXPIRY period
//      (default 7 days), session stays alive.
//   2. visibilitychange: when user switches back to PWA tab, immediately call
//      getSession() → triggers refresh if token is near expiry. This catches
//      the case where user left tab open in background for hours.
let _sessionHeartbeat = null;

function startSessionHeartbeat() {
  if (_sessionHeartbeat) clearInterval(_sessionHeartbeat);
  // Every 30 minutes, call getSession() — triggers autoRefreshToken if needed
  _sessionHeartbeat = setInterval(async () => {
    try {
      const session = await getSession();
      if (session) {
        console.log('[RecallFox] Session heartbeat: OK, expires_at =',
          new Date((session.expires_at || 0) * 1000).toISOString());
      } else {
        console.log('[RecallFox] Session heartbeat: no session (logged out?)');
        // Session might have been revoked — reload to show login page
        if (window.__rfUser) {
          console.log('[RecallFox] Session lost — reloading to login page');
          window.location.reload();
        }
      }
    } catch (e) {
      console.warn('[RecallFox] Session heartbeat error:', e.message);
    }
  }, 30 * 60 * 1000); // 30 minutes
}

// visibilitychange: when tab becomes visible, trigger session check immediately
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible') {
    try {
      const session = await getSession();
      if (!session && window.__rfUser) {
        // Session was lost while tab was in background — reload
        console.log('[RecallFox] Tab visible again — session lost, reloading');
        window.location.reload();
      } else if (session) {
        console.log('[RecallFox] Tab visible again — session OK');
      }
    } catch (e) {
      console.warn('[RecallFox] Visibility session check error:', e.message);
    }
  }
});

// Start heartbeat after init completes
init().then(() => {
  startSessionHeartbeat();
}).catch(e => {
  console.error('[RecallFox] Init error:', e);
  // Still start heartbeat even if init fails — session might still be valid
  startSessionHeartbeat();
});
