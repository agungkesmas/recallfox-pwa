# MANUAL-MODE.md — Workflow Tanpa opencode (arena.ai + chat.z.ai saja)

> Dipakai saat TIDAK ada opencode di perangkat. Semua file otak
> (`AGENTS.md`, `task_plan.md`, `findings.md`, `progress.md`) tetap jalan
> karena GLM/arena bisa akses git sendiri.
>
> Yang hilang tanpa opencode: token otomatis + tracker otomatis.
> Solusinya: tempel token di prompt, dan minta GLM yang update tracker.

---

## Perbedaan vs Mode opencode

| | Dengan opencode | Tanpa opencode (ini) |
|---|---|---|
| Token masuk prompt | Otomatis dari `sesi/.token` | **Anda tempel manual** di prompt |
| Pilih akun | `/sesi` otomatis (kueri < 4) | Anda lihat `sesi/tracker.md` lalu tempel ke akun mana |
| Update tracker | `/selesai` otomatis | **GLM diminta update** (prompt step 6), atau edit manual di GitHub |
| Pull/commit | Otomatis | Dilakukan GLM sendiri lewat git |

---

## Setup (sekali saja)

1. Simpan token fine-grained di tempat rahasia Anda (Bitwarden/catatan aman) — **bukan di repo**.
2. Repo proyek TIDAK perlu di-clone lokal — GLM yang clone/push sendiri.
3. Untuk proyek baru: gunakan `prompt-arena-start.md` di arena (sudah siap, tidak butuh opencode).

---

## Alur Harian (3 langkah)

```
1. Buka sesi/tracker.md → pilih akun yang kueri < 4 dan tidak diblokir (akunX)
2. Salin prompt chat.z.ai di bawah → isi [LINK REPO], [TOKEN], [X] → tempel ke akunX
3. GLM bekerja, commit + push sendiri (termasuk update tracker). Selesai.
```

Ulangi sampai semua task `[x]`. Jika akun mencapai 4/4 → pakai akun lain.

---

## Prompt chat.z.ai — BUILD (tempel ke akunX)

```
Repo: [LINK REPO]   ← mis. https://github.com/agungkesmas/recallfox.git
Token: [TOKEN GIT]
Akun: kamu adalah akun[X]

Baca AGENTS.md dan progress.md di repo ini.

1. Clone repo (auth pakai token di atas), lalu git pull
2. Cari task [ ] pertama di task_plan.md (LEWATI yang [doing:...])
3. Klaim: ubah [ ] → [doing:akunX], commit + push "claim: <task> (akunX)"
4. Kerjakan task itu saja. Baca findings.md dulu, IKUTI gaya kode yang ada.
5. Selesai: [doing:akunX] → [x]; catat di progress.md (dengan commit ref)
   + workers/akunX.md
6. Update sesi/tracker.md: naikkan kueri akunX +1, isi "sesi terakhir".
   Jika sudah 4/4, isi "blokir sampai" = sekarang + 6 jam.
7. Commit + push "done: <task> (akunX)" (termasuk perubahan tracker).
```

## Prompt chat.z.ai — PLANNING (bila perlu task baru besar)

```
Repo: [LINK REPO]
Token: [TOKEN GIT]
Akun: kamu adalah akun[X]

Baca AGENTS.md dan findings.md di repo ini.
1. Clone repo (auth pakai token di atas), lalu git pull
2. Susun/update task_plan.md (task [ ] urut dari paling penting)
3. Update findings.md jika ada perubahan tech stack
4. Update progress.md + sesi/tracker.md (akunX +1)
5. Commit + push "planning: <deskripsi>"
```

---

## Tracker tanpa opencode

- Tracker di-update oleh GLM (step 6 pada prompt BUILD) → tetap tersimpan di repo, otomatis.
- Alternatif cadangan jika GLM lupa: edit `sesi/tracker.md` langsung di GitHub (pencet ikon pensil), lalu commit dari web.

---

## Peringatan Keamanan

- Token Anda tempel = **tersimpan di history chat chat.z.ai**. Tidak bisa dihapus.
- Gunakan **fine-grained token scope repo kecil + expiry pendek** (mis. 30 hari).
- Setelah masa kerja, buat token baru (via GitHub settings), bukan ulang pakai lama.
- Jangan pernah taruh token di `README.md` atau file yang ter-commit.
