// src/views/settings.js — Settings view: account + sync status + about
// v1.7.1: Fix version label (sebelumnya hardcoded "v1.0.0"), tambah info lengkap
// v1.8.7: Version sekarang dynamic — di-inject via Vite define di vite.config.js
//         (lihat __APP_VERSION__ define). Tidak perlu update manual setiap release.
// v1.11.4: Tambah "Change Password" section dengan verifikasi password lama

import { signOut, changePassword, getPasswordStrength } from '../auth.js';
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
      <h3>🔐 Keamanan</h3>
      <p style="font-size:13px;color:var(--text-muted);margin:0 0 12px">
        Ubah password akun kamu. Demi keamanan, password lama akan diverifikasi dulu.
      </p>
      <form id="changePwForm" class="settings-form">
        <div class="password-field">
          <input type="password" id="currentPw" placeholder="Password lama" required autocomplete="current-password">
          <button type="button" class="toggle-pw" data-target="currentPw" title="Tampilkan">👁️</button>
        </div>
        <div class="password-field">
          <input type="password" id="newPw" placeholder="Password baru (min 8 karakter)" required autocomplete="new-password" minlength="8">
          <button type="button" class="toggle-pw" data-target="newPw" title="Tampilkan">👁️</button>
        </div>
        <div class="pw-strength" id="pwStrength">
          <div class="pw-strength-bar"><div class="pw-strength-fill" style="width:0%"></div></div>
          <span class="pw-strength-label">Kosong</span>
        </div>
        <div class="password-field">
          <input type="password" id="confirmPw" placeholder="Ulangi password baru" required autocomplete="new-password">
          <button type="button" class="toggle-pw" data-target="confirmPw" title="Tampilkan">👁️</button>
        </div>
        <button type="submit" class="btn btn-primary" id="changePwBtn">Ubah Password</button>
      </form>
      <div id="changePwMsg" class="login-error"></div>
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

  // Logout
  document.getElementById('logoutBtn').addEventListener('click', async () => {
    if (!confirm('Keluar dari akun?')) return;
    await signOut();
    onLogout();
  });

  // Retry sync
  document.getElementById('retrySyncBtn').addEventListener('click', async () => {
    await processSyncQueue(user);
    renderSettings(user, onLogout);
  });

  // v1.11.4: Change Password handlers
  wireChangePassword(user);

  // v1.11.4: Toggle password visibility (reusable)
  document.querySelectorAll('.toggle-pw[data-target]').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = document.getElementById(btn.dataset.target);
      if (!target) return;
      const isPw = target.type === 'password';
      target.type = isPw ? 'text' : 'password';
      btn.textContent = isPw ? '🙈' : '👁️';
    });
  });
}

// v1.11.4: Wire change password form
function wireChangePassword(user) {
  const form = document.getElementById('changePwForm');
  const msg = document.getElementById('changePwMsg');
  const newPwInput = document.getElementById('newPw');
  const confirmInput = document.getElementById('confirmPw');
  const strengthBar = document.querySelector('#pwStrength .pw-strength-fill');
  const strengthLabel = document.querySelector('#pwStrength .pw-strength-label');
  const btn = document.getElementById('changePwBtn');

  // Real-time strength meter
  newPwInput.addEventListener('input', () => {
    const pw = newPwInput.value;
    const { score, label, color } = getPasswordStrength(pw);
    strengthBar.style.width = ((score / 4) * 100) + '%';
    strengthBar.style.background = color;
    strengthLabel.textContent = label;
    strengthLabel.style.color = color;
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    msg.textContent = '';
    msg.style.color = '';

    const currentPw = document.getElementById('currentPw').value;
    const newPw = newPwInput.value;
    const confirmPw = confirmInput.value;

    if (newPw !== confirmPw) {
      msg.textContent = '❌ Password baru dan konfirmasi tidak cocok';
      return;
    }

    btn.disabled = true;
    btn.textContent = '⏳ Memverifikasi...';
    msg.textContent = '⏳ Memverifikasi password lama & memperbarui...';
    msg.style.color = 'var(--text-muted, #6b7280)';

    const res = await changePassword(currentPw, newPw, user.email);

    btn.disabled = false;
    btn.textContent = 'Ubah Password';

    if (res.ok) {
      msg.innerHTML = '✓ <strong>Password berhasil diubah.</strong> Silakan login lagi dengan password baru.';
      msg.style.color = '#16a34a';
      form.reset();
      strengthBar.style.width = '0%';
      strengthLabel.textContent = 'Kosong';
      // Auto logout setelah 3 detik supaya user re-login dengan password baru
      setTimeout(async () => {
        await signOut();
        onLogoutCompat();
      }, 3000);
    } else {
      msg.textContent = '❌ ' + res.error;
      msg.style.color = '#dc2626';
    }
  });
}

// Compat: call onLogout if available (settings.js scope)
function onLogoutCompat() {
  // Re-read main and trigger navigation by clearing hash
  window.location.hash = '#/login';
  window.location.reload();
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
