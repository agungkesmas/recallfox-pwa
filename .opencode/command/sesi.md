---
description: Siapkan sesi berikutnya workflow multi-akun chat.z.ai — pilih akun, tulis prompt siap salin ke sesi/prompt-berikutnya.txt (token otomatis termuat).
---

Siapkan sesi berikutnya untuk workflow multi-akun chat.z.ai. Anda TIDAK mengubah file otak (task_plan/findings/progress), hanya membaca dan menulis `sesi/prompt-berikutnya.txt`.

## Langkah
1. Baca `AGENTS.md` (tahu mode & aturan), `RUNBOOK.md`, `sesi/tracker.md`, `progress.md`, dan `task_plan.md`.
2. Tentukan **fase**: Brainstorm (brainstorm.md kosong), Planning (task_plan/findings belum lengkap), atau Build.
3. Pilih **akun layak**: dari `sesi/tracker.md`, akun dengan `kueri < 4` dan `blokir sampai` sudah lewat; pilih yang kuerinya paling sedikit.
4. Tentukan **task berikutnya**: task `[ ]` pertama, lewati `[doing:...]`.
5. Baca token dari `sesi/.token`. Jika file tidak ada → minta user menyimpan token dulu ke `sesi/.token` (sekali saja), lalu jalankan ulang.
6. Susun prompt lengkap sesuai fase (ambil dari `RUNBOOK.md`), tambahkan baris `[token: <isi sesi/.token>]`.
7. Tulis ke `sesi/prompt-berikutnya.txt` dengan format:

```
Gunakan akun-<N> (kueri x/4). Tempel prompt ini ke chat.z.ai:

---
<prompt sesuai fase, sudah lengkap dengan token>
---
```

## Aturan
- JANGAN commit `sesi/prompt-berikutnya.txt` (sudah di .gitignore).
- JANGAN menulis/mengubah task_plan, findings, progress, tracker — itu urusan `/selesai`.
- Setelah menulis file, cetak ringkas: akun mana, fase, dan "Prompt siap di sesi/prompt-berikutnya.txt".
