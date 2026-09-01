# CHANGELOG v1.15.0 — RecallTape PWA disamakan dengan floating RecallTape

> "Bentuk dan perilaku Tape di PWA kini sama persis dengan floater di addon."

## Latar

Tape di tab Fokus PWA sebelumnya berupa textarea mentah + kartu struk terpisah
— bentuknya jauh berbeda dari floating RecallTape di addon. Versi ini
menggantinya dengan **port setia** floater tersebut (`content/tape-cs.js`
v3.23.x–v3.24.5) sehingga bentuk, warna, dan perilakunya identik.

## Baru / berubah (semuanya port dari tape-cs.js)

### Satu lembar tape utuh ala floater
- Kartu gelap (`#0E182A`) dengan header berwarna (default amber `#3A1F00`,
  judul emas), editor monospace navy (`#273953`, 14px/26px, angka
  right-aligned), dan footer status — persis tampilan floater.
- **Enter = hitung otomatis di editor**: semua baris di-reformat (operator
  kiri, angka rata kanan), lalu disisipkan garis `─────` + baris hasil
  `→   26.000  📋` langsung di bawah baris yang di-Enter.
- Auto-format saat mengetik: digit di baris kosong otomatis diawali `+`;
  mengetik operator (`+ - * /`) di ujung baris langsung pindah baris baru.
- Footer live: `✓ Tersimpan otomatis · Total: N` (atau `⚠ pesan error` /
  `⏳ Menyimpan…`, debounce 400ms).
- Double-click baris hasil (`→`) = salin angkanya.
- Ctrl+Enter = simpan ke Catatan/Vault (resi teks, judul
  `🧮 RecallTape — Total: N` — sama dengan addon).
- Mendukung persen (`+ 11%`), suffix Indonesia (`50k / 150rb / 2,5jt`),
  dan baris keterangan.

### Toolbar header (ikon, sama seperti floater)
- `▾` gulung/buka lembar, `🎨` warna lembar (8 swatch: green, blue, amber,
  rose, violet, cyan, orange, lime), `＋` **lembar baru** (multi-lembar,
  warna otomatis paling jarang dipakai), `🖨` cetak resi 80mm, `⧉` salin
  sebagai teks rapi, `💾` simpan ke Catatan, `🗑` kosongkan (dengan
  konfirmasi), `✕` tutup lembar.

### Multi-lembar + penyimpanan
- Lembar disimpan di `localStorage` (`rf_tape_instances`): teks, warna,
  status gulung, terbuka/tutup — per lembar. Lembar pertama tetap
  di-mirror ke `rf_tape_session` (kompat pembaca lama; teks pita lama
  otomatis jadi lembar pertama).
- Menutup semua lembar (`✕`) menampilkan empty state dengan tombol
  `＋ Lembar baru`.

## Dihapus
- Kartu struk terpisah + tombol Copy/Vault/Contoh/Bersih di bawah editor
  (semua aksinya kini ada di toolbar header, seperti floater).

## Adaptasi wajar (bukan window melayang)
- Tanpa drag/resize/pin/idle-dim: pin di floater artinya "jangan tutup saat
  klik di luar" — tidak relevan di dalam tab; lembar PWA memakai lebar penuh.

## Teknis
- Modul baru `src/views/tape.js` (port `tape-cs.js`: formatOpLine,
  handleAutoFormatKey, handleEnterKey, updateStatus, scheduleSave 400ms,
  buildPlainTextForCopy, doPrint resi 80mm, pickAutoColor).
- `src/views/focus.js` tinggal memanggil `renderTapeSheets()`;
  Pomodoro tidak berubah.
- CSS baru `.rts-*` di `src/styles/v3.css` (palet & warna diport 1:1 dari
  template floater). Tanpa perubahan schema Supabase; tetap local-first.
