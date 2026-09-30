# RecallFox PWA v1.25.0 — Kamera Dokumen Ala CamScanner + Mode Panorama

Tanggal: 2026-09-30

## Ringkasan

Rombak total fitur foto dokumen PWA agar perilaku, UI, dan hasilnya mengikuti
CamScanner (dipelajari dulu: perilaku viewfinder, UI bertahap, filter hasil),
plus fitur baru **mode Panorama** untuk foto lebar di vault. Laporan user yang
menjadi latar: "sangat jelek hasilnya, banyak elemen yang hilang / tidak jelas,
fotonya payah sekali dalam membuat foto yang memiliki teks yang mudah dibaca."

## MASALAH LAMA (kenapa hasil jelek)

1. "Scan Dokumen" & "Ambil Foto" hanya membuka **kamera bawaan HP** via
   `<input type=file capture>` — tanpa live view, tanpa deteksi tepi, tanpa
   kontrol. Hasil jepretan bebas (miring, bayangan, gelap).
2. Filter lama destruktif:
   - B&W: adaptive threshold **window tetap 15px** — pada foto 3000px, mean
     lokal dihitung dari area yang jauh lebih kecil dari tebal teks → stroke
     hilang / patah-patah (inilah "banyak elemen yang hilang").
   - Magic: normalisasi lalu dipaksa grayscale — **warna asli hilang**.
   - Enhance: CLAHE dulu agresif (v1.6.3 dihapus), bg-normalisasi statis.
3. Berantai re-encode JPEG (filter → crop → warp masing-masing re-encode q0.92)
   → generational blur.
4. Auto-detect butuh **OpenCV.js 8MB** download pertama — sering gagal/putus,
   deteksi tidak pernah jalan → crop manual tanpa bantuan.

## SOLUSI: KAMERA LIVE ALA CAMSCANNER (src/camscanner.js + src/cam-ops.js)

Alur baru persis CamScanner, TANPA OpenCV (semua algoritma ditulis sendiri,
murni JS, 0 dependency baru):

1. **Viewfinder live** full-screen: video kamera (ideal 2560×1440), polygon
   tepi dokumen terdeteksi **realtime** (hijau menyala) tiap 380ms pada frame
   260px — Sobel + threshold adaptif + kandidat border per baris/kolom +
   RANSAC line-fit 4 sisi + interseksi + validasi (convex, area, sisi).
2. **AUTO-CAPTURE ala CamScanner**: tepi stabil ±1,2 detik + confidence ≥ 0.5 →
   jepret sendiri (flash + getar). Toggle ⚡ Auto/Manual (persist
   localStorage `rf-cam-auto`), default ON.
3. **Crop 4 sudut + loupe**: layar sesuaikan dgn quad awal dari deteksi
   presisi 640px, 4 titik besar draggable, **kaca pembesar 3×** saat menggeser,
   dim luar polygon, deteksi ulang 🎯, ulangi ↺, lanjut ✓.
4. **Koreksi perspektif otomatis**: homography DLT 8-param (eliminasi Gauss) +
   sampling bilinear invers, output di-cap 3200px sisi panjang, edge-extend
   (tanpa tepi hitam).
5. **Filter layar "Perbagus hasil"** (preview instan di 1100px, full-res hanya
   sekali saat simpan — q0.92 JPEG SATU re-encode):
   - **Enhance** (default — langsung terbaca): bg-division adaptif (target =
     clamp(median bg terang × 0.96, 215..240)) + **gamma auto satu arah**
     (hanya mencerahkan foto gelap, tidak pernah menggelapkan kertas) +
     saturasi 1.06 + unsharp 0.55.
   - **Magic**: bg-division per-kanal ×225 → kertas putih cerah, **warna asli
     dipertahankan** (uji: tinta merah tetap dominan merah) + saturasi 1.22 +
     S-curve 1.08 + unsharp 0.5.
   - **Asli**, **Gray** (percentile stretch 1–99%), **B&W**: adaptive threshold
     box-blur dengan **window proporsional = max(21, min(w,h)/20)** + soft ramp
     24 level + C=10 → stroke TIDAK hilang, anti-alias terjaga.
   - Slider **Kecerahan** & **Kontras** (LUT, -100..100).
6. **Multi-halaman**: selesai satu halaman → balik ke viewfinder (kamera tetap
   hidup), chip "📄 N halaman", maks 10; "💾 Selesai" → sheet judul + catatan +
   thumbnail → simpan N halaman (createDocumentItemMultiPage, path lama).
7. **Mode Panorama** (baru, tombol FAB "🌐 Foto Panorama" + tab di kamera):
   jepret frame pertama → **pita alignment** (strip kanan 25% akumulasi
   ditampilkan transparan di kanan viewfinder) → geser kanan → jepret lagi →
   **stitch otomatis** via SAD template match (skala 240px, coarse+fine, koreksi
   dy, score < 22) + feather blend 36px di seam; tinggi kerja 1080p, lebar
   maks 10000px; hasil → alur simpan foto biasa (anotasi + GPS + vault).
8. **Lainnya**: torch ⚡ (bila didukung), ganti kamera depan/belakang, impor
   dari galeri (langsung masuk tahap sesuai mode), tab mode dalam kamera
   (Dokumen/Foto/Panorama), "Ambil Foto" biasa kini langsung dari kamera live.
9. **Fallback aman**: getUserMedia gagal (izin ditolak / tanpa kamera / konteks
   tidak aman) → toast jujur + alur lama (pickImage → editor v14). `opts.legacy`
   tersedia sbg jalan darurat.

## FIX BONUS — BUG LAMA DI edge-detect.js (dipakai editor fallback)

`orderPoints()` menukar sudut **TR ↔ BL** (diff y−x min itu TR, bukan BL) →
quad bowtie → `warpPerspective` menghasilkan gambar terbalik/salah saat
auto-detect dijalankan di editor lama. Diperbaiki (paritas dgn orderQuad baru).

## FILE

- `src/cam-ops.js` BARU — pure ops tanpa DOM (Node-testable): makeGray,
  boxBlurGray, sobelMag, resizeImg, detectQuad (RANSAC), defaultQuad,
  solveHomography, warpQuad, filterEnhance/Magic/Gray/BW, applyAdjust,
  matchPanorama.
- `src/camscanner.js` BARU — UI kamera full-screen (state: viewfinder →
  adjust → enhance → meta; pano: guided capture + stitch).
- `src/views/media.js` — startCaptureFlow & startDocumentFlow kini kamera-live
  dulu dgn fallback; GPS live paralel; saveDocumentPages diekstrak bersama.
- `src/main.js` — FAB menu tambah "🌐 Foto Panorama".
- `src/edge-detect.js` — fix orderPoints TR/BL (bug lama).
- `src/styles/views.css` — blok CSS `.cs-*` (±200 baris).
- `scripts/test_camscanner.mjs` BARU — 33 uji unit (semua PASS): deteksi quad
  pada foto sintetis (error sudut 0.7px), homography identity/translate, warp
  penuh kertas 99.3%, filter (teks 100% selamat, kertas ≥200, B&W tepat,
  warna magic dipertahankan), panorama match (overlap & dy tepat, junk → null).

## VALIDASI

- `node --check`: cam-ops.js, camscanner.js, media.js, main.js, edge-detect.js — OK.
- `node scripts/test_camscanner.mjs`: **33/33 PASS**.
- Regresi: test_rekon_desktop.mjs **43/43 PASS**; test_rekon_e2e.mjs **24/24
  PASS, 0 pageerror**.
- `npm run build` (vite) sukses — bundle 541KB, precache 18 entries.

## VALIDASI TAMBAHAN (E2E)

- `scripts/test_camscanner_e2e.mjs` BARU — smoke test Playwright Chromium dgn
  **kamera virtual** (`--use-fake-device-for-media-stream`) + seeded session:
  **18/18 PASS** — sheet punya Scan Dokumen & Foto Panorama, kamera live terbuka,
  video hidup (readyState≥2), 3 tab mode, auto-jepret ON, hint benar,
  shutter/galeri/ganti kamera ada, pindah mode Panorama benar (pill auto
  disembunyikan), tutup bersih, 0 pageerror kritis. Bukti visual:
  download/camscanner-viewfinder.png & camscanner-panorama.png.
