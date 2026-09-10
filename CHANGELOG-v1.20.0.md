# v1.20.0 — UPLOAD FILE SAMAKAN ADDON (Office + Gambar + Arsip)

## Permintaan user

> "di pwa tolong dicek lagi, karena disitu tertulis hanya mendukung file teks.
> nah kamu cek di addon mendukungnya file apa saja, kemudian samakan di pwa nya"

## Hasil audit addon (v3.24.15)

| Keluarga | Format | Batas DB | Batas Sementara |
|---|---|---|---|
| Teks + kode program | .md/.txt/.json/.html/.csv/.yaml + .js/.ts/.py/.go/.java/.css/.sql/.xml/.sh/... + Dockerfile/Makefile/README | 2MB | 2MB |
| Office | .pdf/.docx/.doc/.xlsx/.xls/.pptx/.ppt/.odt/.ods/.odp | 10MB | 1GB |
| Gambar | .png/.jpg/.gif/.webp/.avif/.bmp | 10MB | 1GB |
| Arsip | .zip/.rar/.7z/.tar/.gz/.tgz/.bz2/.xz/.zst | 10MB | 1GB |
| Ditolak (pesan khusus) | audio/video/epub/exe/apk/iso/psd/dll | — | — |

Catatan: teks tetap 2MB di SEMUA tujuan (isi masuk vault body + sync payload);
binary body = '' (vault ringan, byte utuh di Storage/litterbox).

## Perubahan PWA

- Baru `src/lib/file-kinds.js` — port 1:1 addon (konstanta, TEXT/BINARY maps,
  `detectFileKind`, `rejectHintFor`, `kindIcon`, `formatBytes`, `cloudExt`,
  `FILE_ACCEPT_ATTR`). Verifikasi node 8/8 asersi.
- `src/main.js` — sheet "Upload File Teks" → "Upload File"; accept =
  FILE_ACCEPT_ATTR; `handleFile` binary via arrayBuffer→Blob + preview
  (PDF embed, gambar thumbnail, Office/arsip info + ukuran); validasi 1:1 addon
  (pick: binary 1GB/teks 2MB; save: teks 2MB, binary 10MB DB / 1GB temp);
  payload binary body='' + `opts.fileBlob`; FAB "Upload File Teks" → "Upload File".
- `src/sync.js` — `createFileItem` terima `opts.fileBlob`; ext via `cloudExt`;
  body binary = '' di kedua tujuan (temp + database).
- `src/views/vault.js` — kartu file binary: `📎 nama · ukuran · Unduh`;
  Salin fallback: body → tempUrl → URL Storage → judul; bundle sertakan URL file.
- `package.json` → 1.20.0.

## Validasi

- `vite build` OK; `node --check` main/sync/vault OK.
- `scripts/test_temp_upload_pwa.mjs` 10/10 PASS (live litterbox).
