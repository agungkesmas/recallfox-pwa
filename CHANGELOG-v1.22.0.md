# CHANGELOG v1.22.0 — PWA

Tanggal: 2026-09-11

## Daftar situs upload manual: gofile.io → temp.sh + BISA DIKELOLA USER

**Permintaan user:**

1. "gofile.io ini sudah tidak berlaku tidak bisa dipake, ganti dengan temp.sh"
2. "harusnya daftar situs upload manualnya juga bisa diupdate atau delet
   mandiri" — user bisa tambah/ubah/hapus isi daftar sendiri.

## Perubahan

### 1. Default daftar situs — gofile.io keluar, temp.sh masuk

- `src/lib/temp-upload.js` — `MANUAL_SITES` kini: litterbox.catbox.moe,
  catbox.moe, **temp.sh**, tmpfiles.org.
- Verifikasi curl 2026-09-11: `POST https://temp.sh/upload` sukses
  (`https://temp.sh/<id>/<file>`), file disimpan server **3 hari** —
  sinkron dengan TTL vault manual 72 jam.
- Catatan jujur di tooltip situs: URL temp.sh membuka **halaman unduh
  (tombol "Click here to download")**, bukan file mentah. Untuk alur
  MANUAL ini bukan masalah — item vault manual tidak pernah fetch isi
  file (body kosong, size 0); user unduh lewat tombolnya.
- Upload otomatis (`uploadToTempHost`) **tetap litterbox** — tidak
  disentuh sama sekali.

### 2. Daftar situs bisa dikelola user (tambah / ubah / hapus / pulihkan)

- Panel 🔗 Manual di sheet Upload File kini punya tombol **✏️ Kelola**:
  - **＋ Tambah** — isi nama situs + URL (wajib `https://`), daftar
    tervalidasi: label 1–40 char, URL 1–300 char, dedupe URL (beda
    garis miring/case dianggap sama), maks **12 situs**.
  - **✏️** pada baris — isi form dengan data situs, tombol berubah
    **✓ Update** (＋ **Batal edit** untuk membatalkan).
  - **🗑** pada baris — hapus langsung dari daftar.
  - **↺ Pulihkan default** — kembalikan 4 situs bawaan kapan pun.
  - **✓ Selesai** — kembali ke mode chips (klik situs → tab baru).
- **Penyimpanan:** `localStorage` key `recallfox_manual_sites`
  — per browser/device, persisten antar sesi.
- **Defensif (pola v1.21.0, semuanya dipatuhi):**
  - Semua elemen baru diambil lewat `reqEl()` — ada yang hilang →
    sheet gagal EKSPLISIT (alert + remove), bukan tombol mati diam-diam.
  - Semua listener dipasang SEKALI; render chips tetap DI LUAR
    `_paintDest` (tidak ada duplikasi listener).
  - Semua data user (label/URL/note) di-escape sebelum masuk
    innerHTML (aman dari injeksi HTML).
  - localStorage gagal → fallback daftar default + alert jelas,
    tidak crash.
  - Fungsi murni `sanitizeManualSites()` + `manualSiteHost()` +
    `MANUAL_SITES_MAX` di `src/lib/temp-upload.js` — paritas 1:1
    dengan addon v3.24.19 (Firefox & Chrome).

## Validasi

- Syntax: `node --input-type=module --check` + acorn `sourceType:module`
  → src/main.js & src/lib/temp-upload.js OK.
- Logika murni lib diuji langsung di Node: default 4 situs (temp.sh
  masuk, gofile keluar), sanitize (http ditolak, dedupe, cap 12),
  manualSiteHost — semua OK.
- Alur simpan manual (sync.js `createFileItem` destination manual,
  TTL 72 jam) — TIDAK diubah sama sekali.
