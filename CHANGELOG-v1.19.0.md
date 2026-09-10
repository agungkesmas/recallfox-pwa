# v1.19.0 — TEMP 1GB + NG AJI & OLAHRAGA DI STICKY STRIP

## Permintaan user

1. "maksimalkan saja litterbox sampe ke batas maksimal uploadnya"
2. "saya ingin ada ini di pwa nya - Ngaji 0 hal, Olahraga, Quran..., Tafsir...,
   Quran Kemenag..., YouTube Yoga, YouTube Cardio — jadi bisa di collapse
   seperti di addon juga, serta bisa disesuaikan situsnya apa aja di dalamnya"

## 1. Upload ⏳ Sementara: 2MB → 1GB (batas maksimal litterbox)

- `src/main.js`: `MAX_TEMP_BYTES = 1GB` untuk tujuan Sementara.
  Database tetap 2MB (perilaku lama). Validasi dua lapis: saat pilih file
  (sesuai tujuan aktif) + saat simpan (validasi ulang, antisipasi user ganti
  tujuan setelah pilih file).
- Copy UI: dropzone "maks 2MB Database · 1GB Sementara", destNote temp "Maks 1GB".

## 2. Ngaji & Olahraga di sticky strip (baru)

- Baru `src/lib/habits.js` (localStorage `rf_habits_v1`, pola prayer.js):
  default situs **disamakan addon** — Ngaji: Quran.com, Tafsir Web, Quran Kemenag;
  Olahraga: YouTube Yoga, YouTube Cardio. Maks 6 per kategori.
  Counter harian: `quranLog` (halaman) + `exerciseLog` (sesi), target default 1 hal.
- `src/components/sticky-strip.js`:
  - Bar: selalu tampil "📖 Ngaji N hal" + "🏃 Olahraga" (±✓) di depan sel shalat,
    bahkan saat shalat belum diaktifkan / jadwal gagal muat.
  - Detail: section baru dua `<details>` (collapse ala addon, default terbuka):
    counter (+1/-1 hal, +1/-1 sesi), grid link situs, tambah situs (prompt
    nama+URL+emoji), hapus situs (✕ + konfirmasi), reset ke bawaan.
  - Event `rf-habits-updated` → refresh bar otomatis. Detail scroll (max 70vh)
    supaya muat di HP.
- `src/styles/sticky.css`: styling section habits + bar scroll horizontal di ≤480px.
- `package.json` → 1.19.0.

## Validasi

- `npm run build` OK (vite, 487KB JS gzip 135KB).
- Manual: buka PWA → strip atas tampil "📖 Ngaji 0 hal · 🏃 Olahraga" →
  tap expand → dua collapse Ngaji/Olahraga → +1 halaman → bar update + ✓ →
  tambah/hapus situs → tersimpan di localStorage → reload tetap ada.
