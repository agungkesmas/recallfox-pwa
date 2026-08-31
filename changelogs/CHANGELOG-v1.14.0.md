# CHANGELOG v1.14.0 — Concept v3: alat harian dulu, arsip tetap rapi

> "Porselen hangat + tinta + satu aksen iris. Alat paling sering dipakai naik jadi tab."

## Ringkasan

Redesign tampilan pertama besar sejak v1.x, berdasarkan Concept v3 (mockup
`recallfox-pwa-mockup-v3-modern.html` yang disetujui). **Fungsi, data, dan
schema Supabase TIDAK berubah** — ini murni navigasi + tampilan + 2 alat
local-first baru yang selama ini hanya ada di addon.

## Baru

### Tab Fokus — Pomodoro + RecallTape (local-first)
- Tab ke-3 dock menggabungkan dua alat harian paling sering dipakai (dari
  addon) dalam satu layar gelap dengan segmented switch **Timer | Tape**.
- **Pomodoro**: logika port 1:1 dari addon `lib/pomodoro.js` — preset
  25/5, 50/10, 52/17, 90/20 + custom (1–120 / 1–30 menit), long break 15
  menit tiap 4 siklus, ring SVG tipis, bell lembut (WebAudio, bisa dimatikan),
  state sticky: timer tetap jalan walau pindah tab/app ditutup (catch-up saat
  buka lagi), judul dokumen ikut countdown.
- **RecallTape**: parser port 1:1 dari addon `lib/tape.js` — teks pita ala
  CalcTape (`250000 Gaji`, `+ 50k Bonus`, `- 20rb Makan`, `* 2`, `/ 4`,
  `= Subtotal`, `+ 19% PPN`, `2,5jt`, `1.250.000`), hasil struk real-time,
  Copy (teks WhatsApp-friendly), simpan ke Vault sebagai Markdown (tag
  `tape`), contoh sekali klik. Auto-simpan sesi di perangkat (localStorage).
- Keduanya **tanpa sinkronisasi & tanpa perubahan schema** — sama seperti di
  addon, alat ini per-device. Teks pita kompatibel bolak-balik addon ↔ PWA.

### Navigasi 5-tab + default Catatan
- Dock: **Catatan · Media · Fokus · Vault · Akun** (ikon garis SVG, bukan emoji).
- Default buka app = **Catatan** (dulu Media) — sesuai prioritas pemakaian;
  Media & Vault tetap satu tap.
- FAB sheet "Tambah Baru" **tidak berubah fungsinya** (7 aksi capture).

## Tampilan (Concept v3)

- Palet: porselen `#f4f2ed`, tinta `#191714`, aksen iris `#6d3df5` (DNA brand
  tetap), ember `#ff6a55` (timer), amber `#e29d1f` (tape), sage `#33a06f`
  (break/berhasil).
- Font: Space Grotesk (judul + angka tabular) + Inter (UI) via Google Fonts,
  fallback font sistem saat offline.
- Kartu hairline 1px menggantikan kartu berbayang; dock melayang frosted;
  FAB kotak tinta radius 19; bottom sheet baris hairline.

## Tidak berubah (jaga-jaga non-disrupsi)

- Semua flow capture (kamera/galeri/scan/paste/upload), share-target, scan
  OpenCV, annotate, editor dokumen.
- Editor catatan tetap model saat ini (port engine task RecallNote = tahap 2).
- Sync Supabase, realtime, polling, offline queue, auth/session.
- Realtime/polling **sengaja tidak** me-re-render tab Fokus — timer tidak
  pernah ter-reset oleh sinkronisasi.

## Upgrade notes

- `localStorage` baru: `rf_pomo_state_v1`, `rf_tape_session` (keduanya
  local-first, tidak mengirim apa pun ke cloud).
