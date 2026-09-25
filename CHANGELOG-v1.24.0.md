# CHANGELOG v1.24.0 — RESTORASI FITUR REKONSILIASI (PECAH EXCEL PER PENERIMA → ZIP) DI DESKTOP

## Permintaan user
Tab 🧮 **Rekonsiliasi** di Desktop (public/desktop.html) sebelumnya hanya *usulan desain*
(pencocok kwitansi manual). Fitur asli **"pisah file per nama dari Excel menjadi nama
rekening dalam bentuk .zip"** selama ini hanya ada di **addon** (sejak v3.24.10 — commit
`7f0b81d`, repo recallfox & recallfox-chrome) dan belum pernah dipindah ke Desktop/PWA.
Permintaan: kembalikan fitur tersebut di segmen ini, mulai dari tag terbaru
(v3.24.25-chrome / v3.24.25-firefox / v1.22.0+ pwa).

## Yang diporting — paritas 1:1 dengan addon v3.24.10

### 1. Mesin + vendor (identik md5 dengan kedua addon)
- `public/vendor/xlsx-engine.js` — mesin **RFRekonEngine** (md5 `bf37a658…`, sama dengan
  addon Firefox & Chrome): `parseWorkbook` → `analyze` → `buildZip`.
- `public/vendor/xlsx.full.min.js` — SheetJS 0.18.5 (md5 `31e9848e…`).
- `public/vendor/fflate.min.js` — fflate 0.8.3 (md5 `d85498a4…`).
- Semua lokal di `/vendor`, **100% offline** — tanpa server, tanpa CDN, tanpa permission baru.

### 2. Alur fitur (sama persis dengan tab Rekonsiliasi addon)
1. **Pilih berkas Excel** (.xls/.xlsx/.csv) — Laporan Pembayaran Jaminan BPJS.
2. **Analisa otomatis**: header dideteksi per baris (tidak harus baris 1), kolom hantu &
   baris kosong dibuang, dikelompokkan per **Nama Rek. Penerima** (dinormalisasi — kapital/
   spasi ganda disamakan) + chip statistik **Tagihan / Penerima / Total / Periode**.
3. **Daftar penerima**: centang per rekening, 🔍 pencarian, tombol **Semua / Nihil /
   ★ Favorit**, bar "Dipilih: N penerima · N tagihan · Rp total".
4. **★ Favorit persisten** — `localStorage` kunci `rf_rekon_favs_v1` (kunci sama dengan
   addon); rekening favorit otomatis terpilih saat berkas bulan berikutnya di-upload.
5. **⬇ Unduh ZIP** — `<nama berkas> - REKONSILIASI.zip` berisi:
   - `01 <Nama Rekening>.xlsx`, `02 …` — semua kolom asli + baris **TOTAL**, baris diurut
     **Tgl Bayar → Kode Klaim** (tanggal dd-mm-yyyy / ISO / serial Excel dikenali);
   - **REKAP.xlsx** — 1 baris per penerima (No, Nama Rekening, Bank, No. Rekening,
     Jml Tagihan, Total Bayar, Nama File) + baris TOTAL.

### 3. Adaptasi lingkungan Desktop (perilaku tetap identik)
- Favorit: `browser.storage.local` (addon) → `localStorage` (Desktop).
- Unduh: Downloads API (addon) → anchor `<a download>` blob URL (pola sama dgn tab lain).
- UI memakai kelas `tg-card`/`tg-btn` Desktop agar konsisten dengan tab Urutkan/Gabung.

### 4. Lampiran dipertahankan
Alat lama "Cocokkan kwitansi (manual)" TIDAK dihapus — dipindah jadi kartu lampiran di
bawah fitur utama (logika & penyimpanan `rf-dt-rekons` tidak berubah).

## Validasi
- `node --check` seluruh modul desktop.html (3.576 baris) — OK.
- **Uji mesin Node `scripts/test_rekon_desktop.mjs`: 43/43 PASS** — util (fmt/toNumber/
  dateKey serial Excel), berkas BPJS sintetis (header turun ke baris 3, sheet pengganggu,
  kolom & baris hantu, format nominal liar), parse→analyze→buildZip (semua & subset),
  verifikasi isi ZIP per penerima + REKAP, CSV titik-koma, kasus gagal ramah.
- **E2E Playwright Chromium `scripts/test_rekon_e2e.mjs`: 23/23 PASS** — desktop.html ASLI
  via static server, login Supabase di-mock (routing), alur nyata di browser: buka tab →
  upload → analisa (4 penerima · 9 tagihan · Rp 10.065.500) → cari → Nihil/Semua → ★
  favorit → unduh ZIP (nama & isi diverifikasi via fflate+SheetJS) → upload ulang (favorit
  auto-terpilih) → tab lain utuh → 0 pageerror kritis.
- Fix hasil E2E: `trkRenderList()` + `trkUpdateBar()` kini dipanggil di akhir
  `trkRenderSummary()` (paritas dengan addon — sebelumnya daftar/bar baru muncul setelah
  interaksi pertama).

## Berkas
- Baru  : `public/vendor/xlsx-engine.js`, `public/vendor/xlsx.full.min.js`,
          `public/vendor/fflate.min.js`, `scripts/test_rekon_desktop.mjs`,
          `scripts/test_rekon_e2e.mjs`, `scripts/extract_module_check.mjs`
- Ubah  : `public/desktop.html` (tab Rekonsiliasi), `package.json` (1.24.0)
