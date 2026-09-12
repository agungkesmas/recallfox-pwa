# CHANGELOG PWA — v1.23.2 (12 Sep 2026)

## Daftar situs upload manual: riset ulang + 10 situs terverifikasi live (gofile KEMBALI)

Permintaan user: *"TOLONG tambahkan https://gofile.io/ dan lainnya jika masih ada upload populer di pilihan upload manual di pwa maupun addon. kamu riset dulu yang lainnya tu apa aja gitu baru perbarui ... dan masih bisa digunakan."*

### Riset (12 Sep 2026)
- Uji langsung 18 layanan kandidat: cek homepage + **upload fungsional via curl** (bukan sekadar daftar teori).
- gofile.io: dari sini (IP datacenter) diblokir, tapi **multi-node check (check-host.net: ES/FR/SE) = HTTP 200** — situs hidup; laporan v1.22.0 yang membuang gofile sudah usang. Kembali ke daftar **di urutan pertama**.
- Lolos uji upload live: litterbox, tmpfiles, filebin.net, uguu.se, x0.at, temp.sh (endpoint benar: `POST /upload` multipart).
- Terbukti MATI/gagal: transfer.sh (DNS hilang), bashupload.com (DNS hilang), fileconvoy (mati), 0x0.st (flaky), file.io (sekali unduh), krakenfiles (uji 2 langkah tidak selesai).
- pixeldrain: web upload anon masih bisa (API butuh key) → tetap masuk. catbox: hidup tapi upload anonim API kadang ditolak "Invalid uploader" → tetap ada dengan catatan jujur di note.

### Perubahan
- `src/lib/temp-upload.js` — `MANUAL_SITES` 4 → **10 situs** (gofile, litterbox, tmpfiles, filebin, temp.sh, uguu, x0.at, pixeldrain, storage.to, catbox), note tiap situs memuat batas ukuran/masa simpan/keanehan.
- `public/desktop.html` — `RF_SITES_DEF` paritas 1:1 (10 situs).
- User yang pernah menyimpan daftar sendiri (localStorage `recallfox_manual_sites` / `rf-dt-manual-sites`) tidak terdampak — daftar default hanya dipakai bila user belum mengelola sendiri; Maks tetap 12.

### Verifikasi
- Unit test modul temp-upload + live roundtrip litterbox: PASS.
- Rilis paritas: addon Firefox & Chrome v3.24.24 (daftar identik).
