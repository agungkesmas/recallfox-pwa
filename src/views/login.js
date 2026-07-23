// src/views/login.js — Login view

import { signIn, signUp } from '../auth.js';

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
}
