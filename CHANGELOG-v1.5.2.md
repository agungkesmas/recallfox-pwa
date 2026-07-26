# RecallFox PWA v1.5.2 — Notes Sync + Search Input Fix

**Tanggal:** 24 Jul 2026
**Tag sebelumnya:** v1.5.1
**Tipe:** Bug fix (4 surgical changes — 3 sync + 1 search input)

## Ringkasan

Audit mendalam PWA + addon + Supabase menemukan 3 critical bug di sync notes PWA yang menyebabkan catatan tidak tersinkron antar device, dan 1 bug UX pada input search yang membuat tombol Enter di keyboard HP tidak fires pencarian.

## Perubahan

### P1 — `createNote`: IndexedDB write sebelum cloud upsert
**File:** `src/sync.js` (`createNote`)

**Bug:** Sebelumnya cloud upsert DULU, baru IndexedDB write. Kalau cloud hang/error, IndexedDB tidak pernah ditulis → catatan benar-benar hilang dari UI. User lihat "catatan tidak tersimpan". v1.5.1 sudah fix pattern ini untuk `createScreenshotItem` dan `createDocumentItem`, tapi `createNote` ketinggalan.

**Fix:** IndexedDB write PERTAMA → cloud upsert dengan `withTimeout(20s)`. Kalau cloud gagal/timeout, tetap return `ok: true, localOnly: true` + enqueue ke sync queue untuk retry. UI baca dari IndexedDB, jadi catatan selalu muncul.

### P2 — `updateNote`: selalu upsert + tidak skip kalau tidak ada di lokal
**File:** `src/sync.js` (`updateNote`)

**Bug:** Sebelumnya, IndexedDB update HANYA dilakukan kalau note ada di local cache. Race condition: kalau user edit note yang baru di-pull dari cloud (belum sempat cache ke IndexedDB), update lokal di-skip → note di device lain tidak sinkron. Juga tidak ada `withTimeout`.

**Fix:** Selalu ambil note lokal dulu (atau fallback ke skeleton `{id, user_id, created_at, deleted_at}`), merge dengan patch, upsert ke IndexedDB. Cloud update pakai `withTimeout(20s)`. Kalau cloud gagal → enqueue ke sync queue.

### P3 — `deleteNote`: IndexedDB delete sebelum cloud delete
**File:** `src/sync.js` (`deleteNote`)

**Bug:** Sebelumnya cloud delete DULU, baru IndexedDB delete. Kalau cloud hang, ghost note tetap muncul di UI (karena IndexedDB belum dihapus). Juga tidak ada `withTimeout`.

**Fix:** IndexedDB delete PERTAMA → ghost note langsung hilang dari UI. Cloud delete pakai `withTimeout(20s)`. Kalau cloud gagal → enqueue ke sync queue untuk retry.

### S1 — Notes search input: `type="search"` + `enterkeyhint="search"`
**File:** `src/views/notes.js` (search input di notes toolbar)

**Bug:** Input pakai `type="text"` → di HP, tombol "→" / "Go" di keyboard virtual tidak fires `keydown Enter`. User harus tap di luar input dulu baru search jalan. Addon v3.13.2 sudah fix dengan `type="search" enterkeyhint="search"`, tapi PWA belum ikut.

**Fix:** Ganti ke `<input type="search" enterkeyhint="search" autocomplete="off" spellcheck="false">`. Sekarang tombol "→" di keyboard HP langsung trigger `keydown Enter` → search langsung jalan.

### P5 (Bonus) — `pullFromCloud` notes merge: hapus N+1 dynamic import
**File:** `src/sync.js` (`pullFromCloud`, bagian notes merge)

**Bug:** Di loop merge cloud → local notes, setiap iterasi panggil `await import('./db.js').then(dbGetAllNotes())` → N+1 dynamic import + N+1 full table scan. Untuk 100 notes = 100x import + 100x query. Boros CPU + memory.

**Fix:** Reuse `localNotes` yang sudah di-fetch di awal blok (line ~807). 1x query, 0x import di loop.

## Yang TIDAK Diubah

- IndexedDB schema (`src/db.js`)
- Auth flow (`src/auth.js`)
- Realtime subscription code (channel name `realtime:vault_${user.id}` tetap — Supabase JS client yang handle)
- Polling 10s PWA
- Service Worker config
- Schema DB / RLS policies
- Vault items sync (sudah fix di v1.5.1)
- Document/screenshot flows (sudah fix di v1.5.1)

## Verifikasi Post-Deploy

User harus:
1. Hard refresh PWA (Ctrl+Shift+R / swipe down + refresh di HP)
2. Login kalau belum
3. Test create note → harus langsung muncul di list (bahkan kalau cloud lambat)
4. Test edit note → perubahan harus sinkron ke addon dalam 1-2 menit
5. Test delete note → langsung hilang dari list (tidak ada ghost)
6. Test search di HP → tombol "→" / "Go" di keyboard harus langsung trigger pencarian

## Files Changed

- `package.json` — version bump 1.5.1 → 1.5.2
- `package-lock.json` — version bump 1.5.1 → 1.5.2
- `src/sync.js` — P1 (createNote), P2 (updateNote), P3 (deleteNote), P5 (pullFromCloud notes merge)
- `src/views/notes.js` — S1 (search input attributes)
- `CHANGELOG-v1.5.2.md` — file ini
