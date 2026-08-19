# RecallFox PWA v1.13.1 — FASE 3: Salin Link + Keterangan untuk Bundle

**Tanggal:** 19 Agustus 2026
**Base:** v1.13.0
**Paritas:** Firefox v3.21.4-firefox (FASE 1) + Chrome v3.21.4-chrome (FASE 2)
**Scope:** Hanya menu Bottom Sheet `⋯` Bundle. Tidak ada perubahan fitur lain.

## TL;DR

Porting fitur "📋 Salin Link + Keterangan" dari addon (Firefox v3.21.4 + Chrome v3.21.4) ke PWA. Saat user klik `⋯` pada Bundle → pilih "📋 Salin Link + Keterangan", clipboard terisi Markdown terstruktur untuk AI Agent:

```markdown
# 📦 Bundle Laporan Kunjungan: [Nama Bundle]
📅 Tanggal Bundle: 19 Agustus 2026 | Total Item: 5 Media

---

### 📷 Media 1: [Judul Foto]
- 🔗 Link Gambar: https://xyz.supabase.co/storage/v1/object/public/documents/foto_1.jpg
- 📝 Keterangan / Catatan: [annotationNote]
- 🕒 Waktu Tangkap: 19/08/2026 10:15 WIB
- 📍 Lokasi: Cirebon (-6.7321, 108.5523)

---

### 📄 Media 2: [Judul Dokumen]
- 🔗 Link Dokumen: [URL]
- 📝 Keterangan / Catatan: [body slice]

---

— Dihasilkan oleh RecallFox untuk AI Agent —
```

## Perubahan

### 1. `src/copy-format.js` (+131 lines)

Port `buildBundleMediaReport(bundle, items, notes)` + `stripHtmlForPreview(html)` dari addon. Fungsi:
- Format Markdown terstruktur per-media (screenshot, document, file, link, note)
- Null-safety: optional chaining (`item?.source?.location?.lat`), fallback cloud URL (`gdriveFileUrl` → `gdrive_file_url` → `linkUrl` → `source.pages[0].url` → `source.url`), fallback annotation note
- Lokasi: tampilkan address + koordinat kalau ada GPS data
- Waktu: format `id-ID` short date + time + "WIB"
- Notes: strip HTML ke plain text (max 500 char)

### 2. `src/views/vault.js` (+55 lines)

**Import:** tambah `import { buildBundleMediaReport } from '../copy-format.js';`

**`openItemMenuSheet(itemId)`:** tambah opsi khusus bundle:
```html
${item.type === 'bundle' ? '<button class="sheet-btn" data-action="copy-link-caption">📋 Salin Link + Keterangan</button>' : ''}
```
Opsi hanya muncul untuk `type === 'bundle'` — tidak mengganggu tipe lain (prompt/context/link/screenshot/document/file/snapshot).

**Handler:** `else if (action === 'copy-link-caption') await copyBundleLinkCaption(itemId);`

**Fungsi baru `copyBundleLinkCaption(bundleId)`:**
- `async function` (anti-freeze protocol #1)
- `try { ... } catch (err) { showToast }` (anti-freeze protocol #2)
- Null-safety: cek `bundle` exist + `type === 'bundle'` sebelum lanjut (anti-freeze protocol #3)
- Ambil anggota bundle dari `bundle.itemIds` + `bundle.noteIds`
- Notes: fallback ke `window.__rfAllNotes` kalau ada (PWA cache), kalau tidak ada → empty array (buildBundleMediaReport handle null safely)
- Clipboard: `navigator.clipboard.writeText()` dengan fallback `document.execCommand('copy')` (untuk browser lama / non-secure context)
- Toast: "📋 Link + Keterangan tersalin (N karakter)"

## Anti-Freeze Protocol (dipatuhi 100%)

1. ✅ **`async function`** — `copyBundleLinkCaption` pakai `async` + `await`
2. ✅ **`try-catch`** — seluruh logic dibungkus try-catch, error ditangkap dengan toast
3. ✅ **Null-safety** — `bundle.find()` bisa return undefined → toast + return; optional chaining di buildBundleMediaReport
4. ✅ **Tidak ganggu `e.stopPropagation()`** — handler pakai pola existing (close sheet → setTimeout → action)
5. ✅ **ESM syntax verified** — `node --input-type=module --check` PASS untuk copy-format.js + vault.js + Vite build PASS

## Yang TIDAK berubah (anti-regression)

- Opsi lama "📋 Salin ke Clipboard" tetap ada 100% (tidak dihapus/ditumpuk)
- Tidak ada perubahan pada tipe lain (prompt/context/link/screenshot/document/file/snapshot)
- Tidak ada perubahan pada Batch Bar, Form Edit, Folder Menu, capture, sync, dll
- Tidak ada perubahan schema database
- Tidak ada perubahan pada `lib/folder-ops.js`, `lib/vault-tree.js`, `db.js`, `sync.js`

## Verifikasi

- ✅ `node --input-type=module --check src/copy-format.js` → exit 0 (PASS)
- ✅ `node --input-type=module --check src/views/vault.js` → exit 0 (PASS)
- ✅ `npm run build` (Vite) → PASS, 411 KB bundle (swelled ~12 KB dari v1.13.0)
- ✅ `buildBundleMediaReport` ada di copy-format.js (1 export)
- ✅ `copyBundleLinkCaption` ada di vault.js (1 function + 1 handler + 1 button)
- ✅ Opsi hanya muncul untuk `type === 'bundle'` (conditional rendering)

## Cara Test

### Test 1: Bundle Menu "📋 Salin Link + Keterangan"
1. Buka PWA → https://recallfox-pwa.vercel.app
2. Login → buat bundle dengan beberapa item (screenshot, file, link)
3. Klik `⋯` pada bundle
4. Menu harus muncul dengan opsi baru **"📋 Salin Link + Keterangan"** (di antara "Salin ke Clipboard" dan "Edit Judul & Isi")
5. Klik → toast "📋 Link + Keterangan tersalin (N karakter)"
6. Paste di AI chat / notepad → verify Markdown terstruktur per-media
7. Verify opsi lama "📋 Salin ke Clipboard" tetap jalan

### Test 2: Bundle kosong
1. Buat bundle tanpa anggota
2. Klik `⋯` → "📋 Salin Link + Keterangan"
3. Toast: "Bundle kosong — tidak ada yang disalin" (graceful, tidak crash)

### Test 3: Regression
1. Verify semua fitur lain tetap jalan: capture, AI chat, sync cloud, folder, pin, archive
2. Verify menu `⋯` untuk tipe lain (prompt, link, screenshot) tidak punya opsi "Salin Link + Keterangan" (hanya bundle)
3. Tidak ada error di DevTools console

## Compatibility

- **PWA**: version `1.13.1`
- **Paritas**: Firefox v3.21.4-firefox (FASE 1) + Chrome v3.21.4-chrome (FASE 2)
- Code 100% ported dari addon — `buildBundleMediaReport` + `stripHtmlForPreview` byte-identik
- PWA-specific: clipboard fallback `execCommand('copy')` (browser lama), notes cache via `window.__rfAllNotes`

— *Implemented by Super Z on 2026-08-19, FASE 3 PWA.*
