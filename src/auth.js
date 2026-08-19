// src/auth.js — Auth helpers (email/password) + password reset & change
// v1.11.4: Tambah resetPassword (forgot flow) dan changePassword (logged-in flow)
//
// Standar industri yang diterapkan:
// - Reset password: email-based dengan token (Supabase default)
//   - User request reset → Supabase kirim email berisi link dengan token
//   - Link redirect ke /reset-password?type=recovery&token=...
//   - PWA catch URL, tampilkan form new password
//   - Token expired setelah 1 jam (default Supabase)
//   - Rate limit: max 5 request per jam per email (Supabase default)
// - Change password (logged-in): verify current password dulu sebelum update
//   - Step 1: signInWithPassword(email, currentPassword) untuk verifikasi
//   - Step 2: updateUser({ password: newPassword }) untuk update
//   - Jika step 1 gagal, jangan update (prevent unauthorized change)
// - Password strength validation (client-side):
//   - Min 8 karakter
//   - Harus mengandung huruf + angka
//   - Tidak boleh sama dengan email

import { supabase } from './supabase.js';

export async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return { ok: false, error: error.message };
  return { ok: true, user: data.user, session: data.session };
}

export async function signUp(email, password) {
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) return { ok: false, error: error.message };
  return { ok: true, user: data.user, session: data.session };
}

export async function signOut() {
  await supabase.auth.signOut();
}

export async function getSession() {
  const { data } = await supabase.auth.getSession();
  return data.session;
}

export async function getCurrentUser() {
  const { data } = await supabase.auth.getUser();
  return data.user;
}

// ===========================================================================
// v1.11.8: OAuth callback handler (Google login)
// ===========================================================================
// Karena detectSessionInUrl=false di supabase.js, token dari redirect OAuth
// (contoh: https://host/#access_token=...&refresh_token=...) TIDAK diproses
// otomatis oleh supabase-js. Helper ini mengambil token dari URL (query +
// hash fragment), set session manual, lalu bersihkan URL supaya token tidak
// nyangkut di history. Pola sama dengan setSession di reset-password flow.

export async function handleOAuthCallback() {
  const href = window.location.href;
  const getParam = (name) => {
    const re = new RegExp('[#?&]' + name + '=([^&#]*)');
    const m = href.match(re);
    return m ? decodeURIComponent(m[1]) : null;
  };

  // Jangan diproses di flow recovery (reset password) — itu ditangani sendiri
  // oleh renderResetPassword. OAuth callback tidak punya type=recovery.
  const type = getParam('type');
  const accessToken = getParam('access_token');
  const refreshToken = getParam('refresh_token');

  if (type === 'recovery') return false;
  if (!accessToken || !refreshToken) return false;

  const { data, error } = await supabase.auth.setSession({
    access_token: accessToken,
    refresh_token: refreshToken
  });
  if (error || !data.session) {
    return false;
  }

  // Bersihkan URL — hapus semua token dari hash/query (tetap pertahankan hash
  // route kalau ada, mis. #/reset-password dipakai di recovery flow)
  const hashRoute = (window.location.hash.match(/^#\/[^\s#]*/) || [''])[0];
  const cleanUrl = window.location.origin + window.location.pathname + (hashRoute || '');
  window.history.replaceState({}, document.title, cleanUrl);

  return true;
}

export function onAuthChange(callback) {
  const { data } = supabase.auth.onAuthStateChange((_event, session) => {
    callback(session?.user || null, session);
  });
  return () => data.subscription.unsubscribe();
}

// ===========================================================================
// v1.11.4: Password reset (forgot password flow)
// ===========================================================================

/**
 * Request password reset email.
 * Supabase akan kirim email ke user berisi link dengan recovery token.
 * Link akan redirect ke `redirectTo` dengan query params `type=recovery`.
 *
 * @param {string} email - Email user yang lupa password
 * @param {string} redirectTo - URL lengkap untuk halaman reset password (default: /#/reset-password)
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function requestPasswordReset(email, redirectTo) {
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, error: 'Format email tidak valid' };
  }
  // Default redirect: same origin + /#/reset-password (hash route)
  if (!redirectTo) {
    redirectTo = window.location.origin + window.location.pathname + '#/reset-password';
  }
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: redirectTo
  });
  if (error) {
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

/**
 * Update password menggunakan recovery token dari URL.
 * Dipanggil di halaman reset-password setelah user klik link di email.
 * Supabase akan otomatis pakai session dari token URL (detectSessionInUrl=false
 * jadi kita handle manual).
 *
 * @param {string} newPassword - Password baru
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function updatePasswordWithRecoveryToken(newPassword) {
  const validation = validatePassword(newPassword);
  if (!validation.ok) return validation;

  // updateUser akan otomatis pakai session yang sudah ter-set dari recovery token
  // (Supabase set session saat URL mengandung type=recovery)
  const { data, error } = await supabase.auth.updateUser({
    password: newPassword
  });
  if (error) {
    return { ok: false, error: error.message };
  }
  return { ok: true, user: data.user };
}

// ===========================================================================
// v1.11.4: Change password (logged-in flow)
// ===========================================================================

/**
 * Change password untuk user yang sudah login.
 * Verifikasi currentPassword dulu sebelum update (standar industri).
 *
 * @param {string} currentPassword - Password saat ini (untuk verifikasi)
 * @param {string} newPassword - Password baru
 * @param {string} email - Email user (untuk re-signIn verification)
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function changePassword(currentPassword, newPassword, email) {
  // Step 1: Validate new password strength
  const validation = validatePassword(newPassword);
  if (!validation.ok) return validation;

  // Step 2: Check new password != current password
  if (currentPassword === newPassword) {
    return { ok: false, error: 'Password baru tidak boleh sama dengan password lama' };
  }

  // Step 3: Verify current password by re-signing in
  // (prevent unauthorized change jika session di-share device)
  const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
    email: email,
    password: currentPassword
  });
  if (signInError) {
    return { ok: false, error: 'Password lama salah: ' + signInError.message };
  }

  // Step 4: Update password
  const { data, error } = await supabase.auth.updateUser({
    password: newPassword
  });
  if (error) {
    return { ok: false, error: error.message };
  }
  return { ok: true, user: data.user };
}

// ===========================================================================
// Password strength validation
// ===========================================================================

/**
 * Validate password strength (client-side).
 * Aturan standar industri:
 * - Min 8 karakter
 * - Harus mengandung huruf + angka
 * - Tidak boleh sama dengan email (kalau email diketahui)
 *
 * @param {string} password - Password to validate
 * @param {string} [email] - Email user (opsional, untuk check similarity)
 * @returns {{ok: boolean, error?: string}}
 */
export function validatePassword(password, email) {
  if (!password || typeof password !== 'string') {
    return { ok: false, error: 'Password wajib diisi' };
  }
  if (password.length < 8) {
    return { ok: false, error: 'Password minimal 8 karakter' };
  }
  if (password.length > 128) {
    return { ok: false, error: 'Password maksimal 128 karakter' };
  }
  if (!/[a-zA-Z]/.test(password)) {
    return { ok: false, error: 'Password harus mengandung huruf' };
  }
  if (!/[0-9]/.test(password)) {
    return { ok: false, error: 'Password harus mengandung angka' };
  }
  if (email && password.toLowerCase() === email.toLowerCase()) {
    return { ok: false, error: 'Password tidak boleh sama dengan email' };
  }
  if (email && password.toLowerCase() === email.toLowerCase().split('@')[0]) {
    return { ok: false, error: 'Password tidak boleh sama dengan username email' };
  }
  return { ok: true };
}

/**
 * Get password strength score (0-4) untuk UI meter.
 * 0 = very weak, 4 = very strong
 * Pakai zxcvbn-style heuristics (sederhana, tanpa dependency).
 */
export function getPasswordStrength(password) {
  if (!password) return { score: 0, label: 'Kosong', color: '#9ca3af' };
  let score = 0;
  if (password.length >= 8) score++;
  if (password.length >= 12) score++;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score++;
  if (/[0-9]/.test(password)) score++;
  if (/[^a-zA-Z0-9]/.test(password)) score++;
  // Cap at 4
  score = Math.min(4, score);
  const labels = ['Sangat lemah', 'Lemah', 'Cukup', 'Kuat', 'Sangat kuat'];
  const colors = ['#dc2626', '#ea580c', '#ca8a04', '#16a34a', '#15803d'];
  return { score, label: labels[score], color: colors[score] };
}
