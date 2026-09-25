# CHANGELOG v1.24.1 — PARITAS PENUH DGN ADDON: KARTU LAMPIRAN MANUAL DIHAPUS DARI TAB REKONSILIASI

## Permintaan user
> "samakan dengan addon aja. kotak merah kyknya di addon tidak ada"

Setelah restorasi v1.24.0, tab 🧮 **Rekonsiliasi** di Desktop masih memuat satu kartu
ekstra — **"LAMPIRAN — COCOKKAN KWITANSI (MANUAL)"** (pencocok kwitansi alat lama yang
dipertahankan sebagai lampiran). Kartu itu **tidak ada di addon** (baik Firefox maupun
Chrome — `rfRenderRekonPane` hanya berisi: kartu pilih berkas → hasil analisa → hintbox
★ favorit). Sesuai permintaan, tab kini disamakan **1:1 dengan addon**.

## Perubahan
- **Hapus** kartu `#trkManual` ("LAMPIRAN — COCOKKAN KWITANSI (MANUAL)") dari `trPaint()`
  di `public/desktop.html`.
- **Hapus** kode yang ikut menganggur: fungsi `trManualPaint()`, state `TR` +
  `trSave()` (localStorage `rf-dt-rekons`), helper `rp()` & `rfParseAmt()`, dan CSS
  `.tg-rk*` / `.rk-amt` — semuanya hanya dipakai kartu lampiran tsb.
- Struktur tab Rekonsiliasi sekarang **identik alurnya dengan addon v3.24.10**:
  1. Kartu "REKONSILIASI TAGIHAN — PECAH EXCEL PER PENERIMA" (pilih berkas Excel)
  2. Hasil analisa — chip + cari + Semua/Nihil/★Favorit + bar pilihan + daftar + unduh ZIP
  3. Hintbox 💡 "Rekening yang diberi ★ tersimpan permanen…"
- Fitur pecah Excel → ZIP **tidak berubah sama sekali** (mesin, vendor, favorit, nama
  berkas ZIP — semua persis v1.24.0 / addon).

## Validasi
- `node --check` modul desktop (234.765 char) — OK.
- Uji mesin Node `scripts/test_rekon_desktop.mjs` — **43/43 PASS**.
- E2E Playwright Chromium `scripts/test_rekon_e2e.mjs` — **24/24 PASS** (2 asersi baru:
  kartu lampiran manual tidak ada + `#trkManual` lenyap dari DOM), 0 pageerror.
