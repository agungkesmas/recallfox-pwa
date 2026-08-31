// src/lib/tape.js — RecallTape: parser & evaluator kalkulator pita
// v1.14.0: PORT 1:1 dari addon lib/tape.js (v3.24.x) — logika parse/eval
// SAMA PERSIS dengan addon supaya teks pita kompatibel bolak-balik.
// Perbedaan hanya penyimpanan: addon pakai browser.storage.local,
// PWA pakai localStorage (local-first, tanpa schema Supabase).
//
// Format input (satu baris per entri):
//   250000 Gaji Utama     → tambah 250000, catatan "Gaji Utama"
//   + 50k Bonus projek    → tambah 50000
//   - 20rb Makan siang    → kurang 20000
//   * 2 Pajak 2x          → total berjalan dikali 2
//   / 4 Bagi 4 orang      → total berjalan dibagi 4
//   = Subtotal            → cetak subtotal
//   + 19% PPN             → tambah 19% dari total berjalan
//   2,5jt Honorarium      → 2500000 (koma = desimal Indonesia)

// ============================================================================
// Parsing angka — ramah Indonesia + Inggris
// ============================================================================

export function parseAmount(token) {
  if (token == null) return null;
  let s = String(token).trim().toLowerCase();
  if (!s) return null;

  // Buang simbol mata uang yang menyusup
  s = s.replace(/^(rp|idr|usd|\$|eur|€|£)\s*/i, '');
  s = s.replace(/\s+/g, '');

  if (!s) return null;

  // Deteksi & lepas suffix (terpanjang dulu agar tidak tabrakan prefix)
  const suffixMap = [
    { re: /^([\d.,]+)juta$/i, mult: 1000000 },
    { re: /^([\d.,]+)jt$/i,   mult: 1000000 },
    { re: /^([\d.,]+)rb$/i,   mult: 1000 },
    { re: /^([\d.,]+)ribu$/i, mult: 1000 },
    { re: /^([\d.,]+)k$/i,    mult: 1000 },
    { re: /^([\d.,]+)m$/i,    mult: 1000000 },       // million ala Inggris
    { re: /^([\d.,]+)b$/i,    mult: 1000000000 },    // billion
    { re: /^([\d.,]+)bn$/i,   mult: 1000000000 }
  ];

  let mult = 1;
  let digits = s;
  for (const sf of suffixMap) {
    const m = s.match(sf.re);
    if (m) {
      digits = m[1];
      mult = sf.mult;
      break;
    }
  }

  if (!/^[\d.,]+$/.test(digits)) return null;
  if (digits === '.' || digits === ',') return null;

  // Tentukan pemisah desimal: heuristic grup 3 digit = ribuan
  const dots = (digits.match(/\./g) || []).length;
  const commas = (digits.match(/,/g) || []).length;

  let normalized;
  if (dots === 0 && commas === 0) {
    normalized = digits;
  } else if (dots > 0 && commas === 0) {
    const groups = digits.split('.');
    if (groups.length === 1) {
      normalized = groups[0];
    } else {
      const middleOk = groups.slice(1, -1).every(g => g.length === 3);
      const lastLen = groups[groups.length - 1].length;
      if (middleOk && lastLen === 3) {
        normalized = groups.join('');
      } else {
        const intPart = groups.slice(0, -1).join('');
        const decPart = groups[groups.length - 1];
        normalized = intPart + '.' + decPart;
      }
    }
  } else if (dots === 0 && commas > 0) {
    const groups = digits.split(',');
    if (groups.length === 1) {
      normalized = groups[0];
    } else {
      const middleOk = groups.slice(1, -1).every(g => g.length === 3);
      const lastLen = groups[groups.length - 1].length;
      if (middleOk && lastLen === 3) {
        normalized = groups.join('');
      } else {
        const intPart = groups.slice(0, -1).join('');
        const decPart = groups[groups.length - 1];
        normalized = intPart + '.' + decPart;
      }
    }
  } else {
    // Dua-duanya ada — yang paling KANAN = desimal
    const lastDot = digits.lastIndexOf('.');
    const lastComma = digits.lastIndexOf(',');
    if (lastDot > lastComma) {
      const intPart = digits.slice(0, lastDot).replace(/,/g, '');
      const decPart = digits.slice(lastDot + 1);
      normalized = intPart + '.' + decPart;
    } else {
      const intPart = digits.slice(0, lastComma).replace(/\./g, '');
      const decPart = digits.slice(lastComma + 1);
      normalized = intPart + '.' + decPart;
    }
  }

  if (!/^\d+(\.\d+)?$/.test(normalized)) return null;
  const value = parseFloat(normalized);
  if (!isFinite(value)) return null;

  return value * mult;
}

// ============================================================================
// Parsing baris → { op, amount, note, raw }
// ============================================================================

const OPS = new Set(['+', '-', '*', '/', '=', '×', '÷']);

export function parseLine(rawLine) {
  const raw = rawLine;
  const line = rawLine.replace(/\r/, '').trim();
  if (!line) return null;
  // Baris komentar (# atau //)
  if (/^(#|\/\/)/.test(line)) return { op: 'comment', amount: null, note: line, raw };

  let op = '+';
  let rest = line;
  const firstChar = line[0];
  if (OPS.has(firstChar)) {
    if (firstChar === '×') op = '*';
    else if (firstChar === '÷') op = '/';
    else op = firstChar;
    rest = line.slice(1).trim();
  }

  if (op === '=') {
    const m = rest.match(/^([\d.,]+(?:\s*(?:juta|jt|ribu|rb|bn|k|m|b))?\b)(?:\s+|$)(.*)$/i);
    if (m) {
      const amtStr = m[1].trim();
      const amt = parseAmount(amtStr);
      if (amt != null) {
        return { op, amount: amt, note: (m[2] || '').trim(), raw };
      }
    }
    return { op: '=', amount: null, note: rest, raw };
  }

  // +,-,*,/ — parse amount dari awal `rest`; dukung persen (v3.14.1 addon)
  const m = rest.match(/^([\d.,]+(?:\s*(?:juta|jt|ribu|rb|bn|k|m|b)\b)?)(\s*%)?(?:\s+|$)(.*)$/i);
  if (!m) {
    return { op: 'note', amount: null, note: rest, raw };
  }
  const amtStr = m[1].trim();
  const isPercent = !!m[2];
  const note = (m[3] || '').trim();
  const amt = parseAmount(amtStr);
  if (amt == null) {
    return { op: 'note', amount: null, note: rest, raw };
  }
  return { op, amount: amt, isPercent, note, raw };
}

// ============================================================================
// Evaluator — array baris → pita terstruktur dengan total berjalan
// ============================================================================

export function evaluate(input) {
  const lines = Array.isArray(input)
    ? input
    : String(input).split('\n');

  let running = 0;
  let error = null;
  const entries = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const parsed = parseLine(line);
    if (!parsed) continue; // baris kosong

    if (parsed.op === 'comment' || parsed.op === 'note') {
      entries.push({
        op: parsed.op, amount: null, note: parsed.note, raw: parsed.raw,
        running, display: null, kind: parsed.op
      });
      continue;
    }

    if (parsed.op === '=') {
      entries.push({
        op: '=', amount: parsed.amount, note: parsed.note, raw: parsed.raw,
        running, display: running, kind: 'subtotal'
      });
      continue;
    }

    const amt = parsed.amount || 0;
    let next;
    // Percent: + 19% → running += running*19/100; * 50% → running *= 0.5
    let percentValue = null;
    if (parsed.isPercent && (parsed.op === '+' || parsed.op === '-')) {
      percentValue = running * (amt / 100);
      if (parsed.op === '+') next = running + percentValue;
      else next = running - percentValue;
    } else if (parsed.isPercent && parsed.op === '*') {
      percentValue = amt / 100;
      next = running * percentValue;
    } else if (parsed.isPercent && parsed.op === '/') {
      percentValue = amt / 100;
      if (percentValue === 0) {
        error = 'Baris ' + (i + 1) + ': pembagian nol persen';
        next = running;
      } else {
        next = running / percentValue;
      }
    } else {
      switch (parsed.op) {
        case '+': next = running + amt; break;
        case '-': next = running - amt; break;
        case '*': next = running * amt; break;
        case '/':
          if (amt === 0) {
            error = 'Baris ' + (i + 1) + ': pembagian nol';
            next = running;
          } else {
            next = running / amt;
          }
          break;
        default:
          next = running + amt;
      }
    }
    running = next;
    entries.push({
      op: parsed.op, amount: amt, isPercent: !!parsed.isPercent, percentValue,
      note: parsed.note, raw: parsed.raw, running, display: running, kind: 'op'
    });
  }

  return { entries, grandTotal: running, error };
}

// ============================================================================
// Format
// ============================================================================

export const OP_SYMBOL = { '+': '+', '-': '−', '*': '×', '/': '÷', '=': '=' };

// 1234567.89 → "1.234.567,89"
export function formatNumber(n) {
  if (n == null || !isFinite(n)) return '0';
  const neg = n < 0;
  const abs = Math.abs(n);
  const rounded = Math.round(abs * 100) / 100;
  const parts = String(rounded).split('.');
  const intPart = parts[0];
  const decPart = parts[1];
  const intWithSep = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const out = decPart ? intWithSep + ',' + decPart : intWithSep;
  return neg ? '-' + out : out;
}

// 250000 → "Rp 250.000"
export function formatCurrency(n) {
  if (n == null || !isFinite(n)) return 'Rp 0';
  return 'Rp ' + formatNumber(n);
}

// Pita → teks polos ramah WhatsApp/Email
export function toPlainText(tape) {
  const { entries, grandTotal } = tape;
  const lines = [];
  const amountCol = 14;
  for (const e of entries) {
    if (e.kind === 'comment') { lines.push('# ' + e.note); continue; }
    if (e.kind === 'note') { lines.push('  ' + e.note); continue; }
    if (e.kind === 'subtotal') {
      lines.push('  ' + '─'.repeat(amountCol + 4));
      const label = (e.note || 'Subtotal').slice(0, 20);
      const amt = formatNumber(e.display);
      lines.push('  ' + label.padEnd(20) + ' ' + amt.padStart(amountCol));
      continue;
    }
    const sym = OP_SYMBOL[e.op] || '+';
    const amt = formatNumber(e.amount) + (e.isPercent ? '%' : '');
    const note = e.note || '';
    lines.push((sym + ' ' + amt.padStart(amountCol) + '  ' + note).trimEnd());
  }
  lines.push('  ' + '═'.repeat(amountCol + 4));
  const totalStr = formatNumber(grandTotal);
  lines.push('  ' + 'GRAND TOTAL'.padEnd(20) + ' ' + totalStr.padStart(amountCol));
  return lines.join('\n');
}

// Pita → Markdown untuk disimpan ke Vault
export function toMarkdown(tape, opts = {}) {
  const { entries, grandTotal } = tape;
  const lines = [];
  if (opts.title) lines.push('# ' + opts.title, '');
  lines.push('| Operator | Amount | Note | Running |');
  lines.push('| --- | ---: | --- | ---: |');
  for (const e of entries) {
    if (e.kind === 'comment') { lines.push('_# ' + e.note + '_'); continue; }
    if (e.kind === 'note') { lines.push('&nbsp; |  | ' + e.note + ' |  |'); continue; }
    if (e.kind === 'subtotal') {
      lines.push('**=** | **' + formatNumber(e.display) + '** | **' + (e.note || 'Subtotal') + '** | **' + formatNumber(e.running) + '** |');
      continue;
    }
    lines.push('`' + (OP_SYMBOL[e.op] || '+') + '` | ' + formatNumber(e.amount) + (e.isPercent ? '%' : '') + ' | ' + (e.note || '') + ' | ' + formatNumber(e.running) + ' |');
  }
  lines.push('');
  lines.push('> **Grand Total:** `Rp ' + formatNumber(grandTotal) + '`');
  return lines.join('\n');
}

// ============================================================================
// Sesi — localStorage (pengganti browser.storage.local di addon)
// ============================================================================

const SESSION_KEY = 'rf_tape_session';

export function loadSession() {
  try { return localStorage.getItem(SESSION_KEY) || ''; }
  catch (e) { return ''; }
}

export function saveSession(text) {
  try { localStorage.setItem(SESSION_KEY, String(text || '')); } catch (e) {}
}
