# CHANGELOG v1.23.0 — PWA

Tanggal: 2026-09-12

## Auto-redirect desktop → /desktop.html + fitur KOMPRESI hasil Gabung PDF (ala iLovePDF)

**Permintaan user:**

1. "kalau begitu ga usah digabung tapi dikasih kemudahan untuk mengakses
   /desktop.html, jadi misalkan kedeteksi lagi buka / di desktop auto redirect"
2. "fitur kompresnya bisa dipilih seperti ilovepdf: extreme, sedang, dan tanpa
   compress" (penerapan lanjutan ke PWA & addon menyusul).

## Perubahan

### 1. Auto-redirect pengunjung desktop (`index.html`)

- Inline script di `<head>` (jalan sebelum bundle, tanpa flash):
  `/` atau `/index.html` + **UA desktop + layar ≥900px** → `location.replace('/desktop.html')`
  — query & hash **dibawa utuh**.
- **Aman terhadap alur yang sudah jalan:**
  - `/share-target` (share_target Android & addon) → tidak disentuh (redirect hanya
    pathname persis `/` atau `/index.html`).
  - `auth-relay.html`, `offline.html`, sw.js, assets → tidak tersentuh.
  - Ponsel/tablet (UA Android/iPhone/iPad, termasuk iPad UA "Macintosh"+touch) → tetap
    di PWA mobile.
  - PWA terpasang di perangkat sentuh → tidak dialihkan.
- **Escape hatch:** buka `/?mobile=1` (atau `#mobile`) untuk tetap melihat PWA mobile
  di desktop; diingat sepanjang sesi tab (sessionStorage).
- Verifikasi E2E 8/8 kasus (desktop, laptop 1024, iPhone, tablet Android,
  ?mobile=1, /share-target, query+hash terbawa).

### 2. Kompresi hasil Gabung PDF — 3 preset ala iLovePDF (`public/desktop.html`)

- Di **langkah berkas terakhir** wizard Gabung muncul blok **🗜 KOMPRESI HASIL**:
  | Preset | Parameter | Cocok untuk |
  |---|---|---|
  | 🔥 **Ekstrem** | 96 DPI · JPEG 45% | kirim WA/email yang mentok ukuran |
  | ⚖️ **Sedang** (default, spt "Recommended" iLovePDF) | 150 DPI · JPEG 62% | arsip tagihan seimbang |
  | 📄 **Tanpa kompres** | salin vektor utuh (perilaku lama) | teks penting / kualitas penuh |
- Mesin 100% offline di browser: **pdf.js render → canvas → JPEG → embed pdf-lib**.
  Halaman pembuka & pemisah antar berkas **tetap vektor** (teks UI tetap tajam);
  hanya halaman isi yang dirasterisasi saat kompres aktif.
- **Perkiraan ukuran sebelum menggabung**: sampel render halaman pertama tiap berkas
  × jumlah halaman dicentang (tertulis di blok kompresi; hasil final tetap tampil
  setelah digabung).
- **Peringatan teks otomatis**: kalau ada berkas born-digital (teks asli terdeteksi
  via `getTextContent`), muncul catatan bahwa hasil kompres menjadi gambar (teks tak
  bisa dicari/diseleksi) + saran pilih Tanpa kompres. Peringatan hilang saat preset
  Tanpa kompres.
- **Progress bar menggabung** (per bagian/halaman) + toast ringkasan hemat
  (`🗜 Kompres Sedang: 4,2 MB → 871,4 KB (−80%)`).
- **Catatan jujur**: bila hasil kompres ≥ perkiraan sumber (sumber sudah efisien),
  meta hasil menampilkan "kompres tak mengecilkan berkas".
- Fallback aman: raster halaman gagal → halaman itu disalin vektor; doc pdf.js belum
  terbuka → dibuka otomatis; jika tetap gagal → seluruh berkas disalin vektor.
- Preset tersimpan di `localStorage` (`rf-dt-tgcomp`) **dan ikut draf IndexedDB**
  (tahan refresh).
- Hasil E2E nyata (2 scan + 1 teks, ±4,2 MB → 4 halaman isi):
  Ekstrem 157,8 KB (−97%) · Sedang 871,4 KB (−80%) · Tanpa kompres 4,2 MB.

### 3. Non-perubahan (sengaja)

- PWA mobile (root) tidak berubah perilaku di ponsel; `share-target`, `auth-relay`,
  dan tombol addon → `/desktop.html` tetap valid.
- Upload/`uploadToTempHost`, rekonsiliasi, urutkan — tidak disentuh.
