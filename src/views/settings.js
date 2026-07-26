// src/views/settings.js — Settings view: account + sync status + about
// v1.7.1: Fix version label (sebelumnya hardcoded "v1.0.0"), tambah info lengkap
// v1.8.7: Version sekarang dynamic — di-inject via Vite define di vite.config.js
//         (lihat __APP_VERSION__ define). Tidak perlu update manual setiap release.

import { signOut } from '../auth.js';
import { processSyncQueue } from '../sync.js';
import { dbGetSyncQueue, dbGetAllVaultItems, dbGetAllNotes } from '../db.js';

export async function renderSettings(user, onLogout) {
  const main = document.getElementById('appMain');
  if (!main) return;
  const queue = await dbGetSyncQueue();
  const vaultItems = await dbGetAllVaultItems();
  const notes = await dbGetAllNotes();
  // v1.8.7: __APP_VERSION__ di-inject oleh Vite saat build (lihat vite.config.js define).
  // Fallback '1.8.7' kalau define tidak jalan (dev mode tanpa config).
  const version = (typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : null) || '1.8.7';

  // Hitung statistik per tipe
  const typeStats = {};
  for (const item of vaultItems) {
    if (item.deleted_at) continue;
    const t = item.type || 'unknown';
    typeStats[t] = (typeStats[t] || 0) + 1;
  }

  main.innerHTML = `
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
      <h3>📊 Statistik Vault</h3>
      <div class="setting-row">
        <span>Total item</span>
        <strong>${vaultItems.filter(i => !i.deleted_at).length}</strong>
      </div>
      ${Object.entries(typeStats).map(([type, count]) => {
        const labels = {
          prompt: '💬 Prompt',
          context: '📋 Konteks',
          snapshot: '📸 Snapshot',
          screenshot: '🖼️ Media',
          document: '📄 Dokumen',
          link: '🔗 Link',
          bundle: '📦 Bundle'
        };
        return `<div class="setting-row"><span>${labels[type] || type}</span><strong>${count}</strong></div>`;
      }).join('')}
      <div class="setting-row">
        <span>📝 Catatan</span>
        <strong>${notes.length}</strong>
      </div>
    </div>

    <div class="settings-card">
      <h3>Tentang</h3>
      <p>RecallFox PWA <strong>v${version}</strong> — cross-device media + notes + vault sync.</p>
      <p>Pakai kredensial Supabase yang sama dengan addon Firefox. Realtime sync aktif otomatis saat online.</p>
      <p style="margin-top:8px;font-size:11px;color:var(--text-muted)">
        <a href="https://github.com/agungkesmas/recallfox-pwa" target="_blank" rel="noopener">GitHub Repo</a> ·
        <a href="https://github.com/agungkesmas/recallfox" target="_blank" rel="noopener">Addon Repo</a>
      </p>
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
