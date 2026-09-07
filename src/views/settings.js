// src/views/settings.js — Settings view: account + sync status + about
// v1.7.1: Fix version label (sebelumnya hardcoded "v1.0.0"), tambah info lengkap
// v1.8.7: Version sekarang dynamic — di-inject via Vite define di vite.config.js
//         (lihat __APP_VERSION__ define). Tidak perlu update manual setiap release.
// v1.11.4: Tambah "Change Password" section dengan verifikasi password lama

import { signOut, changePassword, getPasswordStrength, userHasPassword, createPasswordForOAuthUser } from '../auth.js';
import { processSyncQueue } from '../sync.js';
import { dbGetSyncQueue, dbGetAllVaultItems, dbGetAllNotes } from '../db.js';
// v1.17.0: Waktu Shalat & Puasa — kartu pengaturan untuk strip sticky
import { loadPrayerSettings, savePrayerSettings, ensurePrayerTimes, buildStripModel, dayAheadLabel } from '../lib/prayer.js';
import { reverseGeocode, geocode, formatCountdown, to12Hour } from '../lib/salahtime.js';

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

  // v1.16.0: User login Google (tanpa identity 'email') belum punya password —
  // form "Ubah Password" (verifikasi password lama) selalu gagal untuk mereka.
  // Tampilkan form "Buat Password" tanpa field password lama sebagai gantinya.
  const hasPw = userHasPassword(user);

  const pwFormHtml = hasPw ? `
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
      </form>` : `
      <p style="font-size:13px;color:var(--text-muted);margin:0 0 12px">
        Akun kamu login via <strong>Google</strong> dan belum punya password. Buat password
        supaya bisa juga login pakai email + password (tanpa Google).
      </p>
      <form id="changePwForm" class="settings-form">
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
        <button type="submit" class="btn btn-primary" id="changePwBtn">Buat Password</button>
      </form>`;

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
      <h3>🔐 ${hasPw ? 'Ubah Password' : 'Buat Password'}</h3>
      ${pwFormHtml}
      <div id="changePwMsg" class="login-error"></div>
    </div>

    ${prayerCardHtml()}

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

  // v1.11.4: Change Password handlers (v1.16.0: + mode Buat Password utk user Google)
  wireChangePassword(user, hasPw);

  // v1.17.0: Waktu Shalat & Puasa — wire kartu pengaturan
  wirePrayerCard();

  // v1.17.0: Strip sticky minta scroll ke kartu ini (tap "Atur" dari strip)
  try {
    if (sessionStorage.getItem('rf_scroll_to_prayer_card') === '1') {
      sessionStorage.removeItem('rf_scroll_to_prayer_card');
      setTimeout(() => {
        const card = document.getElementById('prayerCard');
        if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 120);
    }
  } catch (e) {}

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
// v1.16.0: hasPw=false (user Google) → mode Buat Password tanpa verifikasi
// password lama; sukses TIDAK memaksa logout (session Google tetap valid).
function wireChangePassword(user, hasPw) {
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

    const newPw = newPwInput.value;
    const confirmPw = confirmInput.value;

    if (newPw !== confirmPw) {
      msg.textContent = '❌ Password baru dan konfirmasi tidak cocok';
      return;
    }

    btn.disabled = true;
    btn.textContent = hasPw ? '⏳ Memverifikasi...' : '⏳ Membuat...';
    msg.textContent = hasPw ? '⏳ Memverifikasi password lama & memperbarui...'
                            : '⏳ Membuat password akun...';
    msg.style.color = 'var(--text-muted, #6b7280)';

    const res = hasPw
      ? await changePassword(document.getElementById('currentPw').value, newPw, user.email)
      : await createPasswordForOAuthUser(newPw, user.email);

    btn.disabled = false;
    btn.textContent = hasPw ? 'Ubah Password' : 'Buat Password';

    if (res.ok) {
      form.reset();
      strengthBar.style.width = '0%';
      strengthLabel.textContent = 'Kosong';
      if (hasPw) {
        msg.innerHTML = '✓ <strong>Password berhasil diubah.</strong> Silakan login lagi dengan password baru.';
        msg.style.color = '#16a34a';
        // Auto logout setelah 3 detik supaya user re-login dengan password baru
        setTimeout(async () => {
          await signOut();
          onLogoutCompat();
        }, 3000);
      } else {
        msg.innerHTML = '✓ <strong>Password berhasil dibuat.</strong> Sekarang kamu juga bisa login pakai email + password. Kamu tetap login di perangkat ini.';
        msg.style.color = '#16a34a';
      }
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

// ============ v1.17.0: Waktu Shalat & Puasa (kartu pengaturan) ============
// Settings disimpan di localStorage (rf_prayer_settings_v1) — pola konsisten
// PWA (rf_* per-device, sama seperti fokus/notes). savePrayerSettings otomatis
// memicu event 'rf-prayer-updated' → strip sticky refresh sendiri.

function prayerCardHtml() {
  const s = loadPrayerSettings();
  const locName = s.location || (typeof s.lat === 'number' ? s.lat.toFixed(3) + ', ' + s.lng.toFixed(3) : 'belum diatur');
  return `
    <div class="settings-card" id="prayerCard">
      <h3>🕌 Waktu Shalat &amp; Puasa</h3>
      <p style="font-size:12px;color:var(--text-muted);margin:0 0 10px">
        Jadwal shalat metode Muhammadiyah (Aladhan API) + jadwal puasa sunnah
        (Senin-Kamis, Ayyamul Bidh, Asyura, Arafah, dll) — tampil sebagai
        <strong>strip sticky</strong> di semua halaman, ala addon.
      </p>
      <div class="setting-row">
        <span>Strip sticky</span>
        <button class="btn ${s.enabled ? 'btn-danger' : 'btn-primary'}" id="prayerToggle">${s.enabled ? 'Nonaktifkan' : 'Aktifkan'}</button>
      </div>
      <div class="setting-row">
        <span>Lokasi</span>
        <strong id="prayerLocName">${escapeHtml(locName)}</strong>
      </div>
      <div class="prayer-actions">
        <button class="btn btn-secondary" id="prayerGps">📍 Pakai Lokasi GPS</button>
      </div>
      <div class="prayer-search">
        <input id="prayerCity" placeholder="Cari kota (mis. Yogyakarta)" autocomplete="off">
        <button class="btn btn-primary" id="prayerSearchBtn">Cari</button>
      </div>
      <div class="setting-row">
        <span>Format waktu</span>
        <select class="prayer-format-select" id="prayerFormat">
          <option value="24h" ${s.timeFormat !== '12h' ? 'selected' : ''}>24 jam</option>
          <option value="12h" ${s.timeFormat === '12h' ? 'selected' : ''}>12 jam (AM/PM)</option>
        </select>
      </div>
      <div class="prayer-status" id="prayerStatus">…</div>
    </div>`;
}

function wirePrayerCard() {
  const toggleBtn = document.getElementById('prayerToggle');
  const gpsBtn = document.getElementById('prayerGps');
  const searchBtn = document.getElementById('prayerSearchBtn');
  const formatSel = document.getElementById('prayerFormat');
  if (!toggleBtn) return;

  renderPrayerStatus();

  toggleBtn.addEventListener('click', () => {
    const s = loadPrayerSettings();
    s.enabled = !s.enabled;
    savePrayerSettings(s);
    toggleBtn.textContent = s.enabled ? 'Nonaktifkan' : 'Aktifkan';
    toggleBtn.className = 'btn ' + (s.enabled ? 'btn-danger' : 'btn-primary');
    renderPrayerStatus();
  });

  gpsBtn.addEventListener('click', () => {
    if (!navigator.geolocation) {
      setPrayerStatus('<span class="err">❌ Perangkat tidak mendukung geolokasi — pakai pencarian kota.</span>');
      return;
    }
    setPrayerStatus('⏳ Mengambil lokasi GPS…');
    navigator.geolocation.getCurrentPosition(async (pos) => {
      try {
        const lat = pos.coords.latitude, lng = pos.coords.longitude;
        setPrayerStatus('⏳ Menerjemahkan koordinat ke nama kota…');
        const display = await reverseGeocode(lat, lng);
        const s = loadPrayerSettings();
        s.enabled = true; s.lat = lat; s.lng = lng;
        s.location = display || ('Lat ' + lat.toFixed(3) + ', Lng ' + lng.toFixed(3));
        savePrayerSettings(s);
        document.getElementById('prayerLocName').textContent = s.location;
        await refreshPrayerStatusAfterFetch();
      } catch (e) {
        setPrayerStatus('<span class="err">❌ ' + escapeHtml(e.message || 'gagal memuat jadwal') + '</span>');
      }
    }, (err) => {
      setPrayerStatus('<span class="err">❌ GPS gagal (' + escapeHtml(err.message) + ') — izinkan akses lokasi atau cari kota manual.</span>');
    }, { enableHighAccuracy: false, timeout: 12000, maximumAge: 600000 });
  });

  const doSearch = async () => {
    const q = (document.getElementById('prayerCity')?.value || '').trim();
    if (q.length < 3) { setPrayerStatus('<span class="err">❌ Ketik nama kota minimal 3 huruf.</span>'); return; }
    setPrayerStatus('⏳ Mencari "' + escapeHtml(q) + '"…');
    try {
      const g = await geocode(q);
      const s = loadPrayerSettings();
      s.enabled = true; s.lat = g.lat; s.lng = g.lng;
      // ambil nama ringkas: 2 bagian pertama, tiap bagian di-trim
      s.location = (g.display || '').split(',').slice(0, 2).map(x => x.trim()).filter(Boolean).join(', ') || q;
      savePrayerSettings(s);
      document.getElementById('prayerLocName').textContent = s.location;
      await refreshPrayerStatusAfterFetch();
    } catch (e) {
      setPrayerStatus('<span class="err">❌ Kota tidak ditemukan / gagal: ' + escapeHtml(e.message || '?') + '</span>');
    }
  };
  searchBtn.addEventListener('click', doSearch);
  document.getElementById('prayerCity').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); doSearch(); }
  });

  formatSel.addEventListener('change', () => {
    const s = loadPrayerSettings();
    s.timeFormat = formatSel.value === '12h' ? '12h' : '24h';
    savePrayerSettings(s);
    renderPrayerStatus();
  });
}

function setPrayerStatus(html) {
  const el = document.getElementById('prayerStatus');
  if (el) el.innerHTML = html;
}

async function refreshPrayerStatusAfterFetch() {
  setPrayerStatus('⏳ Memuat jadwal shalat hari ini…');
  try {
    await ensurePrayerTimes(true);  // force — lokasi baru berubah
    await renderPrayerStatus();
  } catch (e) {
    setPrayerStatus('<span class="err">❌ ' + escapeHtml(e.message || 'gagal memuat jadwal') + '</span>');
  }
}

async function renderPrayerStatus() {
  const s = loadPrayerSettings();
  if (!s.enabled) {
    setPrayerStatus('Strip sedang <b>nonaktif</b> — klik Aktifkan lalu atur lokasi (GPS atau cari kota).');
    return;
  }
  if (typeof s.lat !== 'number' || typeof s.lng !== 'number') {
    setPrayerStatus('⚠ <b>Belum ada lokasi</b> — pakai <b>📍 GPS</b> atau cari <b>kota</b> dulu supaya jadwal bisa dimuat.');
    return;
  }
  setPrayerStatus('⏳ Memuat jadwal…');
  try {
    const times = await ensurePrayerTimes();
    const model = buildStripModel(times);
    const fmt = s.timeFormat === '12h' ? to12Hour : (t) => t;
    let html = '';
    if (model && model.hijriRaw) html += '📅 <b>' + escapeHtml(model.hijriRaw) + '</b><br>';
    if (model && model.next) html += '🕌 Berikutnya: <b>' + (model.next.isSunnah ? '🌟 ' : '') + escapeHtml(model.next.name) + ' ' + fmt(model.next.time) + '</b> (−' + formatCountdown(model.next.minutesUntil) + ')<br>';
    if (model && model.fast) html += '🌙 Puasa berikutnya: <b>' + escapeHtml(model.fast.name) + '</b> (' + dayAheadLabel(model.fast.daysAhead) + ')';
    else if (model) html += '🌙 Tidak ada puasa sunnah dalam 14 hari ke depan.';
    if (s.cachedAt) html += '<br><span style="font-size:10px;color:var(--text-muted)">Update: ' + escapeHtml(new Date(s.cachedAt).toLocaleString('id-ID')) + ' · <span class="okc">strip aktif di semua halaman</span></span>';
    setPrayerStatus(html || '<span class="err">❌ jadwal kosong</span>');
  } catch (e) {
    setPrayerStatus('<span class="err">❌ ' + escapeHtml(e.message || 'gagal memuat jadwal') + '</span>');
  }
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
