# CHANGELOG v1.23.1 — Tombol CLEAR + draf Gabung PDF tidak lagi "abadi"

## Masalah yang diperbaiki
Draf Gabung PDF (IndexedDB `rf-desktop` → `tg-drafts` → `gabung-v1`) sebelumnya hanya terhapus
kalau user menekan "Kosongkan" / "Mulai gabungan baru". Akibatnya PDF lama **dipulihkan terus-menerus**
setiap kali membuka fitur — termasuk setelah gabungan selesai dan tab ditutup begitu saja.
Bug tambahan: menghapus berkas satu-per-satu **sampai habis** justru meninggalkan draf lama,
sehingga berkas yang sudah dibuang "hidup" lagi saat refresh.

## Perubahan

### 1. Tombol 🗑 Kosongkan di semua layar wizard
- **Layar pilih halaman**: tombol baru `🗑 Kosongkan` (merah) di samping `+ Berkas` — membuang SEMUA
  berkas + draf setelah konfirmasi.
- **Layar kelola daftar**: tombol `Kosongkan` kini memakai dialog konfirmasi (tidak langsung menghapus)
  dan memakai satu fungsi bersama.
- **Layar selesai**: `Mulai gabungan baru` tetap mengosongkan semuanya.

### 2. Draf otomatis terhapus — tidak lagi "terus terusan"
- **Gabung sukses → draf dibersihkan otomatis** (ditulis jelas di layar selesai).
- **Daftar kosong → draf dihapus** (bukan disimpan): hapus manual sampai habis kini benar-benar bersih.
- Guard ganda: `tgDraftSave` & `tgDraftWrite` menolak menulis saat daftar kosong / stage `done`.

### 3. Draf basi dibuang + usia draf terlihat
- Draf **lebih dari 30 hari** dianggap basi — dihapus saat boot, tidak dipulihkan.
- Toast pemulihan kini menampilkan usia: "📂 Draf dipulihkan (2 berkas · 3 jam lalu) —
  tekan 🗑 Kosongkan bila tak diperlukan".

### 4. Hint layar kelola diperbarui
"Draf tersimpan otomatis — aman refresh/tab tertutup & terhapus otomatis begitu gabungan selesai."

## Skala perubahan
Hanya `public/desktop.html` (blok draf + 3 layar wizard). Fitur kompres ala iLovePDF,
auto-redirect desktop, dan alur wizard lain **tidak tersentuh**.

## Verifikasi
- `check_syntax.py`: JS 3.381 baris valid, ID elemen konsisten.
- E2E Playwright `scripts/e2e_draft_clear.py` **6/6 LOLOS** (login user QA sementara, dihapus setelahnya):
  T1 draf tersimpan otomatis · T2 hapus-manual-sampai-habis = draf hilang · T3 tombol Kosongkan di
  layar pilih halaman · T4a dismiss confirm tidak menghapus · T4b accept = daftar+draf hilang ·
  T5 gabung sukses = draf otomatis bersih + catatan di layar done · T6a draf segar dipulihkan ·
  T6b draf >30 hari dibuang saat boot. 0 pageerror.
