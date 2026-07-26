# RecallFox PWA

> Cross-device media + notes + vault sync untuk RecallFox — Firefox addon all-in-one untuk produktivitas AI + kehidupan Muslim Indonesia.

## Apa ini?

RecallFox PWA adalah Progressive Web App yang menjadi companion mobile untuk addon Firefox RecallFox. Sinkronisasi penuh via Supabase — semua data yang dibuat di addon (prompt, konteks, snapshot, screenshot, dokumen, link, bundle, catatan) otomatis muncul di PWA dan sebaliknya.

## Fitur

### 📸 Media
- Capture foto dari kamera HP
- Scan dokumen multi-halaman (CamScanner-style dengan auto-crop + edge detection via OpenCV.js)
- Annotate gambar (kotak, panah, teks, freehand)
- Auto-compress sebelum upload (JPEG 1920px q0.85 — hemat bandwidth)
- Batch download + copy URL untuk AI sites yang tidak support paste gambar

### 🗂️ Vault (v1.7.0)
- Render semua tipe teks: prompt, context, snapshot, link, bundle
- Search + filter by type + sort (recent/favorite/title)
- Favorite toggle, copy, delete per item
- Batch mode: multi-select copy/delete
- Auto-refresh via polling 10 detik

### 📝 Catatan
- Rich text editor (contenteditable + paste sanitize)
- 12 warna catatan
- Search + sort + view toggle (list/grid)
- Auto-sync ke cloud

### ⚙️ Akun
- Login via Supabase Auth (email/password atau Google OAuth)
- Statistik vault per tipe
- Sync queue retry
- Logout

## Tech Stack

- **Vanilla JS** — zero framework, zero dependencies (kecuali `@supabase/supabase-js` + `idb`)
- **Vite** — build tool + dev server
- **vite-plugin-pwa** — Service Worker (Workbox) untuk offline mode
- **Supabase** — backend (PostgreSQL + Auth + Storage + Realtime)
- **IndexedDB** — offline cache + sync queue
- **OpenCV.js** — edge detection untuk document scan (lazy load 8MB dari CDN)

## Deployment

PWA di-deploy ke Vercel: https://recallfox-pwa.vercel.app

```bash
npm install
npm run build
npx vercel --prod --token <vercel-token>
```

## Sinkronisasi

- **Online-first**: Setiap operasi langsung upload ke Supabase
- **Offline cache**: IndexedDB sebagai cache untuk read offline
- **Retry queue**: Operasi yang gagal di-queue, retry otomatis setiap 30 detik
- **Polling 10 detik**: Deteksi perubahan dari device lain
- **Realtime WS**: Subscribe sebagai backup (tidak diandalkan — infrastruktur Supabase bermasalah)

## Akun & Data

Pakai kredensial Supabase yang sama dengan addon Firefox:
- **Project URL**: `https://qmwofsfpxjptpyvncylp.supabase.co`
- **Anon Key**: `sb_publishable_9gyUUsJUf1RZld9dgny3HA_o74o2mKv` (public-safe)

Login dengan akun yang sama yang dipakai di addon → semua data sinkron otomatis.

## Versi

- **v1.7.0**: Vault teks di HP — render prompt, context, snapshot, link, bundle
- **v1.6.4**: Viewer navigator + edit title + edit annotation
- **v1.6.2**: Auto-compress screenshot sebelum upload
- **v1.5.2**: Notes sync fix + search input fix
- **v1.4.0**: OpenCV.js untuk document scan

## Repo Terkait

- **Addon Firefox**: https://github.com/agungkesmas/recallfox
- **Blueprint (PRD)**: https://github.com/agungkesmas/recallfox-blueprint (private)

## Lisensi

MIT
