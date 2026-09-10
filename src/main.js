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
import './styles/v3.css';  // v1.14.0: Concept v3 — dock melayang, hairline, Fokus (paling akhir = override)
import './styles/sticky.css';  // v1.17.0: strip sticky Waktu Shalat & Puasa (paling akhir)

import { getSession, onAuthChange, handleOAuthCallback } from './auth.js';
import { pullFromCloud, subscribeRealtime, unsubscribeRealtime, processSyncQueue, createFileItem, cleanupExpiredTempItems } from './sync.js';
// v1.18.0: label durasi untuk picker tujuan upload sementara
import { TEMP_DURATIONS, TEMP_HOST_LABEL, TEMP_HOST_MANUAL, MANUAL_TEMP_DURATION, MANUAL_SITES, tempExpiresAt } from './lib/temp-upload.js';
// v1.20.0: klasifikasi file 1:1 addon (teks + Office + gambar + arsip)
import { detectFileKind, rejectHintFor, kindIcon, formatBytes, FILE_ACCEPT_ATTR, MAX_TEXT_UPLOAD_BYTES, MAX_BINARY_UPLOAD_BYTES, MAX_TEMP_UPLOAD_BYTES } from './lib/file-kinds.js';
import { renderLogin, renderForgotPassword, renderResetPassword } from './views/login.js';
import { renderMedia, startCaptureFlow, startDocumentFlow } from './views/media.js';
import { renderNotes, openNoteEditor } from './views/notes.js';
import { renderSettings } from './views/settings.js';
import { renderVault, isUserTogglingFolders, handleCreateFolder } from './views/vault.js';
import { renderFocus } from './views/focus.js';  // v1.14.0: Tab Fokus (Pomodoro + RecallTape, local-first)
import { showSharePreviewModal } from './share-target.js';  // v1.9.0
import { mountStickyStrip } from './components/sticky-strip.js';  // v1.17.0: strip sticky Waktu Shalat & Puasa

// v1.14.0: default view 'notes' (Concept v3 — alat harian paling sering dipakai
// dibuka duluan; media/vault tetap satu tap via dock).
let _currentView = 'notes';
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

// v1.14.0: Ikon garis SVG nav (Concept v3) — stroke via CSS (.nav-ic svg)
const NAV_IC = {
  notes: '<svg viewBox="0 0 24 24"><path d="M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"/><path d="M9 13h6M9 17h4"/></svg>',
  media: '<svg viewBox="0 0 24 24"><path d="M4 8a2 2 0 0 1 2-2h2l1.5-2h5L16 6h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8Z"/><circle cx="12" cy="12.5" r="3.2"/></svg>',
  focus: '<svg viewBox="0 0 24 24"><circle cx="12" cy="13" r="7.5"/><path d="M12 10v3.5l2.5 1.5"/><path d="M9.5 2.5h5"/></svg>',
  vault: '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/></svg>',
  acc: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="3.6"/><path d="M5 20a7 7 0 0 1 14 0"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>'
};

function renderShell(user) {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="app-shell">
      <main class="app-main" id="appMain"></main>
      <button class="fab" id="fabAdd" aria-label="Tambah">${NAV_IC.plus}</button>
      <nav class="bottom-nav">
        <button class="nav-btn ${_currentView === 'notes' ? 'active' : ''}" data-view="notes">
          <span class="nav-ic">${NAV_IC.notes}</span><span class="nav-lb">Catatan</span>
        </button>
        <button class="nav-btn ${_currentView === 'media' ? 'active' : ''}" data-view="media">
          <span class="nav-ic">${NAV_IC.media}</span><span class="nav-lb">Media</span>
        </button>
        <button class="nav-btn ${_currentView === 'focus' ? 'active' : ''}" data-view="focus">
          <span class="nav-ic">${NAV_IC.focus}</span><span class="nav-lb">Fokus</span>
        </button>
        <button class="nav-btn ${_currentView === 'vault' ? 'active' : ''}" data-view="vault">
          <span class="nav-ic">${NAV_IC.vault}</span><span class="nav-lb">Vault</span>
        </button>
        <button class="nav-btn ${_currentView === 'settings' ? 'active' : ''}" data-view="settings">
          <span class="nav-ic">${NAV_IC.acc}</span><span class="nav-lb">Akun</span>
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

  // v1.18.0: Auto-hapus file sementara kedaluwarsa — saat shell dirender + tiap
  // 60 detik selama app terbuka. Item temp "hilang sendiri di vault sesuai
  // batas waktu situs upload sementaranya" (permintaan user).
  const _tempToast = (msg) => {
    let t = document.getElementById('rfToast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'rfToast';
      t.className = 'toast';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 2600);
  };
  const _refreshIfVaultView = () => {
    if (_currentView === 'vault' || _currentView === 'media') navigateTo(_currentView);
  };
  (async () => {
    try {
      const n = await cleanupExpiredTempItems(user);
      if (n > 0) {
        _tempToast('⏳ ' + n + ' file sementara kedaluwarsa — dihapus dari vault');
        _refreshIfVaultView();
      }
    } catch (e) { console.warn('[RecallFox] cleanup temp failed:', e); }
  })();
  if (!window.__rfTempCleanupTimer) {
    window.__rfTempCleanupTimer = setInterval(async () => {
      try {
        const u = window.__rfUser;
        if (!u) return;
        const n = await cleanupExpiredTempItems(u);
        if (n > 0) {
          _tempToast('⏳ ' + n + ' file sementara kedaluwarsa — dihapus dari vault');
          _refreshIfVaultView();
        }
      } catch (e) { /* non-fatal */ }
    }, 60000);
  }

  // v1.17.0: Strip sticky Waktu Shalat & Puasa — dirender SEKALI di shell
  // (di luar #appMain) supaya terlihat di SEMUA halaman tanpa ikut re-render
  // navigasi. Model sticky ala popup addon (bar ringkas + detail expandable).
  mountStickyStrip();
}

function openFabMenu() {
  const sheet = document.createElement('div');
  sheet.className = 'bottom-sheet';
  sheet.innerHTML = `
    <div class="sheet-backdrop"></div>
    <div class="sheet-content">
      <div class="sheet-handle"></div>
      <h3>Tambah Baru</h3>
      <button class="sheet-btn" data-action="camera"><span class="sheet-ic">📷</span>Ambil Foto</button>
      <button class="sheet-btn" data-action="gallery"><span class="sheet-ic">🖼️</span>Dari Galeri</button>
      <button class="sheet-btn" data-action="document"><span class="sheet-ic">📄</span>Scan Dokumen</button>
      <button class="sheet-btn" data-action="paste"><span class="sheet-ic">📋</span>Paste dari Clipboard</button>
      <button class="sheet-btn" data-action="upload-file"><span class="sheet-ic">📎</span>Upload File</button>
      <button class="sheet-btn" data-action="note"><span class="sheet-ic">📝</span>Catatan Baru</button>
      <button class="sheet-btn" data-action="folder"><span class="sheet-ic">📁</span>Folder Baru</button>
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

// v1.21.0: perangkap error global — error JS yang dulu bikin tombol mati
// diam-diam kini tampil sebagai toast + tetap tercatat di console.
window.addEventListener('error', (e) => {
  const msg = (e && e.message) || 'unknown error';
  try {
    let t = document.getElementById('rfErrToast');
    if (!t) { t = document.createElement('div'); t.id = 'rfErrToast'; t.className = 'toast'; document.body.appendChild(t); }
    t.textContent = '⚠ Error: ' + msg;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 5000);
  } catch (_) { /* jangan error di dalam penangkap error */ }
});
window.addEventListener('unhandledrejection', (e) => {
  const msg = (e && e.reason && (e.reason.message || e.reason)) || 'unknown error';
  try {
    let t = document.getElementById('rfErrToast');
    if (!t) { t = document.createElement('div'); t.id = 'rfErrToast'; t.className = 'toast'; document.body.appendChild(t); }
    t.textContent = '⚠ Gagal: ' + msg;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 5000);
  } catch (_) {}
});

// v1.13.0: Upload File — modal standar (mirror addon saveFileUploadSheet)
// v1.20.0: samakan addon — teks + kode (2MB) + PDF/Office/gambar/arsip (10MB DB / 1GB temp)
// v1.18.0: DUAL DESTINATION — pilihan tujuan ☁️ Database (permanen) |
// ⏳ Sementara (litterbox.catbox.moe, durasi 1 jam–3 hari, item hilang
// otomatis dari vault saat kedaluwarsa — dihapus oleh cleanupExpiredTempItems
// di PWA + addon, sinkron antar device). Alur isi file tidak berubah.
// v1.21.0: TRIPLE DESTINATION — tambah 🔗 Manual: user upload sendiri di
// situs luar (klik → tab baru), lalu tempel URL. Vault manual TTL 72 jam.
function openFileUploadSheet() {
  const durOptions = TEMP_DURATIONS.map(d => `<option value="${d.id}"${d.id === '72h' ? ' selected' : ''}>${d.label}</option>`).join('');
  const sheet = document.createElement('div');
  sheet.className = 'bottom-sheet';
  sheet.innerHTML = `
    <div class="sheet-backdrop"></div>
    <div class="sheet-content">
      <div class="sheet-handle"></div>
      <h3>📄 Upload File</h3>
      <div style="padding:0 4px">
        <label style="font-size:12px;font-weight:600;color:var(--text-muted)">Judul <span style="font-weight:400">(opsional)</span></label>
        <input type="text" id="fileTitle" placeholder="mis. Catatan rapat..." style="width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:8px;margin:4px 0 12px;font-size:14px;background:var(--surface);color:var(--text)">
        <label style="font-size:12px;font-weight:600;color:var(--text-muted)">Tag <span style="font-weight:400">(pisah koma)</span></label>
        <input type="text" id="fileTags" placeholder="catatan, rapat" style="width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:8px;margin:4px 0 12px;font-size:14px;background:var(--surface);color:var(--text)">
        <label style="font-size:12px;font-weight:600;color:var(--text-muted)">Tujuan simpan</label>
        <div id="fileDestRow" style="display:flex;gap:8px;margin:4px 0 6px">
          <button type="button" id="fileDestDb" style="flex:1;padding:10px 6px;border-radius:10px;border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:13px;font-weight:600;outline:2px solid #6366f1">☁️ Database</button>
          <button type="button" id="fileDestTemp" style="flex:1;padding:10px 6px;border-radius:10px;border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:13px;font-weight:600;opacity:.55">⏳ Sementara</button>
          <button type="button" id="fileDestManual" style="flex:1;padding:10px 6px;border-radius:10px;border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:13px;font-weight:600;opacity:.55">🔗 Manual</button>
        </div>
        <div id="fileTempDurRow" style="display:none;margin:4px 0 6px">
          <label style="font-size:12px;font-weight:600;color:var(--text-muted)">Batas waktu <span style="font-weight:400">(file + item di vault hilang saat habis)</span></label>
          <select id="fileTempDur" style="width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:8px;margin:4px 0 0;font-size:14px;background:var(--surface);color:var(--text)">${durOptions}</select>
        </div>
        <div id="fileManualRow" style="display:none;margin:4px 0 6px;border:1px solid var(--border);border-radius:10px;padding:10px;background:var(--surface)">
          <div style="font-size:12px;font-weight:600;margin-bottom:6px">🌐 Upload manual — pilih situs, upload di tab baru, lalu tempel URL di bawah</div>
          <div id="fileManualSites" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px"></div>
          <label style="font-size:12px;font-weight:600;color:var(--text-muted)">URL file <span style="font-weight:400">(dari situs temp)</span></label>
          <input type="url" id="fileManualUrl" placeholder="https://..." style="width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:8px;margin:4px 0 6px;font-size:14px;background:var(--surface);color:var(--text)">
          <label style="font-size:12px;font-weight:600;color:var(--text-muted)">Nama file <span style="font-weight:400">(opsional — otomatis dari URL bila kosong)</span></label>
          <input type="text" id="fileManualName" placeholder="mis. laporan.pdf" style="width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:8px;margin:4px 0 0;font-size:14px;background:var(--surface);color:var(--text)">
          <div style="font-size:11px;color:var(--text-muted);margin-top:6px">Vault manual hilang otomatis <b>3 hari</b> setelah disimpan (terlepas dari masa simpan situs).</div>
        </div>
        <div id="fileDestNote" style="font-size:11px;color:var(--text-muted);margin:0 0 8px">☁️ Disimpan permanen ke database Supabase (perilaku lama).</div>
        <div id="fileDropzone" style="border:2px dashed var(--border-strong);border-radius:12px;padding:32px 16px;text-align:center;cursor:pointer;transition:border-color 0.2s,background 0.2s">
          <div style="font-size:40px;margin-bottom:8px">📄</div>
          <div style="font-weight:600;color:var(--text)">Klik untuk pilih file</div>
          <div style="font-size:12px;margin-top:4px;color:var(--text-muted)">atau drag & drop</div>
          <div style="font-size:11px;margin-top:4px;color:var(--text-subtle)">Teks + kode (maks 2MB)<br>PDF, Office, gambar, arsip .zip/.rar/.7z/.tar (maks 10MB Database · 1GB Sementara)</div>
        </div>
        <input type="file" id="fileInputHidden" accept="${FILE_ACCEPT_ATTR}" style="display:none">
        <div id="filePreview" style="display:none;margin:12px 0">
          <div style="font-size:12px;color:var(--text-muted)" id="filePreviewMeta"></div>
          <div id="filePreviewText" style="font-size:11px;background:var(--surface-2);padding:8px 10px;border-radius:6px;margin-top:4px;max-height:120px;overflow-y:auto;white-space:pre-wrap;font-family:monospace"></div>
          <div id="filePreviewMedia" style="display:none;margin-top:8px"></div>
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

  // v1.20.0: batas 1:1 addon — teks 2MB (semua tujuan), binary 10MB DB / 1GB temp.
  // MAX_* diimpor dari lib/file-kinds.js (sama persis dengan addon).
  let _fileContent = null, _fileBlob = null, _fileName = '', _fileKind = null, _fileMime = 'text/plain';
  let _fileIsBinary = false, _fileSize = 0;

  const dropzone = sheet.querySelector('#fileDropzone');
  const fileInput = sheet.querySelector('#fileInputHidden');

  function closeSheet() { sheet.remove(); }

  // v1.21.0: helper defensif — referensi elemen diambil SEKALI di awal.
  // Kalau markup berubah dan ID hilang, sheet gagal eksplisit (toast jelas),
  // bukan tombol mati diam-diam seperti insiden v1.20.3.
  function reqEl(id) {
    const el = sheet.querySelector('#' + id);
    if (!el) throw new Error('sheet rusak: #' + id + ' tidak ketemu');
    return el;
  }

  // v1.18.0: Toggle tujuan simpan — Database (permanen) / Sementara (litterbox)
  // v1.21.0: + Manual (URL tempel). Semua listener dipasang SEKALI di sini.
  let _dest = 'db';
  let ui = null;
  try {
    ui = {
      db: reqEl('fileDestDb'), temp: reqEl('fileDestTemp'), manual: reqEl('fileDestManual'),
      durRow: reqEl('fileTempDurRow'), dur: reqEl('fileTempDur'),
      manualRow: reqEl('fileManualRow'), sites: reqEl('fileManualSites'),
      manualUrl: reqEl('fileManualUrl'), manualName: reqEl('fileManualName'),
      note: reqEl('fileDestNote'), dropzone: reqEl('fileDropzone'),
      preview: reqEl('filePreview'), save: reqEl('fileSave'), cancel: reqEl('fileCancel')
    };
    // Daftar situs dirender SEKALI (bukan di tiap repaint — dulu di _paintDest).
    ui.sites.innerHTML = MANUAL_SITES.map(s =>
      '<a href="' + s.url + '" target="_blank" rel="noopener" title="' + s.note + '" style="font-size:11px;padding:6px 8px;border:1px solid var(--border);border-radius:6px;background:var(--surface);text-decoration:none;color:var(--text)">'
      + s.label + '</a>').join('');
  } catch (e) {
    sheet.remove();
    alert('⚠ Sheet upload rusak: ' + e.message);
    throw e;
  }
  function isManualUrlOk() {
    return /^https:\/\//i.test((ui.manualUrl.value || '').trim());
  }
  function updateSaveState() {
    if (_dest === 'manual') { ui.save.disabled = !isManualUrlOk(); return; }
    ui.save.disabled = !(_fileIsBinary ? _fileBlob : _fileContent);
  }
  function _paintDest() {
    const isDb = _dest === 'db', isTemp = _dest === 'temp', isManual = _dest === 'manual';
    ui.db.style.opacity = isDb ? '1' : '.55';
    ui.db.style.outline = isDb ? '2px solid #6366f1' : 'none';
    ui.temp.style.opacity = isTemp ? '1' : '.55';
    ui.temp.style.outline = isTemp ? '2px solid #f59e0b' : 'none';
    ui.manual.style.opacity = isManual ? '1' : '.55';
    ui.manual.style.outline = isManual ? '2px solid #10b981' : 'none';
    ui.durRow.style.display = isTemp ? '' : 'none';
    ui.manualRow.style.display = isManual ? '' : 'none';
    ui.dropzone.style.display = isManual ? 'none' : '';
    if (!isManual) ui.preview.style.display = (_fileIsBinary || _fileContent) ? '' : 'none';
    else ui.preview.style.display = 'none';
    ui.note.textContent = isDb
      ? '☁️ Disimpan permanen ke database Supabase — teks maks 2MB, binary maks 10MB.'
      : isTemp
        ? '⏳ File di-upload ke litterbox (catbox.moe) — URL publik (bisa dibuka AI chat). Teks maks 2MB, binary maks 1GB. Setelah batas waktu habis, item ini hilang OTOMATIS dari vault di semua device.'
        : '🔗 Manual: upload di situs di atas (tab baru), lalu tempel URL. Vault manual hilang otomatis 3 hari.';
    updateSaveState();
  }
  ui.db.addEventListener('click', () => { _dest = 'db'; _paintDest(); });
  ui.temp.addEventListener('click', () => { _dest = 'temp'; _paintDest(); });
  ui.manual.addEventListener('click', () => { _dest = 'manual'; _paintDest(); });
  ui.manualUrl.addEventListener('input', updateSaveState);
  _paintDest();

  // v1.20.0: deteksi 1:1 addon (detectFileKind) — teks + Office + gambar + arsip.
  async function handleFile(file) {
    const info = detectFileKind(file);
    if (!info) {
      const hint = rejectHintFor(file);
      alert('Format tidak didukung: ' + file.name + (hint ? ' — ' + hint : ''));
      return;
    }
    // v1.20.0: batas terluas dulu saat pilih (binary 1GB) — validasi per tujuan diulang saat simpan.
    const pickMax = info.binary ? Math.max(MAX_BINARY_UPLOAD_BYTES, MAX_TEMP_UPLOAD_BYTES) : MAX_TEXT_UPLOAD_BYTES;
    if (file.size > pickMax) { alert('File terlalu besar (maks ' + (info.binary ? '1GB' : '2MB') + ')'); return; }
    _fileName = file.name; _fileKind = info.kind; _fileMime = info.mime;
    _fileIsBinary = !!info.binary; _fileSize = file.size;
    const meta = sheet.querySelector('#filePreviewMeta');
    const previewText = sheet.querySelector('#filePreviewText');
    const previewMedia = sheet.querySelector('#filePreviewMedia');
    const box = sheet.querySelector('#filePreview');
    const sizeStr = formatBytes(file.size);
    if (_fileIsBinary) {
      const buf = await file.arrayBuffer();
      if (!buf || buf.byteLength === 0) { alert('File kosong'); return; }
      _fileContent = null;
      _fileBlob = new Blob([buf], { type: _fileMime });
      meta.textContent = '📎 ' + file.name + ' · ' + sizeStr + ' · ' + info.kind + ' (binary)';
      previewText.style.display = 'none';
      previewMedia.style.display = '';
      const objUrl = URL.createObjectURL(_fileBlob);
      if (info.kind === 'pdf') {
        previewMedia.innerHTML = '<embed src="' + objUrl + '" type="application/pdf" style="width:100%;height:200px;border:none;border-radius:6px">';
      } else if ((_fileMime || '').startsWith('image/')) {
        previewMedia.innerHTML = '<img src="' + objUrl + '" style="max-width:100%;max-height:200px;display:block;margin:0 auto;border-radius:6px">';
      } else {
        previewMedia.innerHTML = '<div style="font-size:12px;padding:10px;background:var(--surface-2);border-radius:6px">' + (kindIcon(info.kind) || '📎') + ' <b>' + file.name.replace(/</g, '&lt;') + '</b> · ' + sizeStr + '<div style="font-size:10px;color:#999;margin-top:2px">Pratinjau tidak tersedia — file disimpan apa adanya & bisa diunduh.</div></div>';
      }
      setTimeout(() => { try { URL.revokeObjectURL(objUrl); } catch (e) {} }, 60000);
    } else {
      const text = await file.text();
      if (!text || text.length === 0) { alert('File kosong'); return; }
      _fileContent = text; _fileBlob = null;
      meta.textContent = '📎 ' + file.name + ' · ' + sizeStr + ' · ' + info.kind;
      previewText.style.display = '';
      previewMedia.style.display = 'none';
      previewMedia.innerHTML = '';
      previewText.textContent = text.slice(0, 500) + (text.length > 500 ? '\n... (' + text.length + ' chars)' : '');
    }
    box.style.display = '';
    updateSaveState();
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
    const user = window.__rfUser;
    if (!user) { alert('Belum login'); return; }
    const title = (sheet.querySelector('#fileTitle').value || '').trim() || _fileName;
    const tags = (sheet.querySelector('#fileTags').value || '').trim();
    const tagList = tags ? tags.split(',').map(s => s.trim()).filter(Boolean) : ['file', _fileKind];
    const btn = sheet.querySelector('#fileSave');
    // v1.21.0: cabang Manual dicek DULU — tidak butuh file terpilih.
    if (_dest === 'manual') {
      const manualUrl = (ui.manualUrl.value || '').trim();
      if (!/^https:\/\//i.test(manualUrl)) { alert('⚠ URL harus diawali https://'); return; }
      let mName = (ui.manualName.value || '').trim() || manualUrl.split('/').pop().split('?')[0] || 'file';
      try { mName = decodeURIComponent(mName); } catch (e) {}
      if (!mName.includes('.')) mName += '.bin';
      const mInfo = detectFileKind({ name: mName }) || { kind: 'bin', mime: 'application/octet-stream', binary: true };
      btn.textContent = '⏳ Menyimpan...'; btn.disabled = true;
      try {
        const result = await createFileItem(user, {
          title: title || mName,
          body: '',
          tags: tagList.length ? tagList : ['file', mInfo.kind],
          source: {
            kind: mInfo.kind, mime: mInfo.mime || 'application/octet-stream',
            fileName: mName, size: 0, isBinary: !!mInfo.binary,
            uploadedFrom: 'pwa-upload-manual', capturedAt: new Date().toISOString(),
            tempHost: TEMP_HOST_MANUAL, tempUrl: manualUrl,
            tempExpiresAt: tempExpiresAt(MANUAL_TEMP_DURATION), tempDuration: MANUAL_TEMP_DURATION
          }
        }, { destination: 'manual' });
        if (result.ok) {
          closeSheet();
          navigateTo('vault');
          setTimeout(() => alert('🔗 Manual tersimpan — hilang otomatis 3 hari dari vault'), 100);
        } else {
          alert('⚠ Gagal simpan manual: ' + (result.error || 'unknown'));
          btn.textContent = 'Simpan File'; btn.disabled = false;
        }
      } catch (e) {
        alert('⚠ Error: ' + e.message);
        btn.textContent = 'Simpan File'; btn.disabled = false;
      }
      return;
    }
    if (!_fileIsBinary && !_fileContent) { alert('Pilih file dulu'); return; }
    if (_fileIsBinary && !_fileBlob) { alert('Pilih file dulu'); return; }
    btn.textContent = '⏳ Menyimpan...'; btn.disabled = true;
    try {
      // v1.20.0: validasi ulang 1:1 addon — teks 2MB (semua tujuan), binary 10MB DB / 1GB temp.
      const isTemp = _dest === 'temp';
      const saveLimit = _fileIsBinary ? (isTemp ? MAX_TEMP_UPLOAD_BYTES : MAX_BINARY_UPLOAD_BYTES) : MAX_TEXT_UPLOAD_BYTES;
      if (_fileSize > saveLimit) {
        alert('⚠ File terlalu besar untuk tujuan ' + (isTemp ? '⏳ Sementara (teks maks 2MB, binary maks 1GB)' : '☁️ Database (teks maks 2MB, binary maks 10MB)'));
        btn.textContent = 'Simpan File'; btn.disabled = false; return;
      }
      const saveOpts = isTemp ? { destination: 'temp', duration: sheet.querySelector('#fileTempDur').value || '72h' } : {};
      if (_fileIsBinary) saveOpts.fileBlob = _fileBlob;
      const result = await createFileItem(user, {
        title, body: _fileIsBinary ? '' : _fileContent, tags: tagList,
        source: { kind: _fileKind, mime: _fileMime, fileName: _fileName, size: _fileSize, isBinary: _fileIsBinary, uploadedFrom: isTemp ? 'pwa-upload-temp' : 'pwa-upload', capturedAt: new Date().toISOString() }
      }, saveOpts);
      if (result.ok) {
        closeSheet();
        navigateTo('vault');
        if (isTemp) {
          const d = (TEMP_DURATIONS.find(x => x.id === result.duration) || {}).label || result.duration;
          setTimeout(() => alert('⏳ ' + _fileName + ' terupload sementara (' + d + ') — hilang otomatis dari vault'), 100);
        } else {
          setTimeout(() => alert('📤 ' + _fileName + ' tersimpan ✓'), 100);
        }
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
  else if (view === 'focus') renderFocus(user, refreshCurrentView);
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
