# RUNBOOK — Workflow Multi-Akun chat.z.ai (RecallFox PWA)

> SOP MASTER. Buka file ini kalau bingung. **Tidak perlu hafal apa pun** —
> semua langkah dan prompt sudah tertulis di sini.
>
> Kunci: **file git = otak proyek, akun chat.z.ai = tangan pekerja.**

---

## Status Proyek
- RecallFox PWA SUDAH berjalan (v1.11.x). Proyek diadopsi via **Fase 0 — Onboarding**.
- Mode: **LENGKAP** (lihat `AGENTS.md`). Tech stack terpasang di `findings.md`, backlog di `task_plan.md`.

---

## Setup Satu Kali (token tersimpan)

1. Simpan token git ke `sesi/.token` (sekali saja, git-ignored — tidak pernah ke commit):
   ```bash
   echo "<fine-grained-token>" > sesi/.token
   ```
2. Setelah ini **tidak pernah** menempel token lagi — `/sesi` memuatnya otomatis ke prompt.

---

## Alur Harian (2 perintah + 2 salin-tempel)

Tiap sesi akun hanya 4 langkah:

```
/sesi          → opencode pilih akun layak + tulis prompt (dengan token) ke sesi/prompt-berikutnya.txt
[salin file]   → tempel di Firefox kontainer akun-X → GLM bekerja → jawaban
/selesai       → tempel jawaban → opencode otomatis: git pull, simpan hasil, update tracker, commit
```

- Anda tidak pernah menyentuh `sesi/tracker.md`, mengingat akun mana, atau mengetik git.
- `/sesi` memilih akun (kueri < 4, tidak diblokir) dan task `[ ]` berikutnya.
- `/selesai` menaikkan kueri akun, menandai blokir bila 4/4, dan commit.
- Ulangi sampai semua task `[x]`.

---

## Fase 0 — ONBOARDING (selesai)

Proyek sudah punya kode sebelum memakai workflow. Langkah yang SUDAH dilakukan:
1. Audit struktur & versi (`package.json`, changelog).
2. Backfill `findings.md` (tech stack terpasang) + `task_plan.md` (backlog) + `progress.md`.
3. `AGENTS.md` ditandai "proyek sudah berjalan".
4. Brainstorm dilewati (arah ada di `README.md` + changelog).

---

## Fase 2 — PLANNING (bila perlu task baru besar)

```
Baca AGENTS.md dan findings.md di repo ini.
1. git pull
2. Susun/update task_plan.md (task [ ] urut dari paling penting)
3. Update findings.md jika ada perubahan tech stack
4. Update progress.md
5. Commit + push dengan format "planning: <deskripsi>"
```

**Gerbang — Review Planning**: Anda baca `task_plan.md` + `findings.md` → perbaiki → commit.

---

## Fase 3 — BUILD (chat.z.ai)

**Prompt per sesi akun** (tempel ke akun yang tidak diblokir):

```
Baca AGENTS.md dan progress.md di repo ini.
1. git pull
2. Cari task [ ] pertama di task_plan.md (LEWATI yang [doing:...])
3. Klaim: ubah [ ] jadi [doing:akunX] (X = nomor akunmu), commit + push
4. Kerjakan task itu satu-satunya. IKUTI gaya yang ada: Vanilla JS + Vite,
   Supabase (@supabase/supabase-js), IndexedDB (idb).
5. Update task_plan → [x], catat di progress.md (dengan commit ref) + workers/akunX.md
6. Commit + push dengan format "build: <deskripsi> (akunX)" atau "fix: <deskripsi> (akunX)"
```

Ulangi sampai semua task `[x]`.

**Gerbang MVP & RC (Lengkap)**: `git pull` → `npm run build` → uji di browser/HP
(ego-lite) → temuan tulis task `[ ]` → kirim ke akun → verifikasi ulang. Tag `mvp-v1`, lalu `rc-v1`.

---

## Fase 4 — PRODUKSI

1. Deploy ke Vercel (`npm run build`, jangan commit `.env`).
2. Verifikasi live → tag `v1.0.0`.
3. Bug setelah produksi → tulis task `[ ] bug:prodvX` → akun perbaiki → deploy → tag `v1.0.X`.

---

## Situasi yang Sering Terjadi

| Situasi | Yang dilakukan |
|---|---|
| Push ditolak (konflik) | `git pull --rebase`, lalu push ulang. JANGAN force push |
| Ada task `[doing:akunY]` | LEWATI, pilih task `[ ]` lain |
| Task `[doing:]` sudah lama (>1 hari) | Boleh ambil alih setelah catat di workers/ |
| Konflik di file otak (markdown) | Jangan paksa resolve — tandai + beri tahu manusia |
| Akun kena blokir 6 jam | Gunakan akun lain yang tersisa kuerinya |
| Agent tidak selesai dalam 1 sesi | Minta commit progres parsial dulu |
| Tidak tahu harus pakai akun mana | Jalankan `/sesi` di opencode |
| Perlu test build | `npm run build` + `npm run preview` — jangan hanya andalkan kode |

---

## Keamanan Token Git

- Token disimpan di `sesi/.token` (git-ignored) — **tidak pernah ter-commit**.
- Token disisipkan otomatis ke prompt oleh `/sesi`, dan `sesi/prompt-berikutnya.txt` juga git-ignored.
- Gunakan fine-grained token: recallfox (Firefox+Chrome+PWA), `Contents: Read and write`, expiry pendek.
- Setiap token bocor = hanya repo recallfox yang kena, bukan seluruh akun.
