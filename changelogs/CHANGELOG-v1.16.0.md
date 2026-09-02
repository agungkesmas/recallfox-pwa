# v1.16.0 — Task Bullet ala Addon di Catatan PWA + Buat Password untuk Login Google

## 1. Task Bullet Engine (port RecallNote addon `notes-cs.js`)
**Laporan user:** *"waktu mengetik di note yang ada di pwa tidak otomatis mengkonver ke
bentuk bullet dengan mengetik '>' — pelajari perilaku yang ada di addon dan buat perubahan."*

Perilaku addon (notes-cs.js v3.24.2/v3.24.3) dipelajari dari kode lalu di-port ke editor
catatan PWA (`src/views/notes.js`, pendekatan Chrome-native tanpa shim Firefox):

- **Ketik `>` di awal baris** → baris jadi subtask: radio + indent, marker `>` DITELAN
  (bukan jadi teks); **`>x`** → selesai (radio hijau + coret).
- **Spasi pertama** setelah konversi ikut ditelan (anti `>  teks` dobel spasi — serialisasi
  tetap `> teks`, persis addon `rfJustConv`).
- **`>` redundan di dalam baris task** ditelan in-place (`>`/`> ` tetap task, `>x`/`>x `
  sekalian selesai — paritas v3.24.3).
- **Enter** di baris task = baris task baru ber-radio (ala bullet Word) sampai **Enter di
  bullet kosong** atau **Backspace di depan** = keluar mode; Backspace di depan baris done =
  un-done dulu (paritas `rfSplitAtCaret`/keydown addon).
- **Klik gutter kiri (≤25px)** = toggle radio; selesai → coret + pindah ke dasar deret;
  aktif lagi → tepat sebelum blok done pertama (paritas `rfToggleDone`).
- **INTEROP ADDON**: baris task/done diserialisasi sebagai teks `> teks` / `>x teks`
  (identik `serializeTaskLine` addon), dibungkus `<div>`; class CSS tidak disimpan —
  di-rederive dari teks setiap editor dibuka (`rfRederive` + normalisasi root-flow ala
  `rfRebuild`), jadi catatan buatan floating addon ikut tampil ber-radio di PWA.
- **Blok kaya tidak disentuh**: tabel/heading/list dari paste tidak pernah diproses engine
  (hanya div/p top-level tanpa nested block).

### Tiga akar bug yang ditemukan & dibereskan saat validasi (semua khas contenteditable)
1. **NBSP**: Chrome memasukkan spasi ketikan sebagai `&nbsp;` (U+00A0) di ujung baris →
   marker `'> '` tak pernah cocok. Parser kini mengakui `>\u00A0` / `>x\u00A0` dan fase
   telan-spasi menerima nbsp.
2. **Kanonikalisasi caret**: text node ber-length 0 & div kosong membuat caret
   dinormalisasi Chrome ke ujung baris SEBELUMNYA (ketikan mendarat di baris salah).
   Baris kosong engine kini dibentuk persis native: `<div><br></div>` + caret element-offset
   `(div,0)`; `rfPlaceCaretAtChar` melewati text node kosong.
3. **Split manual menyentuh baris plain**: Enter kini hanya di-intercept di baris
   task/done; baris plain memakai perilaku default Chrome (tanpa regresi).

CSS radio = `::before` pseudo (nol elemen non-editable di alur teks — paritas addon
v3.24.2), palet light-theme addon (border `#64748B`, done `#10B981` + coret).

## 2. Buat Password untuk user login Google (`src/auth.js`, `src/views/settings.js`)
**Laporan user:** *"pwa tidak bisa membuat password baru untuk pengguna baru yang login
menggunakan tombol google, adanya perubahan password aja."*

- **Akar**: form lama selalu memverifikasi password lama via `signInWithPassword` — user
  Google tidak punya password, jadi PASTI gagal "Password lama salah" dan tak pernah bisa
  memiliki password.
- **Fix**: deteksi identitas via `user.identities` (`userHasPassword` — tanpa identity
  `email` = belum punya password; fallback aman = anggap punya). Kartu keamanan berubah
  jadi **"🔐 Buat Password"**: tanpa field password lama, langsung new+confirm, submit via
  `createPasswordForOAuthUser` (`updateUser({password})` pada session aktif — standar
  Supabase untuk menambah password ke akun OAuth). Sukses TIDAK memaksa logout (session
  Google tetap valid) + pesan "kamu juga bisa login pakai email + password".
- User email/password biasa: form "Ubah Password" lama utuh (regresi teruji).

## Validasi
Playwright headless real-event (`scripts/notes_password_test_1160.js`, Supabase diblokir
agar data produksi aman) — **10/10 PASS**:
konversi `> `+marker telan, Enter lanjut bullet, `>x` → selesai, Enter di done → plain,
Backspace keluar mode, klik radio toggle+reorder, simpan → `>x beli susu` dkk di
IndexedDB, buka ulang → radio ter-rederive; UI Buat Password (Google) / Ubah Password
(email) keduanya benar. Build vite OK.
