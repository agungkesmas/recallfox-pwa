// src/views/settings.js — Settings view: account + sync status

import { signOut } from '../auth.js';
import { processSyncQueue } from '../sync.js';
import { dbGetSyncQueue } from '../db.js';

export async function renderSettings(user, onLogout) {
  const app = document.getElementById('app');
  const queue = await dbGetSyncQueue();
  app.innerHTML = `
    <div class="view-header">
      <h2>⚙️ Akun</h2>
    </div>
    <div class="settings-card">
      <div class="setting-row">
        <span>Email</span>
        <strong>${escapeHtml(user.email || '-')}</strong>
      </div>
      <div class="setting-row">
        <span>User ID</span>
        <code>${escapeHtml(user.id)}</code>
      </div>
      <div class="setting-row">
        <span>Device ID</span>
        <code>${escapeHtml(localStorage.getItem('recallfox_pwa_device_id') || '-')}</code>
      </div>
      <div class="setting-row">
        <span>Sync queue</span>
        <strong>${queue.length} pending</strong>
      </div>
      <div class="setting-actions">
        <button class="btn btn-secondary" id="retrySyncBtn">↻ Retry Sync Queue</button>
        <button class="btn btn-danger" id="logoutBtn">🚪 Keluar</button>
      </div>
    </div>
    <div class="settings-card">
      <h3>Tentang</h3>
      <p>RecallFox PWA v1.0.0 — cross-device media + notes sync.</p>
      <p>Pakai kredensial Supabase yang sama dengan addon Firefox. Realtime sync aktif otomatis saat online.</p>
    </div>
  `;
  document.getElementById('logoutBtn').addEventListener('click', async () => {
    if (!confirm('Keluar dari akun?')) return;
    await signOut();
    onLogout();
  });
  document.getElementById('retrySyncBtn').addEventListener('click', async () => {
    await processSyncQueue(user);
    renderSettings(user, onLogout);
  });
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
