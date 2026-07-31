// src/views/login.js — Login view (v1.11.4: tambah forgot password + reset password views)
//
// 3 view yang dikelola file ini:
// 1. renderLogin — login/signup form (default)
// 2. renderForgotPassword — request reset email
// 3. renderResetPassword — set new password (setelah klik link di email)

import { signIn, signUp, requestPasswordReset, updatePasswordWithRecoveryToken, getPasswordStrength, validatePassword } from '../auth.js';

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

  // Cek apakah ada recovery token di URL
  // Supabase redirect URL format: /#/reset-password?type=recovery&access_token=...&refresh_token=...
  // Karena supabase.js pakai detectSessionInUrl=false, kita handle manual.
  const url = new URL(window.location.href);
  const params = new URLSearchParams(url.search);
  const hashParams = new URLSearchParams(window.location.hash.replace(/^#\/?[^?]*\??/, ''));
  const type = params.get('type') || hashParams.get('type');
  const accessToken = params.get('access_token') || hashParams.get('access_token');

  if (type === 'recovery' && accessToken) {
    // Supabase biasanya set session otomatis dari URL. Kalau tidak, tampilkan error.
    // Karena detectSessionInUrl=false di config kita, kita pakai cara manual:
    // supabase.auth.setSession({ access_token, refresh_token }) — butuh refresh_token juga.
    // Lebih simpel: pakai detectSessionInUrl=true untuk URL ini saja.
    // Atau: biarkan Supabase handle di next reload dengan detectSessionInUrl=true.
    // Solusi paling clean: set session manual.
    import('../supabase.js').then(async ({ supabase }) => {
      const refreshToken = params.get('refresh_token') || hashParams.get('refresh_token');
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
