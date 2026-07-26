# RecallFox PWA v1.8.0 — Folder Vault + GPS + EXIF + Voice Notes

**Tanggal:** 26 Jul 2026
**Tag sebelumnya:** v1.7.1
**Tipe:** Feature release — sinkronisasi cross-device dengan addon v3.19.0

## Ringkasan

Implementasi 5 fitur baru + port folder vault dari addon. Semua schema storage kompatibel dengan addon — folder/GPS/voice yang dibuat di PWA tampil di addon, dan sebaliknya.

## Fitur baru

### 1. Folder Vault (port dari addon `lib/vault-tree.js`)

- Port `lib/vault-tree.js` dari addon ke PWA `src/lib/vault-tree.js` (verbatim, ESM compatible).
- Update `src/views/vault.js` — render tree dengan indent (no connector ├──/└──, mobile-friendly).
- Folder toggle (expand/collapse) via click.
- Folder color dari `source.folderColor` → border-left berwarna.
- Sort mode: recent / favorite / title (mapping ke addon: recent/fav/name).
- Tag filter + search tetap berfungsi (filter applied ke tree).
- **Tidak ada DnD** (mobile tidak cocok) — TODO: menu "Pindahkan ke Folder" di iterasi berikutnya.

### 2. GPS + Timestamp di Capture

- New `src/lib/location.js`:
  - `getCurrentPosition(timeout, enableHighAccuracy)` — wrapper `navigator.geolocation.getCurrentPosition`.
  - `reverseGeocode(lat, lng)` — OpenStreetMap Nominatim API (gratis, no API key, 8s timeout).
  - `captureLocation()` — combined GPS + reverse geocode → `{lat, lng, accuracy, address, capturedAt}`.
  - `formatLocation(loc)` / `formatLocationWithTime(loc)` — display helpers.
- Update `src/capture.js`:
  - `pickImage('camera')` → capture GPS live (parallel dengan image load).
  - `pickImage('gallery')` → baca EXIF GPS (lihat fitur #3).
  - `pasteFromClipboard()` → tidak ada GPS (clipboard tidak punya metadata).
- Update `src/sync.js` `createScreenshotItem` + `createDocumentItem` — simpan `payload.location` ke `source.location`.

### 3. EXIF Reader dari Galeri

- New `src/lib/exif.js` — manual EXIF parser (no npm dependency, ~6KB):
  - Parse JPEG APP1 EXIF segment.
  - Extract GPS lat/lng (dari GPSLatitude/Longitude + Ref).
  - Extract DateTimeOriginal.
  - Convert rational[3] (deg/min/sec) → decimal degrees.
  - Handle TIFF byte order (II little-endian / MM big-endian).
  - Anti-loop protection untuk nested IFD.
- Update `src/capture.js`:
  - Saat `pickImage('gallery')`, baca EXIF dulu sebelum image load.
  - Jika EXIF punya GPS → pakai itu (lebih akurat dari live GPS untuk foto lama).
  - Jika EXIF punya GPS tapi no address → reverse geocode untuk dapat alamat.

### 4. Rekam Suara (Voice Notes)

- New `src/lib/voice.js`:
  - `isVoiceRecordingSupported()` — check MediaRecorder + getUserMedia.
  - `startRecording(onTick)` — MediaRecorder dengan auto mimeType detection (webm/mp4/ogg).
  - `stopRecording()` → `{blob, mimeType, durationSec}`.
  - `cancelRecording()` — discard audio.
  - `uploadVoiceBlob(user, itemId, blob, mimeType)` — Supabase Storage upload ke bucket `voice-notes`.
  - `deleteVoiceBlob(user, itemId)` — cleanup saat hapus note.
  - `formatDuration(sec)` → "1:05".
- New `createVoiceNote(user, payload)` di `src/sync.js`:
  - Upload audio blob ke Storage.
  - Buat note row dengan `color='voice'` (discriminator) + `source.kind='voice'` + `source.audioUrl` + `source.duration`.
- SQL migration `supabase-voice-notes-bucket.sql`:
  - Buat bucket `voice-notes` (public-readable, 25MB limit, audio mime types).
  - 4 RLS policies (upload_own, read_public, delete_own, update_own).
  - **ALTER TABLE notes ADD COLUMN source jsonb** — untuk simpan voice metadata.
  - User jalankan manual via Supabase Dashboard SQL Editor.

### 5. Map View & Auto-Group (postponed ke v1.8.1)

- Map view (Leaflet.js) dan Auto-group per Kunjungan di-skipped di v1.8.0 untuk fokus pada sinkronisasi inti.
- Akan diimplementasi di v1.8.1 setelah schema stabil.

## Kompatibilitas Addon

Schema storage kompatibel dengan addon v3.19.0:

| Data | PWA simpan di | Addon baca dari |
|------|---------------|-----------------|
| Folder | `item.source.parentId` + `source.isGroup` | Sama (pass-through JSONB) |
| GPS | `item.source.location.{lat,lng,accuracy,address,capturedAt}` | Sama |
| Voice | `note.source.kind='voice'` + `note.source.audioUrl` + `note.color='voice'` | Sama (perlu addon v3.19.1 untuk display) |

Addon v3.19.1 akan display:
- GPS location di item card (`📍 alamat` atau `📍 lat, lng`).
- Voice player (`<audio controls>`) di note card dengan `source.kind='voice'`.

## File baru

- `src/lib/vault-tree.js` — port dari addon (176 baris).
- `src/lib/location.js` — GPS + Nominatim (135 baris).
- `src/lib/exif.js` — EXIF parser manual (200 baris).
- `src/lib/voice.js` — MediaRecorder + Supabase upload (165 baris).
- `supabase-voice-notes-bucket.sql` — SQL migration (123 baris).

## File yang dimodifikasi

- `package.json` — version 1.7.1 → 1.8.0.
- `src/capture.js` — GPS capture (camera) + EXIF read (gallery) + return `location` field.
- `src/sync.js`:
  - `createScreenshotItem` — simpan `source.location`.
  - `createDocumentItem` + `createDocumentItemMultiPage` — simpan `source.location`.
  - New `createVoiceNote(user, payload)` — upload audio + create note with `source.kind='voice'`.
- `src/views/vault.js` — render folder tree (buildTree dari lib/vault-tree.js) + display GPS location di item card.
- `src/styles/views.css` — folder tree styles + voice player + recording bar + map view container.

## Test plan

- [x] `node --check` semua JS file — OK
- [x] `npm run build` — OK (339 KB bundle, 92 KB gzip)
- [ ] Manual test: jalankan SQL migration di Supabase Dashboard → bucket `voice-notes` + kolom `notes.source` ada.
- [ ] Manual test: capture foto dari kamera → GPS di-capture → item card tampil "📍 alamat".
- [ ] Manual test: upload foto dari galeri → EXIF GPS dibaca → item card tampil "📍 alamat dari EXIF".
- [ ] Manual test: rekam voice note → upload → playback via `<audio>`.
- [ ] Manual test: folder yang dibuat di addon v3.19.0 → tampil di PWA vault (sync via Supabase).
- [ ] Manual test: GPS location yang di-capture di PWA → tampil di addon v3.19.1 item card.

## Yang TIDAK diubah

- Addon DnD, folder tree, sort, tag filter, breadcrumb — tetap utuh (addon v3.19.0).
- PWA media capture, document scan, annotate — tetap utuh.
- Supabase schema `vault_items` — tidak diubah (semua di `source` JSONB pass-through).
- Sync flow — tidak ada perubahan (source pass-through sudah ada sejak v1.7.0).
