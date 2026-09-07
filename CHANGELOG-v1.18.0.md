# v1.18.0 — UPLOAD FILE: DUAL DESTINATION (Database / Sementara + Auto-Expire)

## Permintaan user

> "aku ingin fitur upload file bisa dua, 1. masuk ke database/suppabase,
> 2. masuk ke situs upload file sementara seperti temp.sh atau lainnya.
> alur menambahkan filenya tapi tidak ada yang beda hanya saja untuk nomor 2
> akan hilang sendiri di vault sesuai dengan batas waktu di situs upload
> sementaranya. apakah ini bisa terwujud?"

**Terwujud** — di PWA DAN addon (Firefox + Chrome), satu model data.

| Tujuan | Penyimpanan | Umur | Hilang otomatis |
|---|---|---|---|
| ☁️ **Database** (default) | Supabase Storage + vault_items | Permanen | Tidak (perilaku lama) |
| ⏳ **Sementara** (default: 3 hari) | litterbox.catbox.moe (URL publik) | 1 jam / 12 jam / 1 hari / 3 hari | **Ya** — item dihapus otomatis dari vault di semua device |

## Audit host sementara (8 Sep 2026) — kenapa BUKAN temp.sh

- **temp.sh** — upload OK, TAPI URL **tidak pernah serve file mentah**: GET
  selalu balik halaman HTML (dicek: curl, browser UA, `?dl=1`). Akibatnya
  fetch URL → HTML → zip/gambar **corrupt**, AI chat **tidak bisa membaca**
  isi URL. Ditolak.
- **litterbox.catbox.moe** — URL serve **file mentah** (md5 roundtrip
  identik), `Access-Control-Allow-Origin: *` sehingga PWA bisa upload
  **langsung dari browser tanpa proxy**, ekstensi file dipertahankan,
  expiry server-side `1h|12h|24h|72h`. **Dipakai.**

## Perubahan PWA

### Baru: `src/lib/temp-upload.js` (md5-identik dengan addon)
Modul pure + testable: `TEMP_DURATIONS`, `tempExpiresAt`, `isTempItem`,
`isTempExpired`, `tempRemainingLabel` (countdown "2j 15m"/"45m"/"kedaluwarsa"),
`uploadToTempHost(blob, fileName, durationId)` — POST multipart ke litterbox,
validasi respons ketat (harus URL litter/catbox; tolak HTML/error/foreign host).

### `src/sync.js`
- `createFileItem(user, payload, opts)` — opts `{destination:'temp',
  duration}`: upload ke litterbox dulu (gagal = item TIDAK dibuat), lalu
  insert `vault_items` dengan `source.tempHost/tempUrl/tempExpiresAt/
  tempDuration`; `gdrive_file_*` NULL (file TIDAK masuk Storage Supabase).
  Tanpa opts = perilaku lama (Storage + vault).
- `cleanupExpiredTempItems(user)` — scan IndexedDB → item temp yang
  `tempExpiresAt` lewat dihapus via `deleteVaultItem` (delete registry +
  hard-delete cloud + realtime broadcast ke device lain).

### `src/main.js`
- Sheet Upload File: segmented control `☁️ Database | ⏳ Sementara` +
  dropdown durasi (default 3 hari) + catatan dinamis.
- Cleanup saat renderShell + interval 60 detik + toast "⏳ N file sementara
  kedaluwarsa — dihapus dari vault".

### `src/views/vault.js`
- Badge countdown di kartu: `⏳ Sementara (litterbox) · sisa 2j 15m`.
- Cleanup per-render: item kedaluwarsa dihapus DAN di-splice dari array
  render (tidak sempat tampil).
- Salin item temp binary (body kosong) → URL temp.

## Model data (zero schema change)
`item.source` (JSONB yang sudah tersinkron): `tempHost: 'litterbox'`,
`tempUrl`, `tempExpiresAt: <ISO>`, `tempDuration: '1h'|'12h'|'24h'|'72h'`.
Sinkron addon ↔ PWA otomatis; item dihapus di satu device hilang di semua
device (realtime DELETE + delete registry).

## Validasi
- `node scripts/test_temp_upload_pwa.mjs` — **10/10 PASS** (termasuk LIVE
  upload litterbox + roundtrip isi identik dari Node).
- **E2E Playwright (vite dev, modul asli) — 16/16 PASS**: upload LIVE dari
  konteks browser (buktikan CORS `*` untuk PWA), roundtrip isi identik,
  `createFileItem` temp + durasi invalid ditolak, `renderVault` asli
  (badge countdown + host), item kedaluwarsa terhapus dari IndexedDB dan
  tidak dirender, salin URL temp untuk file binary, 0 pageerror.
- `vite build` OK tanpa dependensi baru.
