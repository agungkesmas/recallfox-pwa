// src/main.js — Entry point, router, init Supabase + realtime

import './styles/base.css';
import './styles/components.css';
import './styles/views.css';

import { getSession, onAuthChange } from './auth.js';
import { pullFromCloud, subscribeRealtime, unsubscribeRealtime, processSyncQueue } from './sync.js';
import { renderLogin } from './views/login.js';
import { renderMedia } from './views/media.js';
import { renderNotes } from './views/notes.js';
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

  // Online/offline → process queue when back online
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
  renderLogin(async (user) => {
    await showApp(user);
  });
}

async function showApp(user) {
  window.__rfUser = user;
  // Initial pull + subscribe realtime
  await pullFromCloud(user);
  await processSyncQueue(user);
  if (!_realtimeBound) {
    subscribeRealtime(user, () => {
      // Realtime event → re-render current view
      const refreshFns = { media: renderMedia, notes: renderNotes, settings: renderSettings };
      if (_currentView === 'media') renderMedia(user, refreshAll);
      else if (_currentView === 'notes') renderNotes(user, refreshAll);
    });
    _realtimeBound = true;
  }
  renderShell(user);
  navigateTo(_currentView);
}

function refreshAll() {
  if (window.__rfUser) navigateTo(_currentView);
}

function renderShell(user) {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="app-shell">
      <main class="app-main" id="appMain"></main>
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
}

function navigateTo(view) {
  _currentView = view;
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  const user = window.__rfUser;
  if (!user) return;
  if (view === 'media') renderMedia(user, refreshAll);
  else if (view === 'notes') renderNotes(user, refreshAll);
  else if (view === 'settings') renderSettings(user, () => showLogin());
}

init();
