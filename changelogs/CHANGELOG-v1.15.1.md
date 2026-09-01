# CHANGELOG v1.15.1 — RecallTape: Fix Keyboard Ponsel (IME)

## Masalah
User melaporkan perilaku RecallTape PWA tidak sama dengan floating RecallTape
addon: "ketik 1000 kemudian pencet + atau - atau apapun simbol matematika bagi
kali dsb itu langsung ganti baris ke bawah, baru ketik angka lagi, baru enter
nanti keluar hasil" — di PWA tidak terjadi.

## Akar Masalah (terbukti probe browser nyata)
Port v1.15.0 menangkap interaksi lewat `keydown` (`e.key === '+'`), persis
seperti addon. Tapi addon hanya berjalan di DESKTOP (ekstensi Chrome/Firefox,
keyboard fisik). Di PWA yang dibuka di PONSEL, keyboard virtual
(GBoard/Samsung/iOS) mengirim teks lewat IME:

- `keydown` datang sebagai `e.key = "Unidentified"` (bukan `'+'`)
- teks datang lewat event `input`/`beforeinput` (`inputType: 'insertText'`,
  `insertLineBreak`, atau `insertCompositionText`)

Akibatnya di ponsel: ketik `1000` → tanpa auto-prefix `+   `; tekan `+` →
tidak pindah baris (`1000+` inline); Enter → tidak menghitung. Uji headless
sebelumnya (T0–T10) tidak menangkapnya karena memakai
`dispatchEvent(new KeyboardEvent(...))` yang memanggil handler langsung,
bukan mensimulasikan input perangkat nyata.

Bukti probe (Playwright, event tepercaya):
- `keyboard.type('1000')` (desktop) → `+   1000` lalu `+` → pindah baris ✅
- `keyboard.insertText('1000')` (jalur IME/ponsel) → `1000` tanpa prefix,
  `+` → `1000+` inline ❌

## Perbaikan (src/views/tape.js)
1. **Satu pintu BEFOREINPUT** — auto-format & Enter=hitung kini ditangkap di
   event `beforeinput` (InputEvent; didukung semua browser modern, desktop +
   ponsel; bisa `preventDefault`):
   - `insertText` 1 char digit pada baris kosong di ujung baris → sisip
     `+   <digit>` (auto-prefix, paritas `handleAutoFormatKey` addon)
   - `insertText` 1 char operator (`+ - * /`) pada baris berisi di ujung
     baris → sisip `\n<op>   ` (langsung pindah baris — perilaku inti)
   - `insertLineBreak` (Enter) → ENTER = HITUNG OTOMATIS: reformat semua
     baris (operator kiri, angka rata-kanan AMT_WIDTH 12) + sisip `─────` +
     `→   total  📋` (paritas `handleEnterKey` addon)
   - `keydown` kini hanya memegang Ctrl/Cmd+Enter (simpan ke Catatan) dan
     penanda Shift+Enter (InputEvent tidak menjamin modifier state → flag
     `__rfShiftEnter` dari keydown, yang selalu mendahului beforeinput)
2. **Jaring pengaman IME composition** — `preventDefault` diabaikan spesifikasi
   untuk `insertCompositionText`; keyboard yang meng-commit operator lewat
   komposisi ditanggung `repairInlineOp`: pola yang tak mungkin muncul di tape
   terformat (`1000+` — angka berakhir operator inline) diperbaiki menjadi
   `1000\n+   ` saat `compositionend`/`input`. Selama komposisi aktif, input
   dibiarkan (mengubah nilai di tengah komposisi merusak IME).
3. **Atribut editor anti-IME bermasalah** — `autocapitalize="off"`,
   `autocomplete="off"`, `autocorrect="off"`, `inputmode="text"` (spellcheck
   sudah off sejak v1.15.0).
4. Regresi dijaga: Shift+Enter = newline polos tanpa hitung; Enter di baris
   kosong/komentar = newline polos; catatan bebas diketik; backspace normal;
   paste/multi-char tidak diintercept; suffix k/rb/jt & persen `+ 10%` dihitung
   (contoh `+ 50k`, `- 10rb`, `+ 10%` → `44.000`); error bagi nol tampil di
   status bar.

## Validasi (real-browser Playwright, event tepercaya — bukan synthetic dispatch)
21/21 PASS (`scripts/tape_test_151.js`):
- A. Desktop: ketik `1000` → `+   1000`; `+` → pindah baris; alur
  `1000+2000-500` → Enter → `─────` + `→   2.500  📋` + status live ✓
- B. Mobile IME (insertText per karakter, tanpa keydown): semua perilaku sama
  persis dengan desktop ✓
- C. Composition: tak diutak-atik saat komposisi; setelah `compositionend`
  `1000+` → `1000\n+   ` ✓
- D. Regresi 10 kasus (Shift+Enter, baris kosong, suffix+percent, catatan,
  backspace, `*`, multi-char, atribut, error bagi nol) ✓

## Catatan
Bentuk/tampilan tidak berubah (sudah sesuai floating sejak v1.15.0). Perbaikan
ini murni lapisan input supaya perilaku floater terasa sama di ponsel.
