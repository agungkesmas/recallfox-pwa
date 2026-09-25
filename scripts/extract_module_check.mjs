/* Ekstrak <script type="module"> dari public/desktop.html → cek sintaks Node */
import { readFileSync, writeFileSync } from 'node:fs';
const html = readFileSync(new URL('../public/desktop.html', import.meta.url), 'utf8');
const m = html.match(/<script type="module">([\s\S]*?)<\/script>/);
if (!m) { console.error('FAIL: blok script module tidak ditemukan'); process.exit(1); }
writeFileSync(new URL('./_desktop_module.mjs', import.meta.url), m[1]);
console.log('OK: modul diekstrak,', m[1].split('\n').length, 'baris');
