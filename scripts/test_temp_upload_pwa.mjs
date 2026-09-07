// scripts/test_temp_upload_pwa.mjs — v1.18.0: Upload file sementara (dual destination)
// Uji lib bersama dari sisi PWA: durasi, expiry, label, isTempItem/isTempExpired,
// uploadToTempHost (mock + LIVE litterbox roundtrip).
// Jalankan: node scripts/test_temp_upload_pwa.mjs

import {
  TEMP_DURATIONS,
  tempExpiresAt,
  isTempItem,
  isTempExpired,
  tempRemainingLabel,
  uploadToTempHost
} from '../src/lib/temp-upload.js';

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.error('  ✗ ' + name); } };

console.log('— Durasi & expiry (PWA lib) —');
ok(TEMP_DURATIONS.map(d => d.id).join(',') === '1h,12h,24h,72h', '4 durasi: 1h/12h/24h/72h');
ok(tempExpiresAt('24h', 1757000000000) === new Date(1757000000000 + 86400e3).toISOString(), '24h expiry math');
const mk = (src) => ({ id: 'x', type: 'file', source: src });
ok(isTempItem(mk({ tempHost: 'litterbox', tempUrl: 'https://litter.catbox.moe/a.txt' })), 'temp item dikenali');
ok(isTempExpired(mk({ tempHost: 'l', tempUrl: 'u', tempExpiresAt: new Date(Date.now() - 1).toISOString() })), 'kedaluwarsa terdeteksi');
ok(!isTempExpired(mk({ tempHost: 'l', tempUrl: 'u', tempExpiresAt: new Date(Date.now() + 86400e3).toISOString() })), 'belum kedaluwarsa');
ok(tempRemainingLabel(new Date(Date.now() + 90 * 60e3).toISOString()) === '1j 30m', 'label 1j 30m');

console.log('— Mock error handling —');
{
  const r = await uploadToTempHost(new Blob(['x']), 'a.txt', '24h', { fetchImpl: async () => ({ ok: false, status: 503, text: async () => '' }) });
  ok(r.ok === false && r.error === 'http_503', 'HTTP 503 → error');
}
{
  const r = await uploadToTempHost(new Blob(['x']), 'a.txt', '24h', { fetchImpl: async () => ({ ok: true, text: async () => 'https://evil.example.com/x' }) });
  ok(r.ok === false && r.error.startsWith('unexpected_response'), 'domain asing → ditolak');
}

console.log('— LIVE litterbox (CORS * — endpoint sama dipakai browser PWA) —');
if (process.env.RF_SKIP_LIVE !== '1') {
  const content = 'pwa temp upload live ' + Date.now();
  const up = await uploadToTempHost(new Blob([content], { type: 'text/plain' }), 'pwa-live-test.txt', '1h');
  ok(up.ok === true, 'upload live OK → ' + (up.url || up.error));
  if (up.ok) {
    const res = await fetch(up.url);
    const body = await res.text();
    ok(res.ok && body === content, 'roundtrip isi identik (mentah, bukan HTML)');
  }
} else {
  console.log('  (dilewati — RF_SKIP_LIVE=1)');
}

console.log('\nHasil: ' + pass + ' PASS, ' + fail + ' FAIL');
process.exit(fail > 0 ? 1 : 0);
