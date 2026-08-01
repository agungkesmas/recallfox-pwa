# AGENTS.md — Instruksi untuk Semua Agent (chat.z.ai)

> File ini dibaca oleh SEMUA sesi akun. Kerjakan satu langkah per sesi,
> baca file yang relevan dulu, jangan mulai dari nol.

## Proyek
- **RecallFox PWA** — companion mobile/web untuk RecallFox: sync cross-device
  media, notes, vault via Supabase. Vanilla JS + Vite, PWA (service worker).
- Versi berjalan: v1.11.x (lihat `package.json` + changelog).
- **MODE: Lengkap** ← proyek sudah berjalan, butuh traceability.

## Status Proyek (penting!)
- Proyek SUDAH JALAN (bukan dari nol). Kode lengkap di repo ini.
- Tech: Vanilla JS + Vite + `vite-plugin-pwa`; Supabase (`@supabase/supabase-js`), IndexedDB (`idb`).
- Baseline stabil: v1.11.x. Changelog historis di `CHANGELOG-v*.md`.

## Alur Fase
- **Fase 1 — Brainstorm**: sudah selesai, proyek berjalan. Lewati.
- **Fase 2 — Planning**: baca `findings.md` (tech stack terpasang) + `task_plan.md`.
- **Fase 3 — Build**: baca `task_plan.md` → kerjakan task `[ ]` → update `progress.md`.

## Cara Kerja (WAJIB semua mode)
1. Mulai dengan `git pull` (selalu tarik dulu).
2. Baca `AGENTS.md` + file yang relevan. JANGAN baca seluruh repo — hanya file yang dibutuhkan.
3. KERJAKAN HANYA SATU LANGKAH per sesi.
4. Klaim task: ubah `[ ]` → `[doing:akunX]` (X = nomor akun Anda), lalu commit + push `claim: <task> (akunX)`.
5. Selesai: ubah `[doing:akunX]` → `[x]`, catat di `progress.md` **dengan commit ref** (mis. `done: fix login (akun4) 3fa9b2c`) + `workers/akunX.md`, lalu commit + push `done: <task> (akunX)`.
6. Push ditolak (konflik): `git pull --rebase`, lalu push ulang. JANGAN `git push --force`.
7. Task `[doing:akunY]`: LEWATI, pilih `[ ]` lain. Kecuali sudah lama (>1 hari) → boleh ambil alih setelah catat di `workers/akunX.md`.
8. Konflik di file otak (task_plan/findings/progress): JANGAN paksa resolve — tandai + beri tahu manusia.
9. Hemat kueri: pilihan kecil yang ambigu → PUTUSKAN SENDIRI + catat alasan singkat. Jangan tanya balik. Task terlalu besar untuk 1 sesi → pecah sendiri jadi sub-task `[ ]`.
10. Satu sesi = satu task. Tidak selesai? Tetap commit progres parsial.

## MODE LENGKAP (berlaku — proyek besar / traceability)
- Keputusan arsitektur penting → tulis ke `decisions.md` (siapa, kapan, keputusan, alasan, alternatif yang ditolak).
- Sebelum menulis kode: baca `findings.md` + struktur repo + file yang ada, lalu IKUTI gaya yang ada.
- Jangan ubah versi dependensi (vite, supabase-js, idb) sembarangan — verifikasi dulu; commit `package-lock.json`.
- `progress.md` diisi dengan bukti: ref commit + apa yang diubah + hasil cek jalan.
- Gerbang manusia: Review Planning → Review MVP → Review Produksi. Agent berhenti menunggu konfirmasi di tiap gerbang.
- Milestone: tag `planning-v1`, `mvp-v1`, `rc-v1`, `v1.0.0` (dibuat manusia).

## Batasan (semua mode)
- Tidak menulis kode sebelum planning selesai (`task_plan.md` + `findings.md` ada).
- Commit message diawali tag fase: `planning:` / `build:` / `fix:`.
- Satu sesi = satu task. Jangan tanya balik — putuskan + catat.
