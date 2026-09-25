/* ============================================================================
 * Uji mesin Rekonsiliasi PWA Desktop (v1.24.0) — paritas addon v3.24.10.
 * Memuat vendor/ yang sama dengan yang dipakai browser:
 *   vendor/xlsx.full.min.js + vendor/fflate.min.js + vendor/xlsx-engine.js
 * Lalu mensimulasikan "Laporan Pembayaran Jaminan BPJS" sintetis:
 * parseWorkbook → analyze → buildZip → verifikasi isi ZIP per penerima.
 * Jalankan: node scripts/test_rekon_desktop.mjs
 * ==========================================================================*/
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const ROOT = new URL('../', import.meta.url);
const G = globalThis;

/* --- muat vendor berurutan dalam konteks global bersama (ala <script>) --- */
function load(file) {
  const code = readFileSync(new URL(file, ROOT), 'utf8');
  vm.runInThisContext(code, { filename: file });
}
load('public/vendor/xlsx.full.min.js');
load('public/vendor/fflate.min.js');
load('public/vendor/xlsx-engine.js');
const E = G.RFRekonEngine;
if (!E) { console.error('FAIL: RFRekonEngine tidak termuat'); process.exit(1); }
const XLSX = G.XLSX, fflate = G.fflate;

let pass = 0, fail = 0;
function ok(cond, name) { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ FAIL: ' + name); } }

/* ---------------------------------------------------------------- kunci util */
console.log('== 1. Util dasar ==');
ok(E.fmtNum(3692067670) === '3.692.067.670', 'fmtNum 3.692.067.670');
ok(E.fmtRp(250000) === 'Rp 250.000', 'fmtRp Rp 250.000');
ok(E.toNumber('1.234.567') === 1234567, 'toNumber "1.234.567"');
ok(E.toNumber('Rp 12 345') === 12345, 'toNumber "Rp 12 345"');
ok(E.toNumber(250000) === 250000, 'toNumber number');
ok(E.normKey('  adi   setiawan ') === 'ADI SETIAWAN', 'normKey rapatkan spasi');
ok(E.safeFilename('RS/BPJS: "Klaim" <A>*?') !== null && !/[\\/:*?"<>|]/.test(E.safeFilename('RS/BPJS: "Klaim" <A>*?')), 'safeFilename buang karakter ilegal');
ok(E.dateKey('05-03-2026') === '2026-03-05', 'dateKey dd-mm-yyyy');
ok(E.dateKey('2026-03-05') === '2026-03-05', 'dateKey yyyy-mm-dd');
ok(E.dateKey(46030) === '2026-01-08', 'dateKey serial Excel 46030 = 2026-01-08');
ok(E.fmtDate('2026-03-05') === '05-03-2026', 'fmtDate ISO → tampilan');

/* ------------------------------------------------- bangun berkas BPJS sintetis */
console.log('== 2. Berkas BPJS sintetis (header turun, kolom hantu, format liar) ==');
const HEADER = ['NO', 'KODE KLAIM', 'TGL BAYAR', 'NAMA REK. PENERIMA', 'BANK PENERIMA', 'NO REK PENERIMA', 'JUMLAH BAYAR', 'KETERANGAN', ''];
/* Baris data: [no, klaim, tgl, nama, bank, norek, jumlah, ket, kosong-hantu] */
const DATA = [
  [1, '0201RBL012626000001', '05-01-2026', 'adi setiawan', 'BCA', '1234567890', '1.250.000', 'rawat inap', ''],
  [2, '0201RBL012626000002', '05-01-2026', 'ADI SETIAWAN', 'BCA', '1234567890', 2750000, 'rawat inap', ''],   // nama sama (norm), jumlah number
  [3, '0201RBL012626000003', '06-01-2026', 'NUR  Hidayah', 'BRI', '0987654321', 'Rp 990.000', 'rawat jalan', ''],
  [4, '0201RBL012626000004', '07-01-2026', 'NUR HIDAYAH', 'BRI', '0987654321', 150000, 'rawat jalan', ''],
  [5, '0201RBL012626000005', '07-01-2026', 'NUR HIDAYAH', 'BRI', '0987654321', 1e6, 'rawat jalan', ''],
  [6, '0201RBL012626000006', '08-01-2026', 'rs harapan bunda', 'BNI', '1122334455', '2.000.000', 'penunjang', ''],
  [7, '0201RBL012626000007', '2026-01-09', 'RS Harapan Bunda', 'BNI', '1122334455', 750000, 'penunjang', ''],    // tgl ISO
  [8, '0201RBL012626000008', 46030, 'RS HARAPAN BUNDA', 'BNI', '1122334455', 300000, 'penunjang', ''],          // tgl serial excel (46030 = 2026-01-08)
  [null, null, null, null, null, null, null, null, null],                                                       // baris hantu
  [9, '0201RBL012626000009', '10-01-2026', 'SITI AMINAH', 'MANDIRI', '5566778899', '875.500', 'visite', ''],
];

/* 3 sheet: satu kosong, satu tanpa kolom wajib, satu valid dgn header di baris ke-3 */
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Halaman judul kosong dulu ya'], [], []]), 'Info');
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Nama Lain', 'Jumlah'], ['bukan laporan', 1]]), 'SheetLain');
const aoaValid = [['LAPORAN PEMBAYARAN JAMINAN', '', '', '', '', '', '', '', ''], [], HEADER, ...DATA];
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoaValid), 'Laporan');
const xlsxBytes = new Uint8Array(XLSX.write(wb, { bookType: 'xlsx', type: 'array' }));

console.log('== 3. parseWorkbook ==');
const parsed = E.parseWorkbook(xlsxBytes);
ok(parsed.sheetName === 'Laporan', 'pilih sheet pertama yg punya header valid (lewati 2 sheet awal)');
ok(parsed.header[3] === 'NAMA REK. PENERIMA', 'header baris ke-3 terdeteksi');
ok(parsed.header.length === 8, 'kolom hantu ekor dibuang (8 kolom)');
ok(parsed.rows.length === 9, 'baris hantu kosong dibuang (9 baris data)');

console.log('== 4. analyze ==');
const analyzed = E.analyze(parsed);
ok(analyzed.groups.length === 4, '4 penerima (nama dinormalisasi: adi x2, nur x3, rs x3, siti x1)');
const byName = Object.fromEntries(analyzed.groups.map(g => [g.key, g]));
ok(byName['ADI SETIAWAN'] && byName['ADI SETIAWAN'].count === 2, 'ADI SETIAWAN: 2 tagihan');
ok(byName['NUR HIDAYAH'].count === 3, 'NUR HIDAYAH: 3 tagihan');
ok(byName['RS HARAPAN BUNDA'].count === 3, 'RS HARAPAN BUNDA: 3 tagihan');
ok(Math.abs(byName['ADI SETIAWAN'].total - 4000000) < 1e-9, 'total ADI = 4.000.000');
ok(Math.abs(byName['NUR HIDAYAH'].total - 2140000) < 1e-9, 'total NUR = 2.140.000');
ok(analyzed.stats.totalRows === 9, 'stats 9 tagihan');
ok(Math.abs(analyzed.stats.totalAmount - 10065500) < 1e-9, 'stats total 10.065.500');
ok(byName['RS HARAPAN BUNDA'].dateMinIso === '2026-01-08' && byName['RS HARAPAN BUNDA'].dateMaxIso === '2026-01-09', 'rentang tgl rs (serial 46030 = 2026-01-08)');

console.log('== 5. buildZip (semua dipilih) ==');
const zip = E.buildZip(parsed, analyzed, new Set(analyzed.groups.map(g => g.key)));
ok(zip instanceof Uint8Array && zip[0] === 0x50 && zip[1] === 0x4B, 'ZIP valid (signature PK)');
const entries = fflate.unzipSync(zip);
const names = Object.keys(entries).sort();
ok(names.length === 5, 'ZIP 5 entri (4 penerima + REKAP)');
ok(/^01 adi setiawan\.xlsx$/i.test(names[0]), 'entri pertama = 01 adi setiawan.xlsx → ' + names[0]);
ok(names.includes('REKAP.xlsx'), 'ada REKAP.xlsx');

/* baca balik salah satu berkas penerima + REKAP */
function readAoa(u8) { const wb = XLSX.read(u8, { type: 'array' }); return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true }); }
const adiName = Object.keys(entries).find(n => /adi setiawan/i.test(n));
ok(!!adiName, 'entri berkas ADI ditemukan di ZIP → ' + adiName);
const adiU8 = entries[adiName];
const adiAoa = readAoa(adiU8);
ok(adiAoa[0].length === 8 && adiAoa[0][3] === 'NAMA REK. PENERIMA', 'kolom asli utuh di berkas penerima');
ok(adiAoa.length === 5, '1 header + 2 data + 1 kosong + 1 TOTAL');
const totalRow = adiAoa[adiAoa.length - 1];
ok(totalRow[0] === 'TOTAL' && Math.abs(totalRow[6] - 4000000) < 1e-9, 'baris TOTAL = 4.000.000 di kolom JUMLAH BAYAR');
/* urut Tgl Bayar → Kode Klaim */
ok(String(adiAoa[1][1]) < String(adiAoa[2][1]), 'urut klaim stabil (000001 sebelum 000002)');

const rekapAoa = readAoa(entries['REKAP.xlsx']);
ok(rekapAoa[0][0] === 'No' && rekapAoa[0][6] === 'Nama File', 'REKAP header benar');
ok(rekapAoa.length === 7, 'REKAP 4 penerima + kosong + TOTAL');
const rekapTotal = rekapAoa[rekapAoa.length - 1];
ok(rekapTotal[1] === 'TOTAL' && Math.abs(rekapTotal[5] - 10065500) < 1e-9, 'REKAP TOTAL 10.065.500');
ok(rekapTotal[6] === '4 berkas', 'REKAP catatan 4 berkas');

console.log('== 6. buildZip (subset) ==');
const zip2 = E.buildZip(parsed, analyzed, new Set(['NUR HIDAYAH']));
const e2 = Object.keys(fflate.unzipSync(zip2));
ok(e2.length === 2 && e2.includes('REKAP.xlsx'), 'subset: 1 penerima + REKAP');
ok(e2.some(n => /nur hidayah/i.test(n)), 'entri NUR HIDAYAH ada');
const rekap2 = readAoa(fflate.unzipSync(zip2)['REKAP.xlsx']);
ok(rekap2[rekap2.length - 1][1] === 'TOTAL' && Math.abs(rekap2[rekap2.length - 1][5] - 2140000) < 1e-9, 'REKAP subset total 2.140.000');

console.log('== 7. Kasus gagal yang ramah ==');
let err1 = null; try { E.parseWorkbook(new Uint8Array([1, 2, 3, 4])); } catch (e) { err1 = e; }
ok(err1 && /tidak dapat dibaca|tidak memuat sheet|tidak ditemukan/i.test(err1.message), 'berkas rusak → pesan jelas: ' + (err1 ? err1.message : '(tidak error)'));
let err2 = null; try { E.buildZip(parsed, analyzed, new Set()); } catch (e) { err2 = e; }
ok(err2 && /tidak ada penerima/i.test(err2.message), 'tanpa pilihan → error ramah');
const csvText = 'NAMA REK. PENERIMA;JUMLAH BAYAR;TGL BAYAR\nadi setiawan;1.250.000;05-01-2026\n';
const csvParsed = E.parseWorkbook(new TextEncoder().encode(csvText));
const csvAnalyzed = E.analyze(csvParsed);
ok(csvAnalyzed.groups.length === 1 && Math.abs(csvAnalyzed.groups[0].total - 1250000) < 1e-9, 'CSV titik-koma terbaca');

console.log('\nHASIL: ' + pass + ' PASS, ' + fail + ' FAIL');
process.exit(fail ? 1 : 0);
