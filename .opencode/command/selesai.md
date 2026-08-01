---
description: Tutup sesi yang baru selesai — tempel jawaban agent, lalu simpan ke file otak, update sesi/tracker.md, dan commit otomatis.
---

Tutup sesi chat.z.ai yang baru selesai. `$ARGUMENTS` berisi jawaban agent yang ditempel user.

## Langkah
1. Terima jawaban agent dari `$ARGUMENTS`. Jika kosong, minta user menempel jawaban.
2. Baca `sesi/tracker.md` untuk tahu akun mana yang baru dipakai — cari akun dengan `Sesi terakhir` paling baru / `Kueri terpakai` tertinggi yang belum di-update. Jika ragu, tanya user "sesi ini pakai akun berapa?".
3. Cari tahu fase & task yang baru dikerjakan (dari `task_plan.md` yang sudah di-pull; agent biasanya sudah mengubah file-nya sendiri dan push — jadi jalankan `git pull` dulu untuk melihat hasil agent).
4. Jika agent SUDAH mengupdate `task_plan.md`/`findings.md`/`progress.md` sendiri dan push → cukup sinkronkan: `git pull`, lalu update `sesi/tracker.md` (akun itu +1 kueri).
5. Jika agent belum mengupdate file otak (hanya jawaban di chat) → simpan hasilnya: update `task_plan.md`/`progress.md`/`workers/akunX.md` sesuai jawaban, lalu commit.
6. Update `sesi/tracker.md`:
   - `kueri terpakai` akun itu +1.
   - Jika mencapai 4 → `blokir sampai` = sekarang + 6 jam.
   - Isi `sesi terakhir` (jam) dan `keterangan` singkat.
7. Commit dengan pesan `sesi: <ringkasan> (akun<N>)`. JANGAN commit `sesi/.token` dan `sesi/prompt-berikutnya.txt`.
8. Cetak ringkas: apa yang disimpan, status akun sekarang.

## Aturan
- Selalu `git pull` dulu di langkah 3 — agent yang bekerja biasanya sudah push hasilnya.
- Jangan mengubah file otak yang tidak terkait sesi ini.
- Jika konflik pull → beri tahu user, jangan paksa resolve.
