// src/views/login.js — Login view (v1.11.4: tambah forgot password + reset password views)
//
// 3 view yang dikelola file ini:
// 1. renderLogin — login/signup form (default)
// 2. renderForgotPassword — request reset email
// 3. renderResetPassword — set new password (setelah klik link di email)

import { signIn, signUp, requestPasswordReset, updatePasswordWithRecoveryToken, getPasswordStrength, validatePassword } from '../auth.js';
import { supabase } from '../supabase.js';

export function renderLogin(onSuccess) {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="login-wrap">
      <div class="login-card">
        <div class="login-logo">🦊</div>
        <h1>RecallFox PWA</h1>
        <p class="login-sub">Sync media + catatan dengan addon Firefox</p>
        <form id="loginForm" class="login-form">
          <input type="email" id="email" placeholder="Email" required autocomplete="email">
          <input type="password" id="password" placeholder="Password" required autocomplete="current-password">
          <button type="submit" class="btn btn-primary">Masuk</button>
          <button type="button" id="signupBtn" class="btn btn-secondary">Daftar akun baru</button>
        </form>
        <div style="text-align:center;margin:16px 0 8px;font-size:12px;color:#a8a29e">— atau —</div>
        <button type="button" id="googleLoginBtn" class="btn btn-google" style="width:100%;display:flex;align-items:center;justify-content:center;gap:8px;padding:10px;background:#fff;color:#1f2937;border:1px solid #d1d5db;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer">
          <svg width="18" height="18" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
          Login dengan Google
        </button>
        <div class="login-links">
          <a href="#/forgot-password" id="forgotLink">Lupa password?</a>
        </div>
        <div id="loginError" class="login-error"></div>
      </div>
    </div>
  `;

  const form = document.getElementById('loginForm');
  const err = document.getElementById('loginError');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;
    const res = await signIn(email, password);
    if (res.ok) {
      onSuccess(res.user);
    } else {
      err.textContent = '❌ ' + res.error;
    }
  });
  document.getElementById('signupBtn').addEventListener('click', async () => {
    err.textContent = '';
    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;
    if (!email || !password) { err.textContent = 'Isi email + password dulu'; return; }
    const res = await signUp(email, password);
    if (res.ok) {
      err.textContent = '✓ Akun dibuat. Cek email untuk konfirmasi (kalau perlu), lalu masuk.';
    } else {
      err.textContent = '❌ ' + res.error;
    }
  });
  document.getElementById('forgotLink').addEventListener('click', (e) => {
    e.preventDefault();
    renderForgotPassword();
  });

  // v1.11.7: Login dengan Google (OAuth) — redirect ke Supabase Google OAuth
  document.getElementById('googleLoginBtn').addEventListener('click', async () => {
    err.textContent = '⏳ Mengarahkan ke Google...';
    try {
      const { data, error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: window.location.origin }
      });
      if (error) {
        err.textContent = '❌ ' + error.message;
      }
      // Jika sukses, Supabase redirect ke Google → kembali ke PWA dengan session
    } catch (e) {
      err.textContent = '❌ ' + e.message;
    }
  });
}

// ===========================================================================
// v1.11.4: Forgot Password view
// ===========================================================================

export function renderForgotPassword() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="login-wrap">
      <div class="login-card">
        <div class="login-logo">🔑</div>
        <h1>Lupa Password</h1>
        <p class="login-sub">Kami akan kirim link reset password ke email kamu</p>
        <form id="forgotForm" class="login-form">
          <input type="email" id="email" placeholder="Email terdaftar" required autocomplete="email">
          <button type="submit" class="btn btn-primary">Kirim Link Reset</button>
          <button type="button" id="backBtn" class="btn btn-secondary">← Kembali ke Login</button>
        </form>
        <div id="forgotMsg" class="login-error"></div>
        <div class="login-info">
          <p>📋 <strong>Catatan:</strong></p>
          <ul>
            <li>Email reset dikirim dalam 1-5 menit</li>
            <li>Cek folder spam kalau tidak ada di inbox</li>
            <li>Link reset berlaku 1 jam</li>
            <li>Maksimal 5 request per jam (rate limit)</li>
          </ul>
        </div>
      </div>
    </div>
  `;

  const form = document.getElementById('forgotForm');
  const msg = document.getElementById('forgotMsg');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    msg.textContent = '';
    const email = document.getElementById('email').value.trim();
    if (!email) { msg.textContent = 'Email wajib diisi'; return; }
    msg.textContent = '⏳ Mengirim email reset...';
    msg.style.color = 'var(--text-muted, #6b7280)';
    const res = await requestPasswordReset(email);
    if (res.ok) {
      msg.innerHTML = '✓ <strong>Email reset sudah dikirim</strong> ke <code>' + escapeHtml(email) + '</code>.<br>Cek inbox (dan folder spam) untuk link reset password.';
      msg.style.color = '#16a34a';
      // Hide form supaya user tidak double-submit
      form.style.display = 'none';
    } else {
      msg.textContent = '❌ ' + res.error;
      msg.style.color = '#dc2626';
    }
  });
  document.getElementById('backBtn').addEventListener('click', () => {
    window.location.hash = '#/login';
    window.location.reload();
  });
}

// ===========================================================================
// v1.11.4: Reset Password view (setelah klik link di email)
// ===========================================================================

export function renderResetPassword() {
  const app = document.getElementById('app');

  // Supabase redirect format (redirectTo = https://recallfox-pwa.vercel.app/#/reset-password):
  //   - Biasanya:  https://host/#/reset-password#access_token=...&refresh_token=...&type=recovery
  //     (Supabase append token sebagai fragment kedua — double hash)
  //   - Dokumentasi lama / query-style: https://host/#/reset-password?type=recovery&access_token=...
  // Parsing robust: cari name=value di seluruh URL (query + hash fragment).
  const href = window.location.href;
  const getParam = (name) => {
    const re = new RegExp('[#?&]' + name + '=([^&#]*)');
    const m = href.match(re);
    return m ? decodeURIComponent(m[1]) : null;
  };
  const type = getParam('type') || '';
  const accessToken = getParam('access_token');
  const refreshToken = getParam('refresh_token');

  if (type === 'recovery' && accessToken) {
    // Supabase biasanya set session otomatis dari URL. Kalau tidak, tampilkan error.
    // Karena detectSessionInUrl=false di config kita, kita pakai cara manual:
    // supabase.auth.setSession({ access_token, refresh_token }) — butuh refresh_token juga.
    // Lebih simpel: pakai detectSessionInUrl=true untuk URL ini saja.
    // Atau: biarkan Supabase handle di next reload dengan detectSessionInUrl=true.
    // Solusi paling clean: set session manual.
    import('../supabase.js').then(async ({ supabase }) => {
      if (refreshToken) {
        const { data, error } = await supabase.auth.setSession({
          access_token: accessToken,
          refresh_token: refreshToken
        });
        if (error) {
          renderResetError(app, 'Link reset tidak valid atau sudah expired. Silakan request reset password baru.');
          return;
        }
        // Clean URL supaya token tidak tersebar di history
        window.history.replaceState({}, document.title, window.location.pathname + '#/reset-password');
        renderResetForm(app);
      } else {
        renderResetError(app, 'Link reset tidak lengkap (refresh token missing). Silakan request reset password baru.');
      }
    });
    return;
  }

  // Kalau tidak ada token, cek apakah user sudah login (mungkin dari change password flow)
  import('../auth.js').then(async ({ getSession }) => {
    const session = await getSession();
    if (session) {
      renderResetForm(app);
    } else {
      renderResetError(app, 'Link reset tidak valid. Silakan request reset password baru dari halaman login.');
    }
  });
}

function renderResetForm(app) {
  app.innerHTML = `
    <div class="login-wrap">
      <div class="login-card">
        <div class="login-logo">🔐</div>
        <h1>Reset Password</h1>
        <p class="login-sub">Masukkan password baru untuk akun kamu</p>
        <form id="resetForm" class="login-form">
          <div class="password-field">
            <input type="password" id="newPassword" placeholder="Password baru" required autocomplete="new-password" minlength="8">
            <button type="button" class="toggle-pw" id="togglePw" title="Tampilkan password">👁️</button>
          </div>
          <div class="pw-strength" id="pwStrength">
            <div class="pw-strength-bar"><div class="pw-strength-fill" style="width:0%"></div></div>
            <span class="pw-strength-label">Kosong</span>
          </div>
          <input type="password" id="confirmPassword" placeholder="Ulangi password baru" required autocomplete="new-password">
          <button type="submit" class="btn btn-primary">Reset Password</button>
        </form>
        <div id="resetMsg" class="login-error"></div>
        <div class="login-info">
          <p>📋 <strong>Syarat password:</strong></p>
          <ul>
            <li>Minimal 8 karakter</li>
            <li>Harus mengandung huruf dan angka</li>
            <li>Tidak boleh sama dengan email</li>
          </ul>
        </div>
      </div>
    </div>
  `;

  const form = document.getElementById('resetForm');
  const msg = document.getElementById('resetMsg');
  const newPwInput = document.getElementById('newPassword');
  const confirmInput = document.getElementById('confirmPassword');
  const strengthBar = document.querySelector('.pw-strength-fill');
  const strengthLabel = document.querySelector('.pw-strength-label');

  // Toggle show/hide password
  document.getElementById('togglePw').addEventListener('click', () => {
    const isPw = newPwInput.type === 'password';
    newPwInput.type = isPw ? 'text' : 'password';
    confirmInput.type = isPw ? 'text' : 'password';
    document.getElementById('togglePw').textContent = isPw ? '🙈' : '👁️';
  });

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
    const newPw = newPwInput.value;
    const confirmPw = confirmInput.value;
    if (newPw !== confirmPw) {
      msg.textContent = '❌ Password baru dan konfirmasi tidak cocok';
      return;
    }
    msg.textContent = '⏳ Memperbarui password...';
    msg.style.color = 'var(--text-muted, #6b7280)';
    const res = await updatePasswordWithRecoveryToken(newPw);
    if (res.ok) {
      msg.innerHTML = '✓ <strong>Password berhasil direset!</strong><br>Mengarahkan ke login...';
      msg.style.color = '#16a34a';
      form.style.display = 'none';
      // Sign out dari recovery session, lalu redirect ke login
      setTimeout(async () => {
        const { supabase } = await import('../supabase.js');
        await supabase.auth.signOut();
        window.location.hash = '#/login';
        window.location.reload();
      }, 2000);
    } else {
      msg.textContent = '❌ ' + res.error;
      msg.style.color = '#dc2626';
    }
  });
}

function renderResetError(app, message) {
  app.innerHTML = `
    <div class="login-wrap">
      <div class="login-card">
        <div class="login-logo">⚠️</div>
        <h1>Reset Gagal</h1>
        <p class="login-error">${escapeHtml(message)}</p>
        <button class="btn btn-primary" onclick="window.location.hash = '#/login'; window.location.reload();">← Kembali ke Login</button>
      </div>
    </div>
  `;
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
