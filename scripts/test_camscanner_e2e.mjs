// scripts/test_camscanner_e2e.mjs — Smoke test E2E kamera ala CamScanner (v1.25.0)
// Jalankan: node scripts/test_camscanner_e2e.mjs
// Chromium fake camera (--use-fake-device-for-media-stream) → getUserMedia jalan
// tanpa kamera fisik. Fokus: wiring UI (root, tab mode, auto pill, hint, close),
// bukan kualitas gambar (pola sintetis, bukan dokumen).

import { chromium } from 'playwright';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Serve dist/ (hasil vite build — app mobile self-contained)
const DIST = new URL('dist/', pathToFileURL('/home/z/my-project/recallfox-work/pwa/'));
const PORT = 8933;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p === '/' || p === '/index.html') p = '/index.html';
  const file = new URL('.' + p, DIST);
  try {
    const data = readFileSync(file);
    res.writeHead(200, { 'Content-Type': MIME[(p.match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  } catch (e) { res.writeHead(404); res.end('not found'); }
});
await new Promise(r => server.listen(PORT, '127.0.0.1', r));

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ FAIL: ' + n); } };

const NOW = Math.floor(Date.now() / 1000);
const FAKE_USER = {
  id: '00000000-0000-4000-8000-00000000c5a1', aud: 'authenticated', role: 'authenticated',
  email: 'e2e-cam@test.local', email_confirmed_at: new Date().toISOString(), phone: '', confirmed_at: new Date().toISOString(),
  last_sign_in_at: new Date().toISOString(),
  app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: {}, identities: [],
  created_at: new Date().toISOString(), updated_at: new Date().toISOString()
};
const FAKE_SESSION = {
  access_token: 'e2e.header.sig', refresh_token: 'e2e-refresh', token_type: 'bearer',
  expires_in: 3600, expires_at: NOW + 3600, user: FAKE_USER
};

const browser = await chromium.launch({
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream']
});
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true, hasTouch: true, deviceScaleFactor: 2,
  serviceWorkers: 'block'
});
await context.grantPermissions(['camera', 'geolocation'], { origin: 'http://127.0.0.1:' + PORT });

/* Seed session supabase-js SEBELUM script halaman jalan */
await context.addInitScript((sess) => {
  localStorage.setItem('recallfox-pwa-auth', JSON.stringify(sess));
}, FAKE_SESSION);

/* Mock jaringan supabase + blok eksternal */
await context.route('**/qmwofsfpxjptpyvncylp.supabase.co/rest/v1/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
await context.route('**/qmwofsfpxjptpyvncylp.supabase.co/auth/v1/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FAKE_USER) }));
await context.route('**/qmwofsfpxjptpyvncylp.supabase.co/storage/v1/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
await context.route(/aladhan|nominatim|jsdelivr/i, r => r.abort());

const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e)));

try {
  console.log('== 1. Buka PWA mobile (session seed) ==');
  await page.goto('http://127.0.0.1:' + PORT + '/index.html', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForFunction(() => {
    const m = document.getElementById('appMain');
    return m && m.innerHTML.length > 50;
  }, null, { timeout: 30000 });
  ok(true, 'PWA mobile tampil (login via seeded session)');

  console.log('== 2. FAB → Scan Dokumen → kamera live ==');
  await page.click('#fabAdd');
  await page.waitForSelector('.sheet-content', { timeout: 8000 });
  const hasBtn = await page.locator('.sheet-btn[data-action="document"]').count();
  const hasPano = await page.locator('.sheet-btn[data-action="panorama"]').count();
  ok(hasBtn === 1, 'sheet punya tombol Scan Dokumen');
  ok(hasPano === 1, 'sheet punya tombol Foto Panorama (baru)');
  await page.click('.sheet-btn[data-action="document"]');

  await page.waitForSelector('.cs-root', { timeout: 15000 });
  ok(true, 'kamera live terbuka (.cs-root)');
  await page.waitForFunction(() => {
    const v = document.querySelector('.cs-video');
    return v && v.readyState >= 2 && v.videoWidth > 0;
  }, null, { timeout: 15000 });
  ok(true, 'video kamera hidup (readyState≥2, videoWidth>0)');

  const tabs = await page.locator('.cs-tab').allTextContents();
  ok(tabs.length === 3 && /Dokumen/.test(tabs[0]) && /Foto/.test(tabs[1]) && /Panorama/.test(tabs[2]), '3 tab mode: Dokumen/Foto/Panorama');
  const activeTab = await page.locator('.cs-tab.active').textContent();
  ok(/Dokumen/.test(activeTab), 'tab aktif = Dokumen (buka dr Scan Dokumen)');
  const autoText = await page.locator('.cs-pill[data-act="auto"]').textContent();
  ok(/Auto-jepret.*ON/s.test(autoText), 'auto-jepret default ON: ' + autoText.trim().replace(/\s+/g, ' '));
  const hint = await page.locator('#csHintText').textContent();
  ok(/dokumen/i.test(hint), 'hint dokumen: ' + hint);
  ok(await page.locator('.cs-shutter').count() === 1, 'tombol shutter ada');
  ok(await page.locator('.cs-sbtn[data-act="gallery"]').count() === 1, 'tombol impor galeri ada');
  ok(await page.locator('.cs-sbtn[data-act="switch"]').count() === 1, 'tombol ganti kamera ada');

  await page.waitForTimeout(1200); // beri deteksi 2-3 tick jalan
  await page.screenshot({ path: '/home/z/my-project/download/camscanner-viewfinder.png' });
  ok(true, 'screenshot viewfinder tersimpan');

  console.log('== 3. Ganti mode Panorama + uji SWEEP kontinyu (v1.25.1) ==');
  await page.click('.cs-tab[data-mode="pano"]');
  const active2 = await page.locator('.cs-tab.active').textContent();
  ok(/Panorama/.test(active2), 'tab aktif pindah → Panorama');
  const hint2 = await page.locator('#csHintText').textContent();
  ok(/geser KANAN/i.test(hint2), 'hint panorama: ' + hint2);
  ok(await page.locator('.cs-pill[data-act="auto"]').isVisible().catch(() => false) === false, 'pill auto disembunyikan di mode panorama');
  await page.screenshot({ path: '/home/z/my-project/download/camscanner-panorama.png' });

  // v1.25.1: tekan jepret = MULAI sweep (rekam otomatis), bukan jepret sekali
  await page.click('.cs-shutter');
  await page.waitForTimeout(600);
  ok(await page.locator('.cs-shutter.sweeping').count() === 1, 'jepret → mode sweeping (tombol jadi STOP)');
  const hint3 = await page.locator('#csHintText').textContent();
  ok(/Merekam|tersambung|geser/i.test(hint3), 'hint saat sweep: ' + hint3);
  await page.waitForTimeout(1200); // 2-3 tick rekam (kamera statis → frame skip, tak error)
  const chipTxt = await page.locator('#csPagesChip').textContent().catch(() => '');
  ok(/frame/.test(chipTxt || ''), 'chip progres panorama tampil: ' + (chipTxt || '').trim());
  await page.screenshot({ path: '/home/z/my-project/download/camscanner-pano-sweep.png' });

  console.log('== 4. Tutup kamera (saat sweep aktif — harus berhenti bersih) ==');
  page.once('dialog', d => d.accept().catch(() => { }));
  await page.click('.cs-top [data-act="close"]');
  await page.waitForFunction(() => !document.querySelector('.cs-root'), null, { timeout: 8000 });
  ok(true, 'kamera tertutup bersih (.cs-root hilang, sweep terhenti)');

  const crit = pageErrors.filter(e => !/ResizeObserver|Non-Error promise|AbortError|NotAllowedError/i.test(e));
  ok(crit.length === 0, '0 pageerror kritis ' + (crit.length ? '→ ' + crit[0].slice(0, 120) : ''));
} catch (e) {
  fail++;
  console.error('  ✗ EXCEPTION: ' + e.message);
  try { await page.screenshot({ path: '/home/z/my-project/download/camscanner-e2e-fail.png' }); } catch (_) { /* */ }
}

await browser.close();
server.close();
console.log(`\nE2E CAMSCANNER HASIL: ${pass} PASS, ${fail} FAIL`);
process.exit(fail > 0 ? 1 : 0);
