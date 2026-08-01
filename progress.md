# Progress (RecallFox PWA)

> Log progres berjalan. Setiap task selesai → tambah baris: tanggal, task, akun, commit ref.
> Proyek sudah berjalan — riwayat lama ada di `CHANGELOG-v*.md`.

## Catatan onboarding (manual)
- 2026-08-01 — Proyek recallfox-pwa diadopsi ke workflow multi-akun.
  Tech stack & backlog dicatat di `findings.md` + `task_plan.md`. Kode sudah ada di repo.

## Log progres
- 2026-08-01 — `build: fitur forgot-password (akun1)` (commit hash akan diisi setelah push)
  - **Task**: fitur: forgot-password — link "Lupa password" di halaman login + alur set password baru (Supabase Auth reset)
  - **Akun**: akun1
  - **Status**: Fitur SUDAH ADA sejak v1.11.4 (commit `19ec5fa v1.11.4: Reset password + change password (standar industri)`). Task di task_plan.md dibuat setelahnya (commit `37d8e71 planning`), jadi task ini bersifat **verify + parity check**, BUKAN implementasi dari nol.
  - **Verifikasi (sudah jalan)**:
    - `src/auth.js`: `requestPasswordReset(email, redirectTo)` (line 68) → call `supabase.auth.resetPasswordForEmail(email, { redirectTo })`. Default redirectTo: `window.location.origin + window.location.pathname + '#/reset-password'`.
    - `src/auth.js`: `updatePasswordWithRecoveryToken(newPassword)` (line 94) → call `supabase.auth.updateUser({ password })`. Pakai session yang sudah ter-set dari recovery token.
    - `src/auth.js`: `validatePassword(password)` (line 167) — min 8 karakter, huruf + angka, tidak sama dengan email.
    - `src/auth.js`: `getPasswordStrength(password)` (line 197) — score 0-4 untuk UI meter.
    - `src/views/login.js`: `renderLogin` (line 10) dengan link `<a href="#/forgot-password">Lupa password?</a>` (line 25).
    - `src/views/login.js`: `renderForgotPassword` (line 68) — form input email + tombol "Kirim Link Reset" + info catatan (rate limit, expiry, dll).
    - `src/views/login.js`: `renderResetPassword` (line 125) — handle URL `#/reset-password?type=recovery&access_token=...&refresh_token=...`, set session manual via `supabase.auth.setSession()`, lalu render form "Password Baru" + "Konfirmasi" + strength meter + toggle show/hide. Sukses → signOut + redirect ke `#/login`.
    - `src/main.js`: hash routing (line 64-80) untuk `#/forgot-password` + `#/reset-password`.
  - **Parity dengan Firefox + Chrome**:
    - Label link "Lupa password?" — sama di 3 repo.
    - Tombol "Kirim Link Reset" — sama di 3 repo.
    - Alur: `resetPasswordForEmail` → email reset → klik link → `updateUser({ password })` — sama di 3 repo.
    - **Perbedaan UI**: PWA pakai dedicated page (hash route `#/forgot-password` + `#/reset-password`), Firefox/Chrome pakai inline form di popup/sidebar (karena extension tidak punya multi-page routing).
    - **Redirect URL**: PWA default redirectTo = `https://recallfox-pwa.vercel.app/#/reset-password`. Firefox/Chrome hardcoded `https://recallfox-pwa.vercel.app/set-password` (TANPA hash `#`). → **PARITY BUG** di Firefox + Chrome — perlu fix redirectTo ke `https://recallfox-pwa.vercel.app/#/reset-password` supaya Supabase kirim email dengan link yang match PWA route.
  - **Cek jalan**: code sudah lulus review (dari commit v1.11.4). Belum test end-to-end di sesi ini karena fitur sudah ada. Test end-to-end butuh SMTP Supabase + klik link email manual.
