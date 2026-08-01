# Findings — Keputusan Teknis (RecallFox PWA)

> Temuan & keputusan teknis proyek. Diisi/divalidasi saat Planning.
> Proyek sudah berjalan — ini snapshot tech stack yang TERPASANG.

## 1. Tech Stack (terpasang)
| Layer | Pilihan | Keterangan |
|---|---|---|
| Frontend | Vanilla JS + Vite | `vite` ^5.4, `vite-plugin-pwa` ^0.20 |
| Bahasa | JavaScript (ES modules) | `"type": "module"` |
| PWA | vite-plugin-pwa | Service worker, offline |
| Backend/Sync | Supabase | `@supabase/supabase-js` ^2.45 |
| Storage | IndexedDB (`idb` ^8.0) | Local cache |
| Build | `npm run dev/build/preview` | Vite |
| Hosting | Vercel | `.vercel/` di .gitignore |

## 2. Arsitektur
```
┌────────────────────────────┐
│ RecallFox PWA (Vite+JS)    │
│  - media capture/scan      │
│  - vault + search/filter   │
│  - notes (rich text)       │
└──────────┬─────────────────┘
           │ sync penuh
           ▼
┌────────────────────────────┐
│ Supabase (PostgreSQL)      │
│ vault_items, notes, media, │
│ settings, profiles         │
└────────────────────────────┘
```

## 3. Fitur Utama (sudah ada)
- Media: foto kamera, scan dokumen (OpenCV.js), annotate, auto-compress, batch download.
- Vault: render semua tipe teks, search/filter/sort, favorite, batch mode, auto-refresh 10s.
- Notes: rich text (contenteditable), 12 warna, search/sort, view toggle, auto-sync.

## 4. Konvensi Kode
- Changelog: `CHANGELOG-v<versi>.md` per rilis; README memuat status stabil.
- Konvensi commit historis: `v<versi>: <deskripsi>` (bukan `build:`/`fix:` — catat ini).
- Jaga parity/sinkronisasi data dengan addon Firefox & Chrome (supaya tidak bentrok di Supabase).

## 5. Keputusan Penting
- Companion mobile, sync penuh via Supabase (bukan standalone).
- Vanilla JS (tanpa framework) — jangan rombak ke React/Vue tanpa keputusan tertulis.
