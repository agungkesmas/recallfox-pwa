/* ============================================================================
 * E2E Rekonsiliasi PWA Desktop (v1.24.0) — Playwright Chromium.
 * Memuat desktop.html ASLI dari static server, mock login Supabase (routing),
 * lalu: pilih tab Rekonsiliasi → upload Excel sintetis → cek analisa, cari,
 * pilih semua/nihil, favorit ★, unduh ZIP → verifikasi isi ZIP via fflate.
 * Jalankan: node scripts/test_rekon_e2e.mjs
 * ==========================================================================*/
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import http from 'node:http';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const pwPath = '/home/z/.npm-global/lib/node_modules/playwright/index.js';
const pwMod = await import(pathToFileURL(pwPath));
const { chromium } = pwMod.default ?? pwMod;

const ROOT = new URL('../', import.meta.url);
const PUBLIC = new URL('public/', ROOT);
const PORT = 8931;

/* ---------- static server untuk public/ ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = new URL('.' + p, PUBLIC);
  try {
    const data = readFileSync(file);
    res.writeHead(200, { 'Content-Type': MIME[(p.match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  } catch (e) { res.writeHead(404); res.end('not found: ' + p); }
});
await new Promise(r => server.listen(PORT, '127.0.0.1', r));

/* ---------- vendor SheetJS/fflate utk buat & verifikasi berkas ---------- */
function loadVm(f) { vm.runInThisContext(readFileSync(new URL(f, ROOT), 'utf8'), { filename: f }); }
loadVm('public/vendor/xlsx.full.min.js');
loadVm('public/vendor/fflate.min.js');
const XLSX = globalThis.XLSX, fflate = globalThis.fflate;

/* berkas BPJS sintetis (pola sama dgn uji mesin) */
const HEADER = ['NO', 'KODE KLAIM', 'TGL BAYAR', 'NAMA REK. PENERIMA', 'BANK PENERIMA', 'NO REK PENERIMA', 'JUMLAH BAYAR', 'KETERANGAN'];
const DATA = [
  [1, '0201RBL012626000001', '05-01-2026', 'adi setiawan', 'BCA', '1234567890', '1.250.000', 'rawat inap'],
  [2, '0201RBL012626000002', '05-01-2026', 'ADI SETIAWAN', 'BCA', '1234567890', 2750000, 'rawat inap'],
  [3, '0201RBL012626000003', '06-01-2026', 'NUR  Hidayah', 'BRI', '0987654321', 'Rp 990.000', 'rawat jalan'],
  [4, '0201RBL012626000004', '07-01-2026', 'NUR HIDAYAH', 'BRI', '0987654321', 150000, 'rawat jalan'],
  [5, '0201RBL012626000005', '07-01-2026', 'NUR HIDAYAH', 'BRI', '0987654321', 1e6, 'rawat jalan'],
  [6, '0201RBL012626000006', '08-01-2026', 'rs harapan bunda', 'BNI', '1122334455', '2.000.000', 'penunjang'],
  [7, '0201RBL012626000007', '2026-01-09', 'RS Harapan Bunda', 'BNI', '1122334455', 750000, 'penunjang'],
  [8, '0201RBL012626000008', 46030, 'RS HARAPAN BUNDA', 'BNI', '1122334455', 300000, 'penunjang'],
  [null, null, null, null, null, null, null, null],
  [9, '0201RBL012626000009', '10-01-2026', 'SITI AMINAH', 'MANDIRI', '5566778899', '875.500', 'visite'],
];
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['LAPORAN PEMBAYARAN JAMINAN'], [], HEADER, ...DATA]), 'Laporan');
const xlsxBuf = Buffer.from(XLSX.write(wb, { bookType: 'xlsx', type: 'array' }));

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ FAIL: ' + n); } };

/* ---------- browser ---------- */
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true, serviceWorkers: 'block' });
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e)));

const NOW = Math.floor(Date.now() / 1000);
const FAKE_USER = {
  id: '00000000-0000-4000-8000-00000000e2e1', aud: 'authenticated', role: 'authenticated',
  email: 'e2e-rekon@test.local', email_confirmed_at: new Date().toISOString(), phone: '', confirmed_at: new Date().toISOString(),
  last_sign_in_at: new Date().toISOString(),
  app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: {}, identities: [],
  created_at: new Date().toISOString(), updated_at: new Date().toISOString()
};
const FAKE_SESSION = {
  access_token: 'e2e.header.sig', refresh_token: 'e2e-refresh', token_type: 'bearer',
  expires_in: 3600, expires_at: NOW + 3600, user: FAKE_USER
};

/* routing: supabase di-mock, situs eksternal lain diblok, localhost & jsdelivr lewat */
await context.route('**/qmwofsfpxjptpyvncylp.supabase.co/rest/v1/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
await context.route('**/qmwofsfpxjptpyvncylp.supabase.co/auth/v1/token**', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FAKE_SESSION) }));
await context.route('**/qmwofsfpxjptpyvncylp.supabase.co/auth/v1/user**', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FAKE_USER) }));
await context.route(/aladhan|nominatim|litterbox|catbox|temp\.sh|gofile|filebin|uguu|x0\.at|pixeldrain|storage\.to/i, r => r.abort());

try {
  console.log('== 1. Muat desktop.html + mock login ==');
  await page.goto('http://127.0.0.1:' + PORT + '/desktop.html', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForSelector('#loginWrap', { timeout: 20000 });
  await page.fill('#email', 'e2e-rekon@test.local');
  await page.fill('#pw', 'e2e-password');
  await page.click('#btnLogin');
  await page.waitForFunction(() => { const a = document.querySelector('#app'); return a && a.style.display !== 'none' && a.style.display !== ''; }, null, { timeout: 30000 });
  ok(true, 'login mock sukses → #app tampil');

  console.log('== 2. Buka Tagihan → tab Rekonsiliasi ==');
  await page.click('button[data-v="tagihan"]');
  await page.waitForTimeout(300);
  await page.click('#tgTabs button[data-t="rekon"]');
  await page.waitForTimeout(200);
  ok(await page.isVisible('text=REKONSILIASI TAGIHAN — PECAH EXCEL PER PENERIMA'), 'kartu utama (pecah Excel) tampil');
  ok(!(await page.isVisible('text=LAMPIRAN — COCOKKAN KWITANSI (MANUAL)')), 'v1.24.1: kartu lampiran manual TIDAK ada lagi — paritas penuh dgn addon');
  ok((await page.locator('#trkManual').count()) === 0, '#trkManual dihapus dari DOM');
  ok(await page.isVisible('text=📊 Pilih berkas Excel…'), 'tombol pilih berkas ada');

  console.log('== 3. Upload Excel → analisa otomatis ==');
  await page.setInputFiles('#trkFile', { name: 'Laporan Pembayaran Jaminan Januari 2026.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: xlsxBuf });
  await page.waitForSelector('#trkResult .tg-card', { timeout: 30000 });
  const bar0 = await page.textContent('#trkBar');
  ok(/Dipilih: 4 penerima · 9 tagihan · Rp 10\.065\.500/.test(bar0 || ''), 'bar pilihan: 4 penerima · 9 tagihan · Rp 10.065.500 → ' + (bar0 || '').trim());
  const listCount = await page.locator('#trkList [data-rkkey]').count();
  ok(listCount === 4, 'daftar penerima 4 baris');
  const dlLabel = await page.textContent('#trkDl');
  ok(/Unduh ZIP \(4 berkas Excel \+ REKAP\)/.test(dlLabel || ''), 'label tombol unduh menyebut 4 berkas + REKAP');

  console.log('== 4. Pencarian + pilih nihil/semua ==');
  await page.fill('#trkSearch', 'nur');
  ok((await page.locator('#trkList [data-rkkey]').count()) === 1, 'cari "nur" → 1 baris');
  await page.fill('#trkSearch', '');
  await page.click('#trkNone');
  ok(await page.locator('#trkDl').isDisabled(), 'Nihil → tombol unduh mati');
  const barNone = await page.textContent('#trkBar');
  ok(/Belum ada penerima dipilih/.test(barNone || ''), 'Nihil → bar kosong');
  await page.click('#trkAll');
  ok(!(await page.locator('#trkDl').isDisabled()), 'Semua → tombol unduh hidup');

  console.log('== 5. Favorit ★ persisten ==');
  await page.click('#trkList [data-rkstar]');
  await page.waitForTimeout(150);
  const favs = await page.evaluate(() => JSON.parse(localStorage.getItem('rf_rekon_favs_v1') || '[]'));
  ok(Array.isArray(favs) && favs.length === 1 && favs[0] === 'ADI SETIAWAN', '★ tersimpan localStorage (ADI SETIAWAN — baris pertama urut abjad)');

  console.log('== 6. Unduh ZIP → verifikasi isi ==');
  const dlPromise = page.waitForEvent('download', { timeout: 30000 });
  await page.click('#trkDl');
  const dl = await dlPromise;
  const fname = dl.suggestedFilename();
  ok(fname === 'Laporan Pembayaran Jaminan Januari 2026 - REKONSILIASI.zip', 'nama ZIP: ' + fname);
  const outPath = new URL('_e2e_out.zip', import.meta.url).pathname;
  await dl.saveAs(outPath);
  const zipBytes = new Uint8Array(readFileSync(outPath));
  const entries = fflate.unzipSync(zipBytes);
  const names = Object.keys(entries);
  ok(zipBytes[0] === 0x50 && zipBytes[1] === 0x4B, 'ZIP valid (PK)');
  ok(names.length === 5, '5 entri (4 penerima + REKAP)');
  ok(names.some(n => /adi setiawan/i.test(n)) && names.some(n => /nur hidayah/i.test(n)) && names.some(n => /rs harapan bunda/i.test(n)) && names.some(n => /siti aminah/i.test(n)) && names.includes('REKAP.xlsx'), 'nama entri sesuai penerima + REKAP');
  const wbR = XLSX.read(entries['REKAP.xlsx'], { type: 'array' });
  const rekap = XLSX.utils.sheet_to_json(wbR.Sheets[wbR.SheetNames[0]], { header: 1, raw: true });
  const tot = rekap[rekap.length - 1];
  ok(tot[1] === 'TOTAL' && Math.abs(tot[5] - 10065500) < 1e-9, 'REKAP TOTAL 10.065.500');
  const adiName = names.find(n => /adi setiawan/i.test(n));
  const wbA = XLSX.read(entries[adiName], { type: 'array' });
  const adi = XLSX.utils.sheet_to_json(wbA.Sheets[wbA.SheetNames[0]], { header: 1, raw: true });
  const adiTot = adi[adi.length - 1];
  ok(adiTot[0] === 'TOTAL' && Math.abs(adiTot[6] - 4000000) < 1e-9, 'berkas ADI: baris TOTAL 4.000.000');

  console.log('== 7. Upload ulang → favorit terpilih otomatis ==');
  await page.setInputFiles('#trkFile', { name: 'Laporan Pembayaran Jaminan Januari 2026.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: xlsxBuf });
  await page.waitForTimeout(600);
  const bar2 = await page.textContent('#trkBar');
  ok(/Dipilih: 1 penerima · 2 tagihan · Rp 4\.000\.000/.test(bar2 || ''), 'favorit auto-terpilih saat upload ulang → ' + (bar2 || '').trim());

  console.log('== 8. Tab lain tidak rusak (Urutkan/Gabung) ==');
  await page.click('#tgTabs button[data-t="urutkan"]');
  ok(await page.isVisible('text=URUTKAN HALAMAN SATU PDF'), 'tab Urutkan tampil');
  await page.click('#tgTabs button[data-t="gabung"]');
  ok(await page.isVisible('#tgDrop'), 'tab Gabung tampil');
  await page.click('#tgTabs button[data-t="rekon"]');
  ok(await page.isVisible('text=REKONSILIASI TAGIHAN — PECAH EXCEL PER PENERIMA'), 'kembali ke Rekonsiliasi — hasil analisa dirender ulang');

  const hardErrors = pageErrors.filter(e => !/realtime|websocket|fetch|Failed to fetch/i.test(e));
  ok(hardErrors.length === 0, '0 pageerror kritis → ' + (hardErrors.join(' | ') || '(bersih)'));

} catch (e) {
  fail++;
  console.log('  ✗ EXCEPTION: ' + e.message);
} finally {
  const out = new URL('_e2e_out.zip', import.meta.url).pathname;
  if (existsSync(out)) unlinkSync(out);
  await browser.close();
  server.close();
}
console.log('\nE2E HASIL: ' + pass + ' PASS, ' + fail + ' FAIL');
process.exit(fail ? 1 : 0);
