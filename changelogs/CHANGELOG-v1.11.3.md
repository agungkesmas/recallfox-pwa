# v1.11.3 — Standarisasi auto-select di semua modal rename

> **Tanggal:** 2026-07-29
> **Tipe:** Fix UX
> **Tag:** `v1.11.3`, `v1.11.3-stable`

## Ringkasan

Semua modal yang berhubungan dengan rename / nama file sekarang **auto-select
teks saat modal dibuka** — user langsung bisa ketik untuk menimpa nama default,
tanpa perlu blok manual + delete.

v1.11.2 sudah menambahkan auto-select **on focus** di modal anotasi. v1.11.3
menyempurnakan dengan auto-select **on open** + menerapkan pola yang sama ke
semua modal rename lainnya supaya UX konsisten.

## Perubahan

### 1. Modal anotasi / capture screenshot (`src/annotate.js`)
- v1.11.2: `titleInput.addEventListener('focus', ...select())` — kerja kalau
  user klik input dulu.
- **v1.11.3:** Tambah `setTimeout(() => { titleInput.focus(); titleInput.select(); }, 120)`
  pada saat modal baru dibuka → user tidak perlu klik dulu untuk mulai menimpa
  nama default.
- Enter pada title input = trigger tombol done (✓).

### 2. Modal edit dokumen (`src/document.js`)
- **SEBELUM:** Title input tidak auto-focus / auto-select.
- **SESUDAH:** Auto-focus + auto-select saat modal dibuka + re-select on focus +
  Enter = trigger tombol done.

### 3. Modal edit dokumen v1.4 (`src/document-editor-v14.js`)
- Sama seperti `src/document.js` — auto-focus + auto-select + Enter = done.

### 4. Edit vault item sheet (`src/views/vault.js` ~line 1215)
- **SEBELUM:** Title input `#editTitle` tidak auto-focus / auto-select.
- **SESUDAH:** Auto-focus + auto-select + Enter = trigger #editSave.

### 5. Rename folder sheet (`src/views/vault.js` ~line 770)
- v1.11.2 sudah `input.focus(); input.select();` saat sheet dibuka.
- **v1.11.3:** Tambah re-select on focus + Enter = trigger tombol save
  (kalau user klik keluar lalu klik balik ke input, behavior tetap konsisten).

### 6. Note editor modal (`src/views/notes.js` line 343)
- **SEBELUM:** Title input `#noteTitle` tidak auto-focus / auto-select.
- **SESUDAH:** Auto-focus + auto-select + re-select on focus.

### 7. Share-target modal (`src/share-target.js` line 194)
- **SEBELUM:** Title input `#shareTitleInput` tidak auto-focus / auto-select.
- **SESUDAH:** Auto-focus + auto-select + Enter = trigger save.

## Standar yang sekarang seragam di semua modal

```js
// 1. Re-select on focus (kalau user klik keluar lalu klik balik)
titleInput.addEventListener('focus', () => {
  setTimeout(() => titleInput.select(), 0);
});
// 2. Auto-select saat modal dibuka
setTimeout(() => {
  try { titleInput.focus(); titleInput.select(); } catch (e) {}
}, 120);
// 3. Enter = save (untuk modal yang punya tombol save/done)
titleInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); saveBtn?.click(); }
});
```

## Modal yang sekarang sudah auto-select

| Lokasi | File | Behavior |
|---|---|---|
| Annotate / screenshot capture | `src/annotate.js` | ✅ focus + select on open + Enter=done |
| Document editor (lama) | `src/document.js` | ✅ focus + select on open + Enter=done |
| Document editor v1.4 | `src/document-editor-v14.js` | ✅ focus + select on open + Enter=done |
| Edit vault item sheet | `src/views/vault.js` (#editTitle) | ✅ focus + select on open + Enter=save |
| Rename folder sheet | `src/views/vault.js` (#renameInput) | ✅ focus + select on open + Enter=save |
| Note editor modal | `src/views/notes.js` (#noteTitle) | ✅ focus + select on open |
| Share-target modal | `src/share-target.js` (#shareTitleInput) | ✅ focus + select on open + Enter=save |

## Catatan teknis

- Auto-select dijalankan via `setTimeout(..., 120ms)` supaya DOM sudah
  ter-render & animasi modal selesai sebelum `focus()` dipanggil.
- Re-select on focus via `setTimeout(..., 0)` supaya select tidak di-cancel
  oleh event focus itu sendiri di beberapa browser.

## Test plan

- [ ] Buka PWA → tap kamera/gallery → pilih gambar → modal anotasi muncul →
      nama default "HP Capture ..." terblok → ketik "foto-test" → Enter →
      tersimpan ke vault dengan title "foto-test".
- [ ] Buka PWA → tap dokumen → capture → modal editor dokumen muncul →
      "Dokumen ..." terblok → ketik "ktp-scan" → Enter → tersimpan.
- [ ] Buka PWA → vault → tap folder → rename → nama folder lama terblok →
      ketik nama baru → Enter → tersimpan.
- [ ] Buka PWA → vault → tap item → edit → judul lama terblok → ketik judul
      baru → Enter → tersimpan.
- [ ] Buka PWA → notes → tap catatan → judul lama terblok → ketik judul baru.
- [ ] Share URL ke PWA dari browser lain → modal share muncul → judul terblok.
