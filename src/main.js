// src/main.js — Entry point, router, init Supabase + realtime
// v1.1.0: Fix shell render bug — views render to #appMain, bottom nav persists.
// v1.1.0: FAB unified — 1 button for both media & catatan (minim klik).

import './styles/base.css';
import './styles/components.css';
import './styles/views.css';

import { getSession, onAuthChange } from './auth.js';
import { pullFromCloud, subscribeRealtime, unsubscribeRealtime, processSyncQueue } from './sync.js';
import { renderLogin } from './views/login.js';
import { renderMedia, startCaptureFlow } from './views/media.js';
import { renderNotes, openNoteEditor } from './views/notes.js';
import { renderSettings } from './views/settings.js';

let _currentView = 'media';
let _realtimeBound = false;

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
  }).catch(e => console.warn('[RecallFox] pull failed:', e.message));

  processSyncQueue(user).catch(e => console.warn('[RecallFox] queue failed:', e.message));

  if (!_realtimeBound) {
    subscribeRealtime(user, () => {
      // Realtime event → re-render current view
      if (_currentView === 'media' || _currentView === 'notes') {
        navigateTo(_currentView);
      }
    });
    _realtimeBound = true;
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
  // v1.1.0: FAB unified — 1 tap → bottom sheet dengan 4 opsi (Foto/Galeri/Paste/Catatan)
  // Minim klik: user bisa akses semua dari 1 tombol.
  const sheet = document.createElement('div');
  sheet.className = 'bottom-sheet';
  sheet.innerHTML = `
    <div class="sheet-backdrop"></div>
    <div class="sheet-content">
      <div class="sheet-handle"></div>
      <h3>Tambah Baru</h3>
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
