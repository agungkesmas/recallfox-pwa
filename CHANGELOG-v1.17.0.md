# RecallFox PWA v1.17.0 — Waktu Shalat & Puasa Sunnah dengan Strip Sticky ala Addon

## Permintaan user
> "perhatikan fitur shalat, puasa dsb di addon, coba letakkan fitur tersebut
> dengan model sticky seperti di addon nya sehingga bisa dilihat di halaman
> manapun di pwa nya"

PWA sebelumnya sama sekali belum punya fitur shalat/puasa. Versi ini memport
seluruh mesin fitur **Waktu Shalat** + **Puasa Sunnah** dari addon (v3.x) ke
PWA dan meletakkannya sebagai **strip sticky yang terlihat di SEMUA halaman** —
persis model `stripPrayer`/`stripFast` di popup addon: bar ringkas satu baris
yang selalu tampil, tap untuk membuka detail lengkap.

## Fitur baru

### 1. Strip sticky (komponen shell — di luar `#appMain`)
- **Terlihat di semua halaman** (Catatan/Media/Fokus/Vault/Akun) — dirender
  sekali di shell (`renderShell` → `mountStickyStrip()`), sehingga tidak ikut
  ter-replace saat navigasi antar view. Position `fixed` TOP, z-index 55
  (di atas dock 50, di bawah FAB 60 & bottom-sheet 100).
- **Bar aktif**: `🕌 [🌟] <Nama shalat> HH:MM −<countdown>` | `🌙 <puasa
  sunnah berikutnya> · <hari ini/besok/n hari lagi>` + chevron expand.
  Warna countdown ala addon: hijau (>10 mnt), amber (<10 mnt), merah (≤2 mnt).
- **Detail expandable** (max-height transition ala `.strip-detail` addon):
  lokasi + tanggal Hijriah, grid 6 waktu (Subuh/Terbit/Dzuhur/Ashar/Magrib/
  Isya, shalat berikutnya di-highlight iris), baris puasa hari ini + chips
  jadwal 14 hari ke depan, tombol **⚙️ Atur lokasi & pengaturan**.
- **Chip setup** sebelum diaktifkan: "🕌 Aktifkan Waktu Shalat & Puasa" — tap
  membuka kartu pengaturan (scroll otomatis via flag sessionStorage); tombol
  ✕ menutup permanen (localStorage dismiss, bisa dipercaya user).
- **State gagal muat**: "tap untuk coba lagi" (force refetch).
- Refresh: ticker 30 detik + `visibilitychange` + event custom
  `rf-prayer-updated` (dipicu kartu pengaturan).
- Layar ≤420px: sel puasa disembunyikan di bar (ala `.popup.w-sm` addon) —
  tetap ada di detail.

### 2. Kartu pengaturan "🕌 Waktu Shalat & Puasa" (view Akun)
- Toggle aktif/nonaktif strip.
- **📍 Pakai Lokasi GPS** (`navigator.geolocation` + reverse-geocode
  Nominatim → nama kota) atau **pencarian kota** (geocode Nominatim, Enter
  pun jalan).
- Format waktu **24 jam / 12 jam (AM/PM)**.
- Status live: tanggal Hijriah, shalat berikutnya + countdown, puasa
  berikutnya, waktu update terakhir.

### 3. Mesin diport 1:1 dari addon (pure module, tanpa dependensi baru)
- `src/lib/salahtime.js` — Aladhan API metode **Muhammadiyah** (Fajr/Isha
  18°, school Shafi), timeout 8 detik, `getNextPrayerIncludingSunnah`
  (Ishraq/Dhuha/Awwabin/Tahajud), `getLastPassedPrayer`, `getSunnahPrayers`,
  `formatCountdown`, `to12Hour`, geocode/reverse-geocode Nominatim.
- `src/lib/islamicCalendar.js` — kalender Hijriah + puasa sunnah:
  Senin-Kamis, Ayyamul Bidh (13-15), Tasua, Asyura, Arafah, 6 Syawal;
  parser string Hijriah berdiakritik (Rabīʿ al-Awwal dll).
- `src/lib/prayer.js` (baru) — store `localStorage rf_prayer_settings_v1`
  (pola konsisten `rf_*` per-device PWA), cache jadwal per tanggal UTC,
  `ensurePrayerTimes` dengan **in-flight dedup** (anti double-fetch) dan
  **re-read sebelum save** (anti lost-update bila user mengubah setting
  saat fetch berjalan), `buildStripModel`.
- `src/components/sticky-strip.js` (baru) — komponen strip + detail.
- `src/styles/sticky.css` (baru) — bahasa visual Concept v3 (frosted blur,
  hairline 1px, radius 16, aksen iris), dimuat terakhir.

### 4. Perbedaan sadar vs addon
- Adzan audio belum diport (butuh interaksi user di mobile browser);
  kandidat iterasi berikutnya.
- Settings per-device (localStorage), tidak di-sync cloud — konsisten dengan
  pola settings PWA saat ini (Pomodoro, urutan catatan, dst).

## Validasi
- **Uji Node 23/23 PASS** (`scripts/test_prayer_pwa.mjs`): mesin shalat
  (next wajib & sunnah per jam uji, fallback Subuh besok, last-passed,
  format countdown/12h), kalender Hijriah (parse berdiakritik, Ayyamul Bidh,
  Senin-Kamis), store settings persist, + **fetch live Aladhan OK**
  (Maghrib 17:37 Yogyakarta, hijri terbaca).
- **E2E Playwright 25/25 PASS** (`scripts/e2e_sticky_pwa.py`, vite dev +
  Chromium 390×844 + GPS mock, jaringan Aladhan & Nominatim LIVE):
  mount di shell, position fixed, z-index 55, chip setup → navigate
  settings + flag scroll, dismiss→hidden, jadwal real tampil, has-sticky
  padding, expand/collapse detail (grid 6 cell, hijri, lokasi, puasa),
  format 12h→AM/PM, kartu pengaturan asli (renderSettings), toggle,
  **cari kota Bandung via Nominatim real → jadwal Bandung, strip ikut
  berubah**, 0 pageerror.
- Screenshot verifikasi visual: strip setup / aktif / expanded
  (`pwa-strip-*.png`) — konten view tidak tertutup (padding-top 68px),
  FAB & dock melayang tidak bergeser.
- `vite build` OK (precache 14 entri; tanpa dependensi baru).
- Perbaikan akar masalah saat E2E: (1) lost-update — fetch yang resolve
  belakangan menimpa setting baru → kini re-read sebelum save + in-flight
  dedup; (2) fresh-user kini melihat chip setup (sebelumnya tersembunyi);
  (3) nama lokasi hasil geocode di-trim per bagian.
