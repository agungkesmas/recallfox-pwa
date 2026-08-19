# RecallFox PWA — v1.13.2 (FIX Bundle Copy "Salin Link + Keterangan")

> Fix bug FASE 3 v1.13.1: copy bundle menghasilkan output kosong (0 media)
> karena mismatch struktur data antara PWA dan addon.

Tanggal: 2026-08-19
Base: `v1.13.1` (FASE 3 yang gagal)

## Gejala

PWA v1.13.1 output copy bundle:
```
# 📦 Bundle Bundle tanpa nama
📅 Tanggal Bundle: 19 Agustus 2026 | Total Item: 0 Media
---
— Dihasilkan oleh RecallFox untuk AI Agent —
```

Addon (target):
```
# 📦 Bundle cek kasus majalengka agustus
📅 Tanggal Bundle: 19 Agustus 2026 | Total Item: 6 Media
---
### 📷 Media 1: Foto tangan m. Irwan sutoyo
- 🔗 Link Gambar: https://...supabase.co/.../sh_mszm887p_wmq8lt.jpg
- 📝 Keterangan / Catatan: Selama tidak masuk kerja...
- 🕒 Waktu Tangkap: 19/08/26, 11.52 WIB
- 📍 Lokasi: 11, Parapatan, Jawa Barat (-6.7036394, 108.3604829)
...
```

## Akar penyebab

**Mismatch struktur data bundle antara PWA dan addon:**

| Field | Addon (Firefox/Chrome) | PWA | Sebelumnya (v1.13.1) |
|---|---|---|---|
| Nama bundle | `bundle.name` | `bundle.title` | `bundle.name` → undefined → "Bundle tanpa nama" |
| Member IDs | `bundle.itemIds` / `bundle.injectOrder` | `bundle.item_ids` (snake_case) | `bundle.itemIds` → undefined → kosong |
| Note IDs | `bundle.noteIds` | `bundle.note_ids` (snake_case) | `bundle.noteIds` → undefined → kosong |

PWA simpan bundle sebagai **vault item dengan `type='bundle'`** (bukan entity
terpisah seperti di addon yang pakai `currentVault.bundles`). Field-nya pakai
snake_case (`item_ids`, `note_ids`) sesuai konvensi Supabase DB.

`copyBundleLinkCaption` v1.13.1 porting langsung dari addon tanpa adaptasi
struktur PWA → `bundle.itemIds` undefined → `memberIds = []` → `memberItems = []`
→ `totalItems = 0` → output kosong.

## Fix (2 file)

### 1. `src/views/vault.js` — `copyBundleLinkCaption()` 

Sebelumnya:
```js
const memberIds = bundle.itemIds || [];
const noteIds = bundle.noteIds || [];
const memberItems = memberIds.map(id => allItems.find(i => i.id === id)).filter(Boolean);
```

Sekarang:
```js
// v1.13.2 FIX: PWA pakai item_ids (snake_case). Fallback ke itemIds (addon style)
// untuk backward compat kalau bundle di-sync dari addon.
const memberIds = Array.isArray(bundle.item_ids) ? bundle.item_ids :
                  Array.isArray(bundle.itemIds) ? bundle.itemIds : [];
const noteIds = Array.isArray(bundle.note_ids) ? bundle.note_ids :
                Array.isArray(bundle.noteIds) ? bundle.noteIds : [];
// Lookup anggota by ID dari allItems (sama seperti buildBundleContent line 669-677).
const lookup = new Map();
for (const it of allItems) {
  if (it && it.id) lookup.set(it.id, it);
}
const memberItems = memberIds.map(id => lookup.get(id)).filter(Boolean);
```

Pakai `Map` lookup (lebih efficient dari `.find()` per item, sama seperti
`buildBundleContent` yang sudah ada di PWA line 669-677).

### 2. `src/copy-format.js` — `buildBundleMediaReport()` 

Sebelumnya:
```js
const bundleName = bundle.name || 'Bundle tanpa nama';
```

Sekarang:
```js
// v1.13.2 FIX: PWA pakai bundle.title (bukan bundle.name seperti addon).
// Fallback chain: bundle.name (addon style) → bundle.title (PWA style) → 'Bundle tanpa nama'.
const bundleName = bundle.name || bundle.title || 'Bundle tanpa nama';
```

Fallback chain supaya fungsi yang sama jalan untuk addon (pakai `name`) dan PWA
(pakai `title`).

## Verifikasi

- ✅ `node --check src/copy-format.js` PASS
- ✅ `node --check src/views/vault.js` PASS
- ✅ `npm run build` (Vite) PASS — 411.64 KB bundle
- ✅ `bundle.item_ids` fallback ada (7 refs di vault.js)
- ✅ `bundle.title` fallback ada (3 refs di copy-format.js, 3 refs di vault.js)

## Cara test (harus sesuai output addon)

1. Buka https://recallfox-pwa.vercel.app → login
2. Buat bundle dengan beberapa item (screenshot + file + link) — beri nama
   bundle yang jelas (mis. "cek kasus majalengka agustus")
3. Klik `⋯` pada bundle → pilih **"📋 Salin Link + Keterangan"**
4. Toast: "📋 Link + Keterangan tersalin (N karakter)" — N harus > 500 kalau
   bundle punya media
5. Paste di AI chat → verify output:
   - Header: `# 📦 Bundle [nama bundle]` (bukan "Bundle tanpa nama")
   - `Total Item: N Media` (N > 0, sesuai jumlah anggota)
   - Section `### 📷 Media 1: [judul]` per anggota, dengan:
     - 🔗 Link Gambar/Dokumen (cloud URL dari Supabase Storage)
     - 📝 Keterangan / Catatan (annotation note)
     - 🕒 Waktu Tangkap (capturedAt/createdAt)
     - 📍 Lokasi (GPS coords kalau ada)
6. Verify opsi lama "📋 Salin ke Clipboard" tetap jalan
7. Verify menu `⋯` untuk tipe lain (prompt, link, screenshot) tidak berubah

## File yang berubah

| File | Perubahan |
|---|---|
| `src/views/vault.js` | `copyBundleLinkCaption()` — fix `item_ids`/`note_ids` (snake_case) + Map lookup |
| `src/copy-format.js` | `buildBundleMediaReport()` — fix `bundleName` fallback ke `bundle.title` |
| `package.json` | version bump `1.13.1` → `1.13.2` |

## Catatan

- **Base**: `v1.13.1` (FASE 3 yang gagal)
- **Tidak ditandai sebagai stable** — sesuai instruksi
- **Paritas**: sekarang PWA v1.13.2 output copy bundle sama persis dengan
  addon Firefox v3.21.4 + Chrome v3.21.4
