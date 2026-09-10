# v1.21.0 — Opsi Ketiga: Upload MANUAL (3 hari vault)

Tanggal: 2026-09-11

## Permintaan
Sheet upload dapat opsi ketiga selain Database & litterbox-otomatis: upload
manual ke daftar situs temporari (klik → tab baru), lalu simpan URL manual ke
vault. Vault manual hilang otomatis **3 hari** walau situsnya belum hapus.

## Desain (dikunci sebelum kode — pelajaran v1.20.3 yang di-revert)
- `tempHost='manual'`, `tempDuration='72h'`, `tempExpiresAt=now+72h` — struktur
  row IDENTIK dengan temp litterbox, jadi `cleanupExpiredTempItems`, badge
  countdown, dan sinkron antar device jalan tanpa perubahan sisi baca.
- Batas ukuran TIDAK diubah (tetap 1GB temp) — v1.20.3 yang mengubah limit
  ikut di-revert; perubahan perilaku minimal = risiko minimal.
- Pola defensif baru (anti "tombol mati diam-diam"): semua referensi elemen
  diambil SEKALI + guard `reqEl` (gagal eksplisit via toast, bukan diam),
  listener dipasang sekali (dulu ada yang di dalam repaint), daftar situs
  dirender sekali, state tombol Simpan terpusat di `updateSaveState()`.
- Perangkap error global (`error` + `unhandledrejection` → toast) supaya
  kegagalan runtime berikutnya langsung kelihatan + tercatat di console.

## Perubahan
- `src/lib/temp-upload.js`: `TEMP_HOST_MANUAL`, `MANUAL_TEMP_DURATION`,
  `MANUAL_SITES` (4 situs terverifikasi curl: litterbox, catbox, gofile, tmpfiles).
- `src/main.js`: tombol ketiga + panel manual + cabang simpan manual (dicek
  DULU, tanpa butuh file terpilih) + error trap.
- `src/sync.js`: `createFileItem` cabang `destination:'manual'` (tanpa upload,
  validasi `https://` + wajib `tempExpiresAt`).

## Validasi (BEDA dari v1.20.3 — bukti browser asli, bukan cuma build)
- `node --check` 3 file OK; `vite build` OK; unit temp-upload 8/8 mock OK
  (1 live FAIL = litterbox 403 ke IP mesin ini, terbukti lingkungan via curl
  + gagal identik di kode lama).
- **E2E Playwright + Chrome asli vs build dist**: 7/7 PASS, 0 JS error —
  login user uji, buka sheet, toggle db/temp/manual (panel show/hide benar),
  validasi manual (disabled→enabled), simpan manual, item muncul di vault.
- Verifikasi DB: `tempHost=manual`, URL benar, TTL tepat 72.0 jam.
- Cleanup: baris uji + user uji dihapus (litterbox 403 juga membuktikan
  kenapa opsi Manual dibutuhkan).
