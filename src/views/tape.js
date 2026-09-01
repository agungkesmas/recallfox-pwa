// src/views/tape.js — RecallTape lembar (PWA)
// v1.15.0: PORT SETIA dari floating RecallTape addon (content/tape-cs.js
// v3.23.x–v3.24.5) — bentuk, warna, dan perilaku SAMA dengan floater:
//
//   ┌──────────────────────────────────────────┐
//   │ 🧾 RecallTape  [▾][🎨][＋][🖨][⧉][💾][🗑][✕] │ ← header berwarna
//   ├──────────────────────────────────────────┤
//   │ +           10000                        │ ← editor monospace
//   │ +           20000                        │   (free typing)
//   │ ─────                                    │
//   │ →         30.000  📋                     │
//   ├──────────────────────────────────────────┤
//   │      ✓ Tersimpan otomatis · Total: 26.000│ ← status live
//   └──────────────────────────────────────────┘
//
// Perilaku yang di-port 1:1 dari tape-cs.js:
//   • Free typing seperti Word; ENTER = HITUNG OTOMATIS — reformat semua
//     baris (operator kiri, angka right-aligned AMT_WIDTH) lalu sisipkan
//     garis '─────' + baris hasil '→   total  📋' langsung di editor.
//   • Auto-format saat mengetik: digit di baris kosong → auto-prefix '+   ';
//     operator (+ - * /) di ujung baris berisi → auto baris baru.
//   • Footer status live: '✓ Tersimpan otomatis · Total: N' / '⚠ pesan
//     error' / '⏳ Menyimpan…' (debounce 400ms).
//   • Double-click baris hasil (→) = copy angkanya.
//   • Ctrl+Enter = simpan ke Catatan/Vault (resi teks, judul total).
//   • Multi-lembar (＋ = lembar baru) dengan WARNA lembar via 🎨 (8 swatch,
//     lembar baru otomatis dapat warna yang paling jarang dipakai).
//   • ▾ gulung/ expanded per lembar; ✕ tutup lembar (teks tetap di storage).
//   • 🖨 cetak resi 80mm (iframe tersembunyi + print).
//   • ⧉ salin sebagai teks rapi (🧮 RecallTape / tanggal / baris / total).
//   • Auto-save 400ms ke localStorage (rf_tape_instances), lembar pertama
//     di-mirror ke rf_tape_session (kompat pembaca lama).
//
// Adaptasi wajar PWA (bukan window melayang): kartu bertumpuk memakai
// lebar penuh tab (tanpa drag/resize/pin — pin addon = anti tutup saat
// klik di luar, tidak relevan di dalam tab), tanpa idle-dim, tanpa
// autofocus saat render awal (anti keyboard mobile meletup).

import { evaluate, formatNumber, loadSession, saveSession } from '../lib/tape.js';
import { createFileItem } from '../sync.js';

const INST_KEY = 'rf_tape_instances';

// ============================================================================
// Format rapi (port tape-cs.js v3.14.14) — operator rata kiri, angka kanan
// ============================================================================
const OP_GAP = '   ';      // 3 spasi — jarak operator ↔ angka
const AMT_WIDTH = 12;      // lebar tetap untuk angka (right-aligned)
const NOTE_GAP = '  ';     // 2 spasi — jarak angka ↔ keterangan

// ============================================================================
// Palet warna lembar (port v3.23.1)
// ============================================================================
const RF_PALETTE = ['green', 'blue', 'amber', 'rose', 'violet', 'cyan', 'orange', 'lime'];
const RF_DEF_COLOR = 'amber';
const RF_SWATCH = { green:'#10B981', blue:'#3B82F6', amber:'#F59E0B', rose:'#F43F5E', violet:'#8B5CF6', cyan:'#06B6D4', orange:'#F97316', lime:'#84CC16' };

function normColor(c) { return (typeof c === 'string' && RF_SWATCH[c]) ? c : null; }

// Warna otomatis: lembar baru dapat warna yang paling jarang dipakai lembar
// terbuka lain (port pickAutoColor).
function pickAutoColor(list) {
  const used = {};
  for (const it of (Array.isArray(list) ? list : [])) {
    if (!it || !it.open) continue;
    const c = normColor(it.color) || RF_DEF_COLOR;
    used[c] = (used[c] || 0) + 1;
  }
  const order = [RF_DEF_COLOR].concat(RF_PALETTE.filter(c => c !== RF_DEF_COLOR));
  let best = RF_DEF_COLOR, bestN = Infinity;
  for (const c of order) { const n = used[c] || 0; if (n < bestN) { bestN = n; best = c; } }
  return best;
}

// ============================================================================
// Storage lembar — localStorage (pengganti browser.storage.local di addon)
// ============================================================================

function newData(extra) {
  return Object.assign({
    id: 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    text: '', open: true, collapsed: false,
    color: null, createdAt: Date.now()
  }, extra || {});
}

function getList() {
  try {
    const raw = localStorage.getItem(INST_KEY);
    const l = raw ? JSON.parse(raw) : [];
    return Array.isArray(l) ? l : [];
  } catch (e) { return []; }
}

function putList(list) {
  try { localStorage.setItem(INST_KEY, JSON.stringify(list)); } catch (e) {}
  return list;
}

function patchLocal(id, patch) {
  const list = getList();
  const it = list.find(i => i.id === id);
  if (it) { Object.assign(it, patch); putList(list); }
  return list;
}

// ============================================================================
// Auto-format + Enter = hitung otomatis (port utuh dari tape-cs.js)
// ============================================================================

// Format satu baris op menjadi format rapi
function formatOpLine(rawLine) {
  const trimmed = rawLine.trim();
  if (!trimmed) return rawLine;  // baris kosong, biarkan

  // Skip separator + hasil
  if (/^[─=─]{3,}$/.test(trimmed) || /^-{3,}$/.test(trimmed) || /^={3,}$/.test(trimmed)) return rawLine;
  if (/^[→»•]/.test(trimmed)) return rawLine;

  // Parse: optional operator + angka (dengan suffix/percent) + optional note
  const m = trimmed.match(/^([+\-*/]?)\s*([\d.,]+(?:\s*(?:juta|jt|ribu|rb|bn|k|m|b)\b)?\s*%?)\s*(.*)$/i);
  if (!m) return rawLine;  // bukan op line (comment), biarkan apa adanya

  const op = m[1] || '+';
  const amtStr = m[2].trim().replace(/\s+/g, '');  // normalize spasi dalam amount
  const note = (m[3] || '').trim();

  const amtPadded = amtStr.padStart(AMT_WIDTH, ' ');
  let line = op + OP_GAP + amtPadded;
  if (note) line += NOTE_GAP + note;
  return line;
}

// Format baris hasil (subtotal) — right-aligned supaya sejajar baris op
function formatResultLine(running) {
  const formatted = formatNumber(running);
  const amtPadded = formatted.padStart(AMT_WIDTH, ' ');
  return '→' + OP_GAP + amtPadded + NOTE_GAP + '📋';
}

function reformatAllOpLines(val) {
  return val.split('\n').map(ln => formatOpLine(ln)).join('\n');
}

function isSepLine(t) { return /^[─=─]{3,}$/.test(t) || /^-{3,}$/.test(t) || /^={3,}$/.test(t); }
function isResultLine(t) { return /^[→»•]/.test(t); }

// Kumpulkan baris operasi (buang separator & hasil) — pola sama dengan addon
function collectOpLines(text) {
  const out = [];
  for (const ln of String(text || '').split('\n')) {
    const trimmed = ln.trim();
    if (isSepLine(trimmed) || isResultLine(trimmed)) continue;
    out.push(ln);
  }
  return out;
}

// Ketik digit di baris kosong → auto-prefix "+   "; operator di ujung baris
// berisi → auto baris baru (port handleAutoFormatKey)
function handleAutoFormatKey(e, ta, hooks) {
  if (e.key.length !== 1) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  const pos = ta.selectionStart;
  const val = ta.value;
  if (ta.selectionStart !== ta.selectionEnd) return;

  const lineStart = val.lastIndexOf('\n', pos - 1) + 1;
  const currentLine = val.slice(lineStart, pos);
  const trimmedCurrent = currentLine.trim();

  const atEndOfLine = (pos === val.length) || (val[pos] === '\n');
  if (!atEndOfLine) return;

  if (isSepLine(trimmedCurrent) || isResultLine(trimmedCurrent)) return;

  const key = e.key;

  if (/^\d$/.test(key) && trimmedCurrent === '') {
    e.preventDefault();
    const insert = '+' + OP_GAP + key;
    const before = val.slice(0, pos);
    const after = val.slice(pos);
    ta.value = before + insert + after;
    ta.setSelectionRange(pos + insert.length, pos + insert.length);
    hooks.after();
    return;
  }

  if (/[+\-*/]/.test(key) && trimmedCurrent !== '') {
    e.preventDefault();
    const insert = '\n' + key + OP_GAP;
    const before = val.slice(0, pos);
    const after = val.slice(pos);
    ta.value = before + insert + after;
    ta.setSelectionRange(pos + insert.length, pos + insert.length);
    ta.scrollTop = ta.scrollHeight;
    hooks.after();
  }
}

// ENTER = HITUNG: reformat semua baris lalu sisipkan separator + hasil
// berjalan langsung di editor (port handleEnterKey)
function handleEnterKey(e, ta, hooks) {
  let pos = ta.selectionStart;
  let val = ta.value;

  if (ta.selectionStart !== ta.selectionEnd) return;

  const lineStart = val.lastIndexOf('\n', pos - 1) + 1;
  const lineEnd = pos;
  const currentLine = val.slice(lineStart, lineEnd).trim();

  if (!currentLine) return;

  const isOpLine = /^([+\-*/]?)\s*[\d.,]+\s*(k|rb|jt|juta|ribu|m|b|bn)?%?/i.test(currentLine);
  if (!isOpLine) return;

  const opMatch = currentLine.match(/^([+\-*/]?)\s*([\d.,]+(?:k|rb|jt|juta|ribu|m|b|bn)?%?)\s*(.*)$/i);
  if (!opMatch) return;

  e.preventDefault();

  const reformattedVal = reformatAllOpLines(val);
  if (reformattedVal !== val) {
    ta.value = reformattedVal;
    const newLines = reformattedVal.split('\n');
    const currentLineIdxNew = val.slice(0, pos).split('\n').length - 1;
    let newPos = 0;
    for (let i = 0; i <= currentLineIdxNew; i++) newPos += newLines[i].length + 1;
    newPos = newPos - 1;
    ta.setSelectionRange(newPos, newPos);
    val = ta.value;
    pos = newPos;
  }

  const allLines = val.split('\n');
  const currentLineIdx = val.slice(0, pos).split('\n').length - 1;

  const opLinesForEval = [];
  for (let i = 0; i <= currentLineIdx; i++) {
    const trimmed = allLines[i].trim();
    if (isSepLine(trimmed) || isResultLine(trimmed)) continue;
    opLinesForEval.push(allLines[i]);
  }

  const result = evaluate(opLinesForEval);
  const running = result.grandTotal;

  const separator = '─────';
  const resultLine = formatResultLine(running);
  const insert = '\n' + separator + '\n' + resultLine + '\n';

  const before = val.slice(0, pos);
  const after = val.slice(pos);
  ta.value = before + insert + after;

  const newCursorPos = pos + insert.length;
  ta.setSelectionRange(newCursorPos, newCursorPos);
  ta.scrollTop = ta.scrollHeight;

  hooks.after();
}

// Double-click baris hasil → copy nilai (port handleResultLineDoubleClick)
function handleResultLineDoubleClick(ta, toast) {
  const pos = ta.selectionStart;
  const val = ta.value;
  const lineStart = val.lastIndexOf('\n', pos - 1) + 1;
  let lineEnd = val.indexOf('\n', pos);
  if (lineEnd === -1) lineEnd = val.length;
  const currentLine = val.slice(lineStart, lineEnd);

  if (currentLine.trim().startsWith('→')) {
    const match = currentLine.match(/→\s*([\d.,-]+)\s*📋?/);
    if (match) {
      const numStr = match[1];
      copyText(numStr, () => toast('📋 ' + numStr + ' tersalin'));
    }
  }
}

// ============================================================================
// Aksi lembar — salin / cetak resi / simpan / kosongkan (port tape-cs.js)
// ============================================================================

async function copyText(text, onOk) {
  try {
    await navigator.clipboard.writeText(text);
    if (onOk) onOk();
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); if (onOk) onOk(); } catch (e2) {}
    ta.remove();
  }
}

function buildPlainTextForCopy(opLines, result) {
  const out = [];
  out.push('🧮 RecallTape');
  out.push(new Date().toLocaleString('id-ID'));
  out.push('');
  for (let i = 0; i < opLines.length; i++) {
    const trimmed = opLines[i].trim();
    if (!trimmed) continue;
    out.push(trimmed);
  }
  out.push('─────');
  out.push('→  ' + formatNumber(result.grandTotal) + '  📋');
  return out.join('\n');
}

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Cetak resi 80mm (port doPrint — HTML & CSS resi identik dengan addon)
function doPrint(text, toast, flashBtn) {
  if (!text.trim()) { toast('Tape kosong'); return; }

  const allLines = text.split('\n');
  const lines = [];
  lines.push('<div class="rct-hd"><h1>🧮 RecallTape</h1><div class="rct-date">' + new Date().toLocaleString('id-ID') + '</div></div>');
  for (const ln of allLines) {
    const trimmed = ln.trim();
    if (!trimmed) continue;
    if (isSepLine(trimmed)) { lines.push('<div class="rct-sep"></div>'); continue; }
    if (isResultLine(trimmed)) {
      const match = trimmed.match(/→\s*([\d.,-]+)\s*📋?/);
      if (match) lines.push('<div class="rct-line rct-subtotal"><span class="rct-op">→</span><span class="rct-val">' + esc(match[1]) + '</span></div>');
      continue;
    }
    const opMatch = trimmed.match(/^([+\-*/]?)\s*([\d.,]+(?:k|rb|jt|juta|ribu|m|b|bn)?%?)\s*(.*)$/i);
    if (opMatch) {
      const sym = opMatch[1] || '+';
      const amt = opMatch[2];
      const note = opMatch[3] || '';
      const noteHtml = note ? '<span class="rct-note">' + esc(note) + '</span>' : '';
      lines.push('<div class="rct-line"><span class="rct-op">' + sym + '</span><span class="rct-amt">' + esc(amt) + '</span>' + noteHtml + '</div>');
    } else {
      lines.push('<div class="rct-line rct-comment">' + esc(trimmed) + '</div>');
    }
  }

  const html = '<!DOCTYPE html><html lang="id"><head><meta charset="utf-8"><title>RecallTape Resi</title>' +
    '<style>' +
    '@page { size: 80mm auto; margin: 2mm; }' +
    '* { box-sizing: border-box; margin: 0; padding: 0; }' +
    'html, body { background: #fff; color: #000; font-family: "Courier New", Menlo, Consolas, monospace; font-size: 10px; line-height: 1.55; }' +
    'body { padding: 4mm; max-width: 72mm; margin: 0 auto; }' +
    '.rct-hd { text-align: center; padding-bottom: 3mm; border-bottom: 1px dashed #000; margin-bottom: 3mm; }' +
    '.rct-hd h1 { font-size: 13px; font-weight: 700; }' +
    '.rct-date { font-size: 9px; color: #666; margin-top: 1px; }' +
    '.rct-line { padding: 1px 0; display: flex; align-items: baseline; }' +
    '.rct-line .rct-op { width: 12px; flex: none; font-weight: 700; }' +
    '.rct-line .rct-amt { flex: 1; padding-left: 4px; font-variant-numeric: tabular-nums; }' +
    '.rct-line .rct-note { flex: none; max-width: 50%; margin-left: 6px; color: #555; font-family: Arial, sans-serif; font-size: 9px; }' +
    '.rct-comment { color: #666; font-family: Arial, sans-serif; font-style: italic; padding-left: 14px; }' +
    '.rct-sep { border-top: 1px dashed #999; margin: 3px 0; }' +
    '.rct-subtotal { font-weight: 700; padding-top: 2px; }' +
    '.rct-subtotal .rct-val { font-variant-numeric: tabular-nums; }' +
    '.rct-foot { margin-top: 4mm; padding-top: 2mm; border-top: 1px dashed #000; text-align: center; font-size: 9px; color: #666; font-family: Arial, sans-serif; }' +
    '@media print { body { padding: 2mm; } }' +
    '</style></head><body>' +
    lines.join('\n') +
    '<div class="rct-foot">RecallFox · dicetak ' + new Date().toISOString().slice(0, 10) + '</div>' +
    '</body></html>';

  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;opacity:0;pointer-events:none;z-index:-1;';
  document.body.appendChild(iframe);
  try {
    const doc = iframe.contentWindow.document;
    doc.open(); doc.write(html); doc.close();
  } catch (e) {
    toast('Gagal mencetak: ' + e.message);
    iframe.remove();
    return;
  }
  setTimeout(() => {
    try {
      iframe.contentWindow.focus();
      iframe.contentWindow.print();
    } catch (e) {
      toast('Gagal print: ' + e.message);
    }
    setTimeout(() => { try { iframe.remove(); } catch (e) {} }, 2000);
  }, 300);
  if (flashBtn) flashBtn('.rts-print');
}

// ============================================================================
// Ikon (port dari template tape-cs.js)
// ============================================================================
const SVG = {
  calc: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v6"/><path d="M3 11h18"/><path d="M3 11v8a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-8"/><path d="M7 15h4"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>',
  palette: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22a10 10 0 1 1 10-10c0 2.2-1.8 4-4 4h-2.2a1.8 1.8 0 0 0-1.3 3.1c.3.3.5.7.5 1.1 0 .9-.7 1.8-1.8 1.8z"/><circle cx="7.5" cy="11.5" r="1" fill="currentColor"/><circle cx="10.5" cy="7.5" r="1" fill="currentColor"/><circle cx="15" cy="8" r="1" fill="currentColor"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
  print: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  save: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'
};

const PLACEHOLDER = `Ketik angka + operator, Enter = hitung otomatis.

+   1200
-    200  lalu Enter:
─────
→    1.000  📋

Percent: + 10% · Suffix: k/rb/jt
Keterangan: + 1200  Gaji
Double-click baris hasil (→) = copy nilai
＋ = lembar baru · ▾ = gulung · ✕ = tutup`;

// ============================================================================
// Render — semua lembar terbuka, berurutan dibuat (terlama di atas)
// ============================================================================
export function renderTapeSheets(container, user) {
  if (!container) return;

  // Migrasi: pengguna lama punya rf_tape_session saja → jadi lembar pertama.
  let list = getList();
  if (!list.length) {
    const legacy = loadSession();
    list = [newData({ text: legacy && legacy.trim() ? legacy : '' })];
    putList(list);
  }

  container.innerHTML = '';
  const open = list.filter(i => i.open);

  if (!open.length) {
    container.innerHTML =
      '<div class="rts-empty">' +
        '<div class="rts-empty-ic">' + SVG.calc + '</div>' +
        '<h3>Belum ada lembar RecallTape</h3>' +
        '<p>Kalkulator pita ala kasir: ketik angka + operator,<br>Enter = hitung otomatis, hasil langsung tersimpan.</p>' +
        '<button class="rts-empty-new" id="rtsEmptyNew">' + SVG.plus + 'Lembar baru</button>' +
      '</div>';
    const btn = document.getElementById('rtsEmptyNew');
    if (btn) btn.addEventListener('click', () => { createSheet(container, user, {}); });
    return;
  }

  for (const data of open) mountSheet(container, user, data);

  // Klik di luar lembar → tutup palet warna yang terbuka (port pola addon)
  if (!container.__palOutside) {
    container.__palOutside = true;
    document.addEventListener('mousedown', (e) => {
      const p = e.composedPath ? e.composedPath() : [e.target];
      document.querySelectorAll('.rts.rts-pal-open').forEach(card => {
        if (!p.includes(card)) card.classList.remove('rts-pal-open');
      });
    }, true);
  }
}

// ============================================================================
// Satu lembar — kartu + seluruh perilaku editor
// ============================================================================
function mountSheet(container, user, data) {
  const card = document.createElement('section');
  card.className = 'rts' + (data.collapsed ? ' rts-min' : '');
  card.dataset.id = data.id;
  card.innerHTML =
    '<div class="rts-palette" role="menu">' +
      RF_PALETTE.map(c =>
        '<button class="rts-swatch' + ((normColor(data.color) || RF_DEF_COLOR) === c ? ' on' : '') + '" data-c="' + c + '" title="' + c + '" style="background:' + RF_SWATCH[c] + '"></button>'
      ).join('') +
    '</div>' +
    '<div class="rts-hd">' +
      '<div class="rts-title">' + SVG.calc + 'RecallTape</div>' +
      '<div class="rts-actions">' +
        '<button class="rbtn rts-collapse" title="Gulung / buka lagi">' + SVG.chevron + '</button>' +
        '<button class="rbtn rts-color" title="Warna lembar">' + SVG.palette + '</button>' +
        '<button class="rbtn rts-new" title="Lembar baru (RecallTape baru)">' + SVG.plus + '</button>' +
        '<button class="rbtn rts-print" title="Cetak resi (PDF)">' + SVG.print + '</button>' +
        '<button class="rbtn rts-copy" title="Salin sebagai teks">' + SVG.copy + '</button>' +
        '<button class="rbtn rts-save" title="Simpan ke Catatan (Ctrl+Enter)">' + SVG.save + '</button>' +
        '<button class="rbtn rts-clear" title="Kosongkan">' + SVG.trash + '</button>' +
        '<button class="rbtn rts-close" title="Tutup lembar ini">' + SVG.close + '</button>' +
      '</div>' +
    '</div>' +
    '<textarea class="rts-editor" spellcheck="false" placeholder="' + esc(PLACEHOLDER) + '"></textarea>' +
    '<div class="rts-status"><span class="rts-autosave">✓ Tersimpan otomatis</span></div>' +
    '<div class="rts-toast"></div>';
  container.appendChild(card);

  const ta = card.querySelector('.rts-editor');
  const statusEl = card.querySelector('.rts-autosave');
  const toastEl = card.querySelector('.rts-toast');
  let saveTimer = null;

  if (typeof data.text === 'string') ta.value = data.text;

  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('rts-show');
    setTimeout(() => toastEl.classList.remove('rts-show'), 2000);
  }
  function flashBtn(sel) {
    const btn = card.querySelector(sel);
    if (!btn) return;
    btn.classList.add('rbtn-flash');
    setTimeout(() => btn.classList.remove('rbtn-flash'), 600);
  }

  // ---- warna lembar ----
  function applyColor() {
    const c = normColor(data.color) || RF_DEF_COLOR;
    card.dataset.color = c;
    card.querySelectorAll('.rts-swatch').forEach(b => b.classList.toggle('on', b.dataset.c === c));
  }
  function setColor(c) {
    if (!normColor(c)) return;
    data.color = c;
    applyColor();
    patchLocal(data.id, { color: c });
  }
  applyColor();
  card.querySelector('.rts-color').addEventListener('click', () => card.classList.toggle('rts-pal-open'));
  card.querySelector('.rts-palette').addEventListener('click', (e) => {
    const b = e.target && e.target.closest && e.target.closest('.rts-swatch');
    if (!b || !b.dataset) return;
    setColor(b.dataset.c);
    card.classList.remove('rts-pal-open');
  });

  // ---- status live + auto-save 400ms ----
  function updateStatus() {
    const result = evaluate(collectOpLines(ta.value));
    if (result.error) {
      statusEl.textContent = '⚠ ' + result.error;
      statusEl.style.color = '#FB7185';
    } else {
      statusEl.textContent = '✓ Tersimpan otomatis · Total: ' + formatNumber(result.grandTotal);
      statusEl.style.color = '';
    }
  }
  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    statusEl.textContent = '⏳ Menyimpan…';
    statusEl.style.color = '#F0B64A';
    saveTimer = setTimeout(() => {
      try {
        data.text = ta.value;
        const list = getList();
        const it = list.find(i => i.id === data.id);
        if (it) it.text = ta.value;
        else list.push(JSON.parse(JSON.stringify(data)));
        putList(list);
        // mirror lembar pertama → rf_tape_session (kompat pembaca lama)
        if (list.length && list[0].id === data.id) { try { saveSession(ta.value); } catch (e) {} }
      } catch (e) {}
      updateStatus();
    }, 400);
  }

  const hooks = { after: () => { updateStatus(); scheduleSave(); } };

  ta.addEventListener('input', () => { updateStatus(); scheduleSave(); });
  ta.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); doSave(); return; }
    try {
      handleAutoFormatKey(e, ta, hooks);
      if (e.key === 'Enter' && !e.shiftKey) handleEnterKey(e, ta, hooks);
    } catch (err) { console.error('[RecallFox/Tape] keydown error:', err); }
  });
  ta.addEventListener('dblclick', () => handleResultLineDoubleClick(ta, toast));
  updateStatus();

  // ---- aksi header ----
  async function doCopy() {
    const opLines = collectOpLines(ta.value);
    const result = evaluate(opLines);
    await copyText(buildPlainTextForCopy(opLines, result), () => { flashBtn('.rts-copy'); toast('📋 Tape tersalin'); });
  }
  async function doSave() {
    const text = ta.value;
    if (!text.trim()) { toast('Tape kosong'); return; }
    try {
      const opLines = collectOpLines(text);
      const result = evaluate(opLines);
      const md = buildPlainTextForCopy(opLines, result);
      const btn = card.querySelector('.rts-save');
      if (btn) btn.disabled = true;
      const res = await createFileItem(user, {
        title: '🧮 RecallTape — Total: ' + formatNumber(result.grandTotal),
        body: md,
        tags: ['tape', 'md'],
        source: { kind: 'md', mime: 'text/markdown', fileName: 'pita-' + Date.now() + '.md', size: 0, uploadedFrom: 'pwa-tape', capturedAt: new Date().toISOString() }
      });
      if (btn) btn.disabled = false;
      if (res.ok) { toast('✓ Tersimpan ke Catatan'); flashBtn('.rts-save'); }
      else toast('Gagal simpan: ' + (res.error || 'unknown'));
    } catch (e) { toast('Gagal simpan: ' + e.message); }
  }
  function doClear() {
    if (!ta.value.trim()) return;
    if (!confirm('Kosongkan tape?')) return;
    ta.value = '';
    updateStatus();
    scheduleSave();
    ta.focus();
    flashBtn('.rts-clear');
  }

  card.querySelector('.rts-copy').addEventListener('click', doCopy);
  card.querySelector('.rts-save').addEventListener('click', doSave);
  card.querySelector('.rts-print').addEventListener('click', () => doPrint(ta.value, toast, sel => flashBtn(sel)));
  card.querySelector('.rts-clear').addEventListener('click', doClear);
  card.querySelector('.rts-collapse').addEventListener('click', () => {
    data.collapsed = !data.collapsed;
    card.classList.toggle('rts-min', !!data.collapsed);
    patchLocal(data.id, { collapsed: data.collapsed });
  });
  card.querySelector('.rts-close').addEventListener('click', () => {
    card.remove();
    patchLocal(data.id, { open: false });
    if (!container.querySelector('.rts')) renderTapeSheets(container, user);
  });
  card.querySelector('.rts-new').addEventListener('click', () => createSheet(container, user, {}));
}

// Lembar baru — warna otomatis paling jarang dipakai (port createTapeInstance)
function createSheet(container, user, extra) {
  const preList = getList();
  if (!extra || !normColor(extra.color)) {
    extra = extra || {};
    extra.color = pickAutoColor(preList);
  }
  const d = newData(extra);
  const list = getList();
  list.push(d);
  putList(list);

  // Kalau sebelumnya tampil empty state, bersihkan dulu
  const empty = container.querySelector('.rts-empty');
  if (empty) empty.remove();

  mountSheet(container, user, d);
  const card = container.querySelector('.rts[data-id="' + d.id + '"]');
  if (card) {
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const ta = card.querySelector('.rts-editor');
    setTimeout(() => { try { ta.focus(); } catch (e) {} }, 120);
  }
}
