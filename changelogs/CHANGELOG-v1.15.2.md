# v1.15.2 — Modal Viewer Media: Tombol Unduh di Puncak Modal

## Latar
Permintaan user (paritas dengan addon v3.24.6): di modal screenshot, tombol unduh harus
**di atas, tepat di bawah field rename/judul**, supaya mudah dijangkau saat mau mendownload
— tidak perlu scroll melewati gambar besar.

## Perubahan (`src/views/media.js`, `src/styles/views.css`)
- **Baris unduh baru di puncak modal viewer** (openItemDetail): dua tombol primer
  **⬇️ Simpan JPG** dan **⬇️ Simpan PNG** dalam grid 2 kolom, dipasang sebagai elemen
  pertama `modal-body` — tepat di bawah header (judul + ✏️ rename), sebelum gambar.
  Sebelumnya viewer PWA sama sekali tidak punya tombol unduh (hanya salin ke clipboard).
- **`downloadViewerImage()`**: unduh file ke perangkat dengan nama = judul item
  (dibersihkan dari karakter ilegal, maks 60 char) + ekstensi. Byte asli diunduh apa
  adanya bila format sumber sudah cocok; konversi via canvas (`reencodeDataUrl`,
  JPG q0.92 / PNG lossless) bila beda format.
- Handler membaca `dataUrl` closure → selalu mengunduh gambar yang **sedang tampil**
  (ikut berganti saat pindah item lewat navigator ◀/▶). Tombol otomatis `disabled`
  selagi gambar belum termuat (sinkron di `switchTo()`).
- JPG/PNG yang relevan untuk PWA (gambar tersimpan sebagai gambar); Simpan PDF tetap
  fitur addon. Tombol salin/metadata/catatan/hapus di footer tidak berubah.

## Validasi
- Build `vite build` sukses.
- Uji visual headless (Playwright, viewport ponsel 390×844): modal viewer menampilkan
  baris unduh di puncak body sebelum gambar; klik ⬇️ memicu download `tes-laporan.jpg`
  + toast sukses. (`scripts/pwa_modal_test_1152.js`)
