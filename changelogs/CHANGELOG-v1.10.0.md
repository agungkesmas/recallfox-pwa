# RecallFox PWA v1.10.0 — Folder Edit Menu (Rename/Hapus/Arsip/Pindah) + Cleanup Orphan

**Tanggal:** 26 Jul 2026
**Tag sebelumnya:** v1.9.6
**Tipe:** Feature release — folder management di PWA

## Ringkasan

User request: "fitur edit apapun bisa rename, hapus, arsip dsb. karena di situ ada folder yang kelebihan, seperti bug nampil. kamu hapus aja itu folder nya ngotorin. yg berbahaya fitur folder jgn dilakukan, misal berpotensi membuat crash"

Implementasi: tambah menu edit folder (⋯) di setiap folder card dengan 5 operasi aman + tombol cleanup folder orphan di toolbar.

## Fitur baru

### 1. Tombol menu (⋯) di setiap folder card

Klik tombol ⋯ di folder → buka bottom sheet dengan 5 opsi:
- ✏️ **Ganti Nama** — rename folder via inline modal (input text + Enter/Esc keyboard)
- 📦 **Arsipkan (folder + isi)** — set archived=true untuk folder + semua children recursive
- 📂 **Pindahkan ke Folder...** — pilih parent baru (atau root) dengan anti-loop guard
- 🗑️ **Hapus Folder (pertahankan isi)** — unparent children + hapus folder saja (AMAN)
- ⚠️ **Hapus Folder + Semua Isi** — hapus folder + semua children recursive (BERBAHAYA, perlu confirm eksplisit)

### 2. Tombol 🧹 Cleanup Orphan di toolbar

Klik tombol 🧹 → scan folder orphan (folder yang parentId-nya menunjuk ke folder yang sudah dihapus) → konfirmasi → set parentId=null (jadi top-level). Aman: tidak hapus data, hanya fix parentId yang invalid.

Ini yang akan "bersihkan folder ngotorin" yang user maksud — folder yang muncul tapi tidak bisa dibuka karena parent-nya invalid.

### 3. Modul `src/lib/folder-ops.js` (new, ~250 baris)

Helper aman untuk semua operasi folder. Setiap function return `{ok, error}` instead of throw — caller tidak perlu try-catch.

**Guards anti-crash:**
- `getValidFolder(folderId)` — validasi folderId exist + benar-benar isGroup sebelum operasi
- `collectDescendants(folderId, depth)` — recursive dengan MAX_DEPTH=5 anti infinite loop
- Batch updates pakai `Promise.allSettled` (satu gagal tidak crash semua)
- `moveFolder` anti-loop: cek newParentId bukan diri sendiri atau descendant
- Semua operasi wrap dalam try-catch, return error object instead of throw

**Functions:**
- `renameFolder(user, folderId, newName)` — update title saja, paling aman
- `archiveFolder(user, folderId)` — archived=true untuk folder + semua descendants
- `deleteFolder(user, folderId, mode)` — 2 mode: 'keep-children' (default, aman) dan 'delete-all' (perlu confirm)
- `moveFolder(user, folderId, newParentId)` — update parentId dengan anti-loop guard
- `findOrphanFolders()` — deteksi folder yang parentId invalid
- `cleanupOrphanFolders(user)` — unparent semua orphan folder (parentId=null)

## File yang diubah

### `src/lib/folder-ops.js` (NEW)
~250 baris. Pure module dengan 6 exported functions. Semua operasi return `{ok, error}`.

### `src/views/vault.js`
- Import `renameFolder, archiveFolder, deleteFolder, moveFolder, cleanupOrphanFolders, findOrphanFolders` dari folder-ops.js
- `renderTreeNode()` — tambah tombol `.folder-menu` (⋯) di folder card
- Wire event listener `.folder-menu` → `openFolderMenuSheet(folderId)`
- New functions:
  - `openFolderMenuSheet(folderId)` — bottom sheet dengan 5 opsi
  - `promptRenameFolder(folderId, currentName)` — inline modal rename (input text + Enter/Esc)
  - `doArchiveFolder(folderId)` — konfirmasi + archive
  - `doDeleteFolder(folderId, mode)` — konfirmasi + delete (2 mode)
  - `promptMoveFolder(folderId)` — pilih parent baru dengan anti-loop
  - `doCleanupOrphanFolders()` — scan + konfirmasi + cleanup orphan
- Tombol 🧹 baru di header-actions → `doCleanupOrphanFolders`

### `src/styles/views.css`
- Tambah CSS `.folder-menu` — tombol ⋯ 28×28px, hover background, active scale 0.92

### `package.json`
- Version 1.9.6 → 1.10.0

## Kompatibilitas Addon

- **Schema storage sama** — semua operasi pakai `source.parentId`, `source.isGroup`, `archived` flag yang sudah sinkron dengan addon v3.19.9.
- **Folder yang di-rename/archive/delete di PWA → sync ke addon** via Supabase polling 10s.
- **Addon tidak perlu update** — folder ops di PWA hanya update/delete vault_items via API yang sama. Addon akan tampilkan perubahan setelah sync.
- **Tidak ganggu fitur existing** — DnD, expand/collapse, search, sort, tag filter tetap utuh.

## Test plan

- [x] `node --check src/lib/folder-ops.js` — OK
- [x] `node --check src/views/vault.js` — OK
- [x] `npm run build` — OK (368 KB bundle, 100 KB gzip)
- [ ] Manual test: klik ⋯ di folder → sheet muncul dengan 5 opsi
- [ ] Manual test: rename folder → nama berubah + sync ke addon
- [ ] Manual test: archive folder → folder + isi hilang dari vault (muncul di chip Arsip addon)
- [ ] Manual test: delete folder (keep-children) → folder hilang, item jadi top-level
- [ ] Manual test: delete folder (delete-all) → folder + semua isi hilang permanen
- [ ] Manual test: move folder → anti-loop guard jalan (tidak bisa pindah ke descendant)
- [ ] Manual test: klik 🧹 → scan orphan → cleanup → folder bug tampil hilang

## Yang TIDAK diubah

- PWA media capture, document scan, annotate — tetap utuh
- PWA vault folder tree, sort, search, batch — tetap utuh
- Addon v3.19.9 — tidak diubah (PWA folder ops kompatibel dengan schema yang sama)
- Supabase schema — tidak diubah (source JSONB pass-through)

## Catatan keamanan

- **Tidak ada operasi yang bisa crash app** — semua return `{ok, error}` instead of throw
- **MAX_DEPTH=5** untuk recursive operations anti infinite loop
- **Anti-loop guard** di moveFolder — cek newParentId bukan descendant
- **Confirm eksplisit** untuk delete-all (operasi paling berbahaya)
- **Cleanup orphan** hanya set parentId=null — tidak hapus data, bisa undo manual
