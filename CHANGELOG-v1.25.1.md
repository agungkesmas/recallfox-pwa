# v1.25.1 — Perbaikan Total Mode Panorama + Pertahanan Scan Gelap

## Laporan user yang diperbaiki

> "hasilnya gagal total fitur panorama ga bisa memotret gambar panjang, tapi satu saja. terus juga fitur scan dokumennya malah gelap gulita"

## 🌐 PANORAMA — dirombak total: SWEEP KONTINYU ala kamera native

**Alur lama (v1.25.0, gagal):** jepret → geser → jepret → geser… tiap jepret
harus cocok sendiri; kalau gagal muncul error "Tidak sambung" berulang; user
menyerah dan hanya dapat 1 foto.

**Alur baru (ala panorama kamera HP):**
- Tekan jepret **SEKALI** → kamera langsung MEREKAM (frame otomatis tiap 450 ms)
- Geser HP **KANAN perlahan** → tiap frame tersambung otomatis secara live
  (hint menunjukkan lebar yang sudah tersambung, mis. "🌐 3151px tersambung")
- Tekan lagi (tombol jepret berubah jadi kotak merah ■ STOP) atau 💾 Selesai →
  panorama tersusun & masuk alur simpan foto biasa (anotasi + GPS)
- Frame yang gagal disambung DI-DIAMKAN (skip + hint "geser lebih LAMBAT") —
  tidak ada lagi spam error; sweep tetap jalan
- Pita bayangan alignment di kanan layar untuk menyamakan posisi
- Batas lebar 10000px tercapai → otomatis berhenti & selesai sendiri

**Akar masalah teknis yang dibuktikan uji (3 bug matcher):**
1. **SAD mentah tak kebal exposure** — auto-exposure HP menggeser gain/offset
   antar frame; uji: shift +8% saja → match GAGAL (null). Solusi: **ZSAD**
   (zero-mean SAD) — gain+offset invarian; uji: +35% tetap cocok tepat.
2. **Template membesar terus** — lebar template = 25% × lebar akumulasi; begitu
   panorama melebar, template melampaui lebar frame baru → match mati PERMANEN
   (null selamanya). Solusi: template di-cap `min(25% prev, 45% next, 150px)`.
3. **Rentang cari terlalu sempit** — hanya sampai 70% lebar frame; posisi benar
   (overlap < 30%) tak terjangkau malah terpilih posisi SALAH (score 19.5 =
   noise floor). Solusi: rentang sampai 88% + guard tekstur polos (std < 14 →
   null, dinding kosong tak bisa dicocokkan) + refine ±3px.

## 🌑 SCAN DOKUMEN — pertahanan berlapis anti "gelap gulita"

Filter Enhance terbukti TIDAK menggelapkan (uji: kertas redup 70 → 200, sangat
gelap 35 → 160) — kegelapan datang dari hulu. Ditutup dengan 6 lapis:
1. **Resolusi kamera 1920×1080** (dulu 2560×1440 — memicu mode HDR/berat dengan
   exposure buruk di banyak HP; 1080p lebih terang & cepat)
2. **Auto-exposure dipaksa kontinyu** — `exposureMode`/`whiteBalanceMode`
   continuous via applyConstraints (beberapa HP mulai dengan exposure terkunci)
3. **Guard frame hitam di pengambilan** — mean luma < 8 → tunggu + retry ≤4×,
   lalu fallback `createImageBitmap(video)` (menutup kasus drawImage gelap,
   mis. stream HDR di iOS)
4. **Guard scene gelap di deteksi** — mean < 45 → deteksi tepi = noise bodong,
   dilewati; hint "🌑 Terlalu gelap — tambah cahaya atau ketuk ⚡" + saran torch
   sekali (bila lampu tersedia)
5. **Validasi "kertas lebih terang"** — sebelum auto-jepret & sebelum quad
   dipakai: interior quad harus lebih terang dari sekeliling (≥ rata frame +3
   dan ≥ 50) — mencegah auto-capture pada quad bodong di meja gelap yang
   menghasilkan warp gelap gulita
6. **Warning hasil gelap** — setelah warp, bila mean < 45 → toast peringatan
   sebelum layar filter (user bisa ← balik, perbaiki sudut / cahaya)
Plus: auto-jepret menunggu auto-exposure settle 700 ms setelah kamera hidup.

## Validasi

- `node --check` src/cam-ops.js + src/camscanner.js OK
- Uji unit `test_camscanner.mjs`: **40/40 PASS** — termasuk 7 regresi baru:
  match dgn exposure shift +8%/+35%, pano lebar 1400px vs frame 427px, overlap
  130px tepat, template polos → null; paritas lama (deteksi sudut 0.7px, warp
  99.3%, teks 100% selamat, dsb.) tak berubah
- E2E kamera virtual `test_camscanner_e2e.mjs`: **21/21 PASS** — termasuk uji
  sweep baru: jepret → sweeping (tombol STOP merah), 3 frame tersambung otomatis
  menjadi panorama **4261×1080px**, chip progres, tutup saat sweep bersih,
  0 pageerror kritis
- Regresi: test_rekon_desktop 43/43 PASS · test_rekon_e2e 24/24 PASS
- `vite build` sukses
