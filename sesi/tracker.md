# Tracker 8 Akun chat.z.ai

> Perbarui file ini SETELAH setiap sesi selesai (1 menit). Ini yang dibaca
> perintah `/sesi` untuk menyarankan akun mana yang dipakai.

## Aturan Pemakaian
- Setiap akun: maksimal **4 kueri per hari**, lalu **blokir ±6 jam**.
- Akun layak dipakai jika: `kueri < 4` DAN `blokir sampai` < sekarang.

## Status Hari Ini: _(tulis tanggal)_

| Akun | Kueri terpakai | Blokir sampai | Sesi terakhir | Keterangan |
|---|---|---|---|---|
| 1 | 0/4 | - | - | - |
| 2 | 0/4 | - | - | - |
| 3 | 0/4 | - | - | - |
| 4 | 0/4 | - | - | - |
| 5 | 0/4 | - | - | - |
| 6 | 0/4 | - | - | - |
| 7 | 0/4 | - | - | - |
| 8 | 0/4 | - | - | - |

## Cara Update Setelah Sesi
1. Tambah `kueri terpakai` akun yang baru dipakai.
2. Jika mencapai 4 → isi `blokir sampai` = sekarang + 6 jam.
3. Catat ringkasan sesi di kolom `Sesi terakhir`.
4. Commit:
   ```bash
   git add sesi/tracker.md && git commit -m "sesi: update tracker akun" && git push
   ```
