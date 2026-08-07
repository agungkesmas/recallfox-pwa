# v1.12.1 — Fix copy bundle (salin SEMUA isi, bukan hanya judul)

> **Tanggal:** 2026-08-07
> **Tipe:** Bug fix
> **Tag:** `v1.12.1-pwa`

## Ringkasan

Fix masalah kritis: tombol "Salin" pada item Bundle di PWA hanya menyalin
judul bundle (±14 karakter), bukan isi semua anggotanya. Setelah fix, copy
bundle sekarang menyalin body prompt, URL link, isi file, dan annotation
screenshot dari semua anggota bundle dalam format rapi.

## Masalah

User report (dengan screenshot):
- Klik tombol 📋 di item Bundle → toast "Disalin (14 karakter)"
- 14 karakter = judul bundle saja, bukan isi
- Padahal bundle berisi banyak item (prompt, link, file, screenshot, dll)

## Root Cause

Fungsi `copyItem(id)` di `src/views/vault.js:600` tidak punya branch khusus
untuk `type === 'bundle''. Bundle masuk ke `else` branch (line 611-612 lama)
yang copy `item.body || item.note || item.title`. Bundle tidak punya `body`
(kosong) → fallback ke `item.title` (judul) → cuma 14 karakter.

Bundle punya field `item_ids` (array ID anggota) yang berisi referensi ke
item lain di vault. Untuk copy bundle dengan benar, perlu loop ke `item_ids`,
lookup setiap anggota di vault, lalu format gabungan menjadi 1 string rapi.

## Perubahan

### `src/views/vault.js`

1. **Tambah branch bundle di `copyItem(id)`** (line 626):
   - Kalau `item.type === 'bundle'` → panggil `buildBundleContent(item, items)`
   - Tetap handle empty result (toast "Item kosong — tidak ada yang disalin")
   - Branch lain (link, file, prompt, context, snapshot) tidak diubah

2. **Tambah function baru `buildBundleContent(bundle, allItems)`** (line 657):
   - Kumpulkan semua anggota bundle via lookup `item_ids` (atau `itemIds`
     camelCase fallback) ke `allItems` (semua vault items).
   - Skip orphan (ID di `item_ids` tapi tidak ada di vault) supaya tidak
     muncul `undefined` di output.
   - Format output:
     ```
     --- BUNDLE: <judul bundle> (N item) ---

     --- PROMPT: <judul item> ---
     <body prompt>

     --- LINK: <judul link> ---
     <url link>

     --- FILE: <judul file> ---
     <body file>

     --- SCREENSHOT: <judul screenshot> ---
     <annotation note>
     ...
     ```
   - Type-aware body extraction per anggota:
     - `link` → `link_url` (atau `body` fallback)
     - `file` → `body`
     - `prompt`/`context`/`snapshot` → `body` (atau `note` fallback)
     - `screenshot`/`document` → `body` atau `source.annotationNote`
       atau `annotation_note` (multi-fallback)
   - Header per item pakai label dari `TYPE_LABELS` (PROMPT, LINK, FILE,
     SNAPSHOT, SCREENSHOT, dll) — konsisten dengan UI.
   - Body kosong → placeholder `(kosong)` supaya tidak ada baris kosong
     tanpa konteks.
   - Return empty string kalau bundle tidak punya anggota valid (untuk
     short-circuit di copyItem + tampilkan toast info).

### `package.json`

- Bump version `1.12.0` → `1.12.1`

## Smoke Test (8/8 PASS)

Script: `/home/z/my-project/scripts/smoke-bundle-content.mjs`

1. ✅ Bundle dengan 3 anggota (prompt, link, file) — header semua benar,
   URL + body ter-include, total > 100 char
2. ✅ Bundle dengan orphan ID — orphan di-skip, count sesuai (2 bukan 4),
   tidak ada `undefined` di output
3. ✅ Bundle kosong (`item_ids = []`) — return empty string
4. ✅ Bundle tanpa field `item_ids` sama sekali — return empty string
5. ✅ Bundle dengan `itemIds` (camelCase) — fallback terbaca
6. ✅ Bundle dengan screenshot + `source.annotationNote` — annotation
   ter-include, header "SCREENSHOT" benar
7. ✅ Bundle dengan item body kosong — placeholder `(kosong)` muncul
8. ✅ Bundle dengan 3 anggota — total length 163 char (> 14, > 100)
   — toast akan tampil "Disalin (163 karakter)" bukan "(14 karakter)"

## Build Verify

```
npm run build
✓ built in 1.46s
dist/assets/index-BrAQbp7I.js   401.27 kB │ gzip: 108.11 kB
```

Tidak ada error compile. Bundle size OK.

## Backward Compatible

- Schema database tidak diubah (`item_ids` tetap di `vault_items` JSONB).
- Sync Supabase tidak terpengaruh (fix hanya di UI layer).
- Item non-bundle (prompt, link, file, snapshot, screenshot) tidak diubah
  behavior copy-nya.
- Bundle kosong / tanpa anggota: toast "Item kosong — tidak ada yang
  disalin" (sebelumnya: copy judul dengan 6 karakter — misleading).

## Test Plan Manual (untuk verifikasi user)

1. Buka PWA `https://recallfox-pwa.vercel.app/` (setelah deploy)
2. Login, buka vault
3. Bikin bundle dengan beberapa item (atau cari bundle existing)
4. Klik tombol 📋 di samping bundle
5. Paste ke notepad / chat
6. Verify:
   - Toast bilang "Disalin (N karakter)" dengan N > 14
   - Output punya header `--- BUNDLE: <judul> (N item) ---`
   - Setiap anggota punya header `--- TIPE: judul ---`
   - Body/URL setiap anggota ter-include
   - Tidak ada `undefined` di output
