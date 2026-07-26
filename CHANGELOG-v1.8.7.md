# RecallFox PWA v1.8.7 — Android Share Sheet Integration

**Tanggal:** 26 Jul 2026
**Tag sebelumnya:** v1.8.6-stable
**Tipe:** Feature release — PWA muncul di menu Share Android

## Ringkasan

RecallFox PWA sekarang muncul di menu Share Android. User share link/teks dari app mana pun (browser, news app, chat app, dll) → langsung masuk vault RecallFox sebagai item baru. Tidak perlu buka PWA manual + copy-paste.

## Implementasi

### 1. Manifest `share_target` (vite.config.js)

```js
share_target: {
  action: '/share-target',
  method: 'GET',
  enctype: 'application/x-www-form-urlencoded',
  params: {
    title: 'title',
    text: 'text',
    url: 'url'
  }
}
```

Spec: https://developer.chrome.com/docs/web-share-target/

`method: 'GET'` dipilih supaya service worker bisa intercept sebagai navigation route (tidak butuh POST handler di SW). Android akan buka URL:
```
https://recallfox-pwa.vercel.app/share-target?title=...&text=...&url=...
```

### 2. Handler `src/share-target.js` (new file, ~150 baris)

- `handleShareTarget(url, navigateTo)` — parse query params, tentukan tipe item, simpan via Supabase.
- `processPendingShare(navigateTo)` — proses share yang tertunda (saat user belum login saat share).
- `createShareItem(user, payload)` — buat vault item langsung via supabase upsert (karena sync.js tidak expose generic createItem).

**Logika tipe item berdasarkan content:**

| Content | Tipe item | Penjelasan |
|---------|-----------|------------|
| Ada URL | `link` | Simpan linkUrl + title + text sebagai body |
| Text > 100 chars | `context` | Konteks/latar belakang, title dari first line |
| Text pendek | `prompt` | Prompt teks untuk AI |
| Hanya title | `prompt` | Title = body |

Tag otomatis: `['shared']` supaya user bisa filter item yang di-share.
Source: `{ capturedAt, device: 'pwa-share', shareSource: 'android-share-sheet' }`.

### 3. Wire ke `src/main.js`

- `init()` cek URL path — kalau `/share-target`, panggil `handleShareTarget()` setelah app ready.
- Clean URL via `window.history.replaceState()` supaya refresh tidak re-trigger share.
- `onAuthChange()` — setelah login, proses pending share (kalau user share saat belum login).
- Setelah share sukses, navigate ke vault view + toast konfirmasi.

### 4. Auth handling

- **User sudah login:** share langsung diproses → item masuk vault → toast "✓ Tersimpan ke vault: {title}".
- **User belum login:** share disimpan ke `sessionStorage.rf_pending_share` → redirect ke login → setelah login berhasil, `processPendingShare()` proses share yang tertunda.

## File yang diubah

- `package.json` — version 1.8.6 → 1.8.7.
- `vite.config.js` — tambah `share_target` di manifest VitePWA plugin.
- `src/main.js` — import `handleShareTarget` + `processPendingShare`, cek `/share-target` route di `init()` + `onAuthChange()`.

## File baru

- `src/share-target.js` — handler untuk incoming share (~150 baris).

## Test plan

- [x] `node --check src/share-target.js` — OK
- [x] `node --check src/main.js` — OK
- [x] `node --check vite.config.js` — OK
- [x] `npm run build` — OK (344 KB bundle, 93 KB gzip)
- [x] `dist/manifest.webmanifest` berisi `share_target` — verified
- [ ] Manual test Android: install PWA → buka browser/news app → share link → pilih RecallFox → item muncul di vault
- [ ] Manual test: share teks panjang dari chat app → masuk sebagai context item
- [ ] Manual test: share saat belum login → login → item muncul di vault (pending share processed)
- [ ] Manual test desktop: buka `https://recallfox-pwa.vercel.app/share-target?title=Test&text=Hello` → item masuk vault

## Kompatibilitas

- **Tidak ganggu fitur existing** — semua perubahan additive.
- **Addon tidak terpengaruh** — share_target hanya PWA (Android mobile).
- **Sync via Supabase** — item share masuk ke table `vault_items` dengan tag `['shared']`, langsung sinkron ke addon via polling/realtime yang sudah ada.
- **Cross-device:** item yang di-share dari Android → tampil di addon vault (setelah sync 10s).

## Yang TIDAK diubah

- PWA media capture, document scan, annotate — tetap utuh.
- PWA vault folder tree, sort, search — tetap utuh.
- Addon v3.19.5 (search bar sidebar) — tetap utuh.
- Supabase schema — tidak diubah (item share pakai schema yang sama dengan item biasa).

## Catatan

- Manifest hanya support 1 `share_target`. Untuk image share (file upload), user tetap pakai FAB menu → "Dari Galeri" (sudah jalan via input file).
- Browser support: Chrome Android 75+, Edge Android, Samsung Internet, Firefox Android 92+. iOS Safari tidak support Web Share Target (Apple limitation).
- Setelah deploy, user perlu re-install PWA (atau tunggu SW auto-update) supaya manifest baru dengan `share_target` terdaftar di Android.
