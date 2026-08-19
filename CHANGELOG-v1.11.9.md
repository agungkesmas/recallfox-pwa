# RecallFox PWA v1.11.9 — Industry-standard session persistence (fix "sehari logout")

**Tanggal:** 2026-08-04
**Base:** v1.11.8
**Scope:** Auth/session fix di src/main.js. Tidak ada schema change.

## TL;DR

User report: "login recallfox di pwa juga sehari logout. kenapa tidak dibuat standar industri aja."

**Root cause:** PWA uses `@supabase/supabase-js` with `autoRefreshToken: true`, which handles refresh WHEN TAB IS OPEN. But when tab is closed for >1 day, refresh_token expires → user gets logged out.

**Fix:** Two-pronged approach:

1. **Session heartbeat** — `setInterval` every 30 min calls `getSession()` → triggers `autoRefreshToken` which rotates the refresh_token → extends its expiry. As long as user opens PWA at least once every REFRESH_TOKEN_EXPIRY period (default 7 days), session stays alive.

2. **visibilitychange listener** — when user switches back to PWA tab, immediately call `getSession()` → triggers refresh if token is near expiry. Catches case where user left tab in background for hours.

## Perubahan

### `src/main.js` — session heartbeat + visibilitychange

**`startSessionHeartbeat()`** — new function:
- `setInterval` every 30 min → calls `getSession()`
- If session lost → reload to login page

**`visibilitychange` listener:**
- When tab becomes visible → immediately call `getSession()`
- If session lost while in background → reload to login page

**Init flow:**
- `init().then(() => startSessionHeartbeat())` — heartbeat starts after app is ready
- Even if init fails, heartbeat still starts (session might still be valid from localStorage)

## Yang TIDAK berubah

- `src/supabase.js` — config tetap sama (`autoRefreshToken: true`, `persistSession: true`)
- `src/auth.js` — tetap pakai `@supabase/supabase-js` auth methods
- `src/sync.js` — tetap sama
- Schema database — tetap sama

## Files changed

```
src/main.js                  | +65 lines (heartbeat + visibilitychange)
package.json                 | version bump → 1.11.9
CHANGELOG-v1.11.9.md         | new (this file)
```

## Testing checklist

### Test 1: Heartbeat keeps session alive
1. Login di PWA → biarkan tab terbuka
2. Tunggu 30+ menit
3. Cek console: "Session heartbeat: OK, expires_at = ..."
4. Verify: session masih valid

### Test 2: visibilitychange triggers refresh
1. Login di PWA → switch ke tab lain
2. Tunggu 1+ jam
3. Switch back ke PWA tab
4. Cek console: "Tab visible again — session OK"
5. Verify: session masih valid

### Test 3: Session lost → reload to login
1. Login di PWA → revoke session di Supabase dashboard (atau hapus localStorage)
2. Tunggu heartbeat (30 menit) atau trigger visibilitychange
3. Verify: page reloads → login page muncul

— *Implemented by Super Z on 2026-08-04.*
