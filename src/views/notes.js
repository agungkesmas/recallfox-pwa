// src/views/notes.js — Notes tab: list + editor + batch operations
// v1.1.0: Render to #appMain (bukan #app) supaya bottom nav + FAB persist.
// v1.1.0: openNoteEditor dipanggil dari FAB menu (tombol + → Catatan Baru).
// v1.1.0: Tambah "Copy Teks Saja" di batch mode.
// v1.5.0: Rich text editor (contenteditable + paste sanitize) + Any.do-inspired
//         toolbar (search Enter-trigger + tombol X + sort + view toggle).
//         Port dari addon v3.13.1 — supaya PWA dan addon compatible.

import { createNote, updateNote, deleteNote } from '../sync.js';
import { dbGetAllNotes } from '../db.js';

const NOTE_COLORS = [
  { id: 'default', bg: '#ffffff', fg: '#1c1917', border: '#e7e5e4' },
  { id: 'yellow',  bg: '#fef9c3', fg: '#713f12', border: '#fde047' },
  { id: 'green',   bg: '#dcfce7', fg: '#14532d', border: '#86efac' },
  { id: 'blue',    bg: '#dbeafe', fg: '#1e3a8a', border: '#93c5fd' },
  { id: 'pink',    bg: '#fce7f3', fg: '#831843', border: '#f9a8d4' },
  { id: 'purple',  bg: '#f3e8ff', fg: '#581c87', border: '#d8b4fe' },
  { id: 'orange',  bg: '#fed7aa', fg: '#7c2d12', border: '#fdba74' },
  { id: 'red',     bg: '#fecaca', fg: '#7f1d1d', border: '#fca5a5' },
  { id: 'teal',    bg: '#ccfbf1', fg: '#134e4a', border: '#5eead4' },
  { id: 'indigo',  bg: '#e0e7ff', fg: '#312e81', border: '#a5b4fc' },
  { id: 'slate',   bg: '#e2e8f0', fg: '#1e293b', border: '#cbd5e1' },
  { id: 'rose',    bg: '#ffe4e6', fg: '#881337', border: '#fda4af' }
];

let _batchMode = false;
let _batchSelected = new Set();
let _onRefresh = null;

// v1.5.0: State untuk search/sort/view — persist ke localStorage (PWA tidak punya vault.settings).
let _notesSortMode = localStorage.getItem('rf_notes_sort') || 'recent';
let _notesViewMode = localStorage.getItem('rf_notes_view') || 'list';
let _notesSearchQuery = '';

// v1.5.0: Helper — sanitize HTML untuk contenteditable (port dari addon sanitizeNoteHtml).
const NOTE_HTML_WHITELIST_TAGS = new Set([
  'P','BR','B','STRONG','I','EM','U','S','STRIKE','SPAN','DIV',
  'UL','OL','LI','DL','DT','DD',
  'H1','H2','H3','H4','H5','H6',
  'TABLE','THEAD','TBODY','TFOOT','TR','TD','TH','CAPTION','COLGROUP','COL',
  'BLOCKQUOTE','PRE','CODE','HR','A','IMG','SUB','SUP','MARK','SMALL'
]);
const NOTE_HTML_WHITELIST_ATTRS = new Set([
  'href','title','alt','src','colspan','rowspan','target','rel','width','height',
  'align','valign','bgcolor','color','data-color'
]);

function sanitizeNoteHtml(html) {
  if (!html) return '';
  try {
    const doc = new DOMParser().parseFromString('<div>' + html + '</div>', 'text/html');
    const root = doc.body.firstChild;
    if (!root) return '';
    cleanNode(root);
    return root.innerHTML;
  } catch (e) {
    return escapeHtml(html).replace(/\n/g, '<br>');
  }
}

function cleanNode(node) {
  const children = Array.from(node.childNodes);
  for (const child of children) {
    if (child.nodeType === Node.TEXT_NODE) continue;
    if (child.nodeType === Node.COMMENT_NODE) {
      node.removeChild(child);
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) {
      node.removeChild(child);
      continue;
    }
    const tag = child.tagName;
    if (['SCRIPT','STYLE','IFRAME','OBJECT','EMBED','META','LINK','NOSCRIPT','TEMPLATE','FORM','INPUT','BUTTON','TEXTAREA','SELECT','OPTION'].includes(tag)) {
      node.removeChild(child);
      continue;
    }
    if (!NOTE_HTML_WHITELIST_TAGS.has(tag)) {
      const parent = node;
      const frag = document.createDocumentFragment();
      while (child.firstChild) frag.appendChild(child.firstChild);
      parent.insertBefore(frag, child);
      parent.removeChild(child);
      continue;
    }
    const attrs = Array.from(child.attributes);
    for (const attr of attrs) {
      const name = attr.name.toLowerCase();
      const value = attr.value;
      if (name.startsWith('on')) { child.removeAttribute(attr.name); continue; }
      if (!NOTE_HTML_WHITELIST_ATTRS.has(name)) { child.removeAttribute(attr.name); continue; }
      if ((name === 'href' || name === 'src') && /^\s*javascript:/i.test(value)) {
        child.removeAttribute(attr.name); continue;
      }
      if (name === 'src' && value.startsWith('data:') && !value.startsWith('data:image/')) {
        child.removeAttribute(attr.name); continue;
      }
      if (tag === 'A' && name === 'href') {
        child.setAttribute('target', '_blank');
        child.setAttribute('rel', 'noopener noreferrer');
      }
    }
    cleanNode(child);
  }
}

function loadNoteBody(body) {
  if (!body) return '';
  if (/<(p|br|b|strong|i|em|u|s|strike|span|div|ul|ol|li|table|thead|tbody|tr|td|th|h[1-6]|blockquote|pre|code|hr|a|img)\b/i.test(body)) {
    return sanitizeNoteHtml(body);
  }
  return escapeHtml(body).replace(/\n/g, '<br>');
}

function stripHtmlForPreview(html) {
  if (!html) return '';
  if (!/<[a-z][\s\S]*>/i.test(html)) return html;
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  return (tmp.textContent || '').replace(/\u00a0/g, ' ');
}

// ===========================================================================
// v1.16.0: TASK BULLET ENGINE — port perilaku RecallNote addon (notes-cs.js
// v3.24.2/v3.24.3, pendekatan Chrome-native: tanpa shim FF). Perilaku:
//   - Ketik '>' di awal baris plain → baris jadi SUBTASK (radio + indent),
//     marker '>' DITELAN (bukan dibiarkan jadi teks); '>x' → SELESAI (coret).
//   - Spasi pertama ketikan user setelah konversi ikut ditelan (anti '>  teks'
//     dobel spasi — serialisasi tetap '> teks').
//   - '>' yang diketik DI DALAM baris task redundan → ditelan in-place
//     ('>' / '> ' tetap task; '>x' / '>x ' → sekalian selesai). Paritas addon.
//   - Enter di baris task = baris task baru ber-radio (ala bullet Word) sampai
//     Enter di bullet KOSONG atau Backspace di depan = keluar mode.
//   - Backspace di depan baris done = un-done dulu; di depan baris task =
//     lepas mode (dedent); baris plain = default (merge native).
//   - Klik gutter kiri (<=25px) baris task = toggle radio: selesai → coret +
//     pindah ke dasar deret; aktif lagi → tepat sebelum blok done pertama.
//   - FORMAT TERSIMPAN INTEROP ADDON: baris task/done diserialisasi sebagai
//     teks '> teks' / '>x teks' (identik serializeTaskLine addon) sehingga
//     catatan yang sama tampil ber-radio di addon floating & PWA. Class CSS
//     TIDAK disimpan — di-rederive dari teks setiap kali editor dibuka
//     (sanitizer memang membuang atribut class).
// Model baris: div/p top-level TANPA nested block ("baris sederhana"). Blok
// kaya (tabel, heading, list) tidak pernah disentuh engine ini.
// ===========================================================================
const RF_GUTTER = 25;
const RF_BLOCK_TAGS = new Set(['DIV','P','H1','H2','H3','H4','H5','H6','UL','OL','TABLE','THEAD','TBODY','TFOOT','TR','BLOCKQUOTE','PRE','DL','DT','DD','HR','CAPTION','COLGROUP']);

function rfParseLine(raw) {
  const s = String(raw == null ? '' : raw);
  // NBSP (\u00A0): Chrome contenteditable memasukkan spasi ketikan sebagai
  // nbsp saat di ujung baris — marker '> ' dengan nbsp TETAP diakui.
  const t = s.replace(/^[\s\u00A0]+/, '');
  if (t === '>') return { kind: 'task', text: '' };
  if (t === '>x') return { kind: 'done', text: '' };
  if (t.indexOf('>x ') === 0 || t.indexOf('>x\u00A0') === 0) return { kind: 'done', text: t.slice(3) };
  if (t.indexOf('> ') === 0 || t.indexOf('>\u00A0') === 0) return { kind: 'task', text: t.slice(2) };
  return { kind: 'plain', text: s };
}

function rfSerializeLine(kind, text) {
  const t = String(text == null ? '' : text);
  if (kind === 'done') return '>x ' + t;
  if (kind === 'task') return '> ' + t;
  return t;
}

function rfIsSimpleLine(el) {
  if (!el || el.nodeType !== 1 || !RF_BLOCK_TAGS.has(el.tagName)) return false;
  return !Array.from(el.children || []).some(c => c.tagName !== 'BR' && RF_BLOCK_TAGS.has(c.tagName));
}

function rfSimpleLines(editor) {
  return Array.from(editor.children || []).filter(el =>
    (el.tagName === 'DIV' || el.tagName === 'P') && rfIsSimpleLine(el));
}

function rfFirstText(n) {
  try {
    if (!n) return null;
    if (n.nodeType === 3) return n;
    for (const c of (n.childNodes || [])) { const d = rfFirstText(c); if (d) return d; }
  } catch (e) {}
  return null;
}

function rfCaretOffsetIn(el) {
  try {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return -1;
    const r = sel.getRangeAt(0);
    if (!r.collapsed || !el.contains(r.startContainer)) return -1;
    const pre = r.cloneRange();
    pre.selectNodeContents(el);
    pre.setEnd(r.startContainer, r.startOffset);
    return pre.toString().length;
  } catch (e) { return -1; }
}

function rfPlaceCaretAtChar(el, off) {
  try {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    let acc = 0, n;
    while ((n = walker.nextNode())) {
      const len = n.textContent.length;
      // v1.16.0: LEWATI text node kosong — caret di node ber-length 0 sering
      // dinormalisasi Chrome ke ujung konten sebelumnya (baris salah). Bentuk
      // caret native Chrome setelah Enter adalah element-offset (div, 0) —
      // bentuk itulah yang dipakai fallback di bawah untuk baris kosong.
      if (len > 0 && acc + len >= off) {
        const r = document.createRange();
        r.setStart(n, Math.max(0, off - acc));
        r.collapse(true);
        const sel = window.getSelection();
        sel.removeAllRanges(); sel.addRange(r);
        return;
      }
      acc += len;
    }
    // Baris kosong / hanya <br> → caret element-offset (el, 0) — bentuk native
    // Chrome setelah Enter; (el, childCount) setelah <br> juga terkanonikalisasi.
    if ((el.textContent || '') === '') {
      const r = document.createRange();
      r.setStart(el, 0);
      r.collapse(true);
      const sel = window.getSelection();
      sel.removeAllRanges(); sel.addRange(r);
      return;
    }
    const r = document.createRange();
    r.selectNodeContents(el); r.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges(); sel.addRange(r);
  } catch (e) {}
}

function rfFocusedLine(editor) {
  try {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    let node = sel.getRangeAt(0).startContainer;
    let guard = 0;
    while (node && guard++ < 30) {
      if (node.nodeType === 1 && node.parentNode === editor) return node;
      node = node.parentNode;
    }
  } catch (e) {}
  return null;
}

// Normalisasi alur datar root-level (<br> / text node liar, biasanya sisa
// paste atau catatan plain-text lama) menjadi div-per-baris — paritas model
// addon (rfRebuild). Blok kaya dilewati apa adanya. Caret dipulihkan.
function rfNormalizeRootFlow(editor) {
  let hasFlow = false;
  for (const n of editor.childNodes) {
    if ((n.nodeType === 3 && n.textContent) || (n.nodeType === 1 && n.tagName === 'BR')) { hasFlow = true; break; }
  }
  if (!hasFlow) return;

  // Simpan posisi caret dalam flow (index run + offset char) sebelum rebuild
  const sel = window.getSelection();
  let caretRun = -1, caretOff = -1;
  if (sel && sel.rangeCount) {
    const r = sel.getRangeAt(0);
    const inRoot = r.collapsed && (r.startContainer === editor ||
      (r.startContainer.nodeType === 3 && r.startContainer.parentNode === editor));
    if (inRoot) {
      const kids = Array.from(editor.childNodes);
      const idx = r.startContainer === editor ? r.startOffset : kids.indexOf(r.startContainer);
      let run = 0, counted = 0;
      for (let i = 0; i < idx && i < kids.length; i++) {
        const n = kids[i];
        if (n.nodeType === 1 && n.tagName === 'BR') { run++; counted = 0; }
        else if (n.nodeType === 1 && RF_BLOCK_TAGS.has(n.tagName)) { /* blok: bukan bagian run */ }
        else counted += (n.textContent || '').length;
      }
      // caret DI DALAM text node → tambahkan startOffset (bug: sebelumnya
      // hanya dihitung char node SEBELUM caret → caret selalu jatuh ke 0)
      if (r.startContainer.nodeType === 3) counted += r.startOffset;
      caretRun = run; caretOff = counted;
    }
  }

  // Bangun daftar item: {block} atau {divNodes}
  const items = [];
  let cur = [];
  const pushCur = () => { if (cur.length) { items.push({ divNodes: cur }); cur = []; } };
  for (const n of Array.from(editor.childNodes)) {
    if (n.nodeType === 1 && RF_BLOCK_TAGS.has(n.tagName)) { pushCur(); items.push({ block: n }); }
    else if (n.nodeType === 1 && n.tagName === 'BR') { pushCur(); }
    else cur.push(n);
  }
  pushCur();

  editor.textContent = '';
  let divIdx = 0, caretDiv = null;
  for (const it of items) {
    if (it.block) { editor.appendChild(it.block); continue; }
    const d = document.createElement('div');
    for (const n of it.divNodes) d.appendChild(n);
    editor.appendChild(d);
    if (divIdx === caretRun) caretDiv = d;
    divIdx++;
  }
  if (caretDiv && caretOff >= 0) rfPlaceCaretAtChar(caretDiv, caretOff);
}

// Konversi live — port rfRederive addon (3 fase: telan spasi just-converted,
// telan '>' redundan dalam task, konversi plain ber-'>' jadi task).
function rfRederive(editor) {
  const just = editor.__rfJustConv || (editor.__rfJustConv = new Set());

  // Fase 1: baris BARU dikonversi — telan SATU spasi pertama ketikan user
  for (const ln of Array.from(just)) {
    just.delete(ln);
    if (!ln.isConnected || !ln.classList.contains('rfn-task')) continue;
    const t = ln.textContent || '';
    if (/^[\s\u00A0]/.test(t)) {
      const caretOff = rfCaretOffsetIn(ln);
      const tn = rfFirstText(ln);
      let ok = false;
      if (tn && tn.deleteData && tn.textContent.length >= 1) { try { tn.deleteData(0, 1); ok = true; } catch (e) {} }
      if (!ok) ln.textContent = t.slice(1);
      if (caretOff >= 0) rfPlaceCaretAtChar(ln, Math.max(0, caretOff - 1));
    }
  }

  // Fase 2: baris task — '>' redundan di dalam task ditelan in-place
  for (const ln of rfSimpleLines(editor)) {
    if (!ln.classList.contains('rfn-task') && !ln.classList.contains('rfn-done')) continue;
    const wasDone = ln.classList.contains('rfn-done');
    const b = ln.textContent || '';
    if (b.indexOf('>') !== 0) continue;
    const isX = b.indexOf('>x') === 0;
    const eat = isX ? (b.length > 2 && (b.charAt(2) === ' ' || b.charAt(2) === '\u00A0') ? 3 : 2)
                    : (b.length > 1 && (b.charAt(1) === ' ' || b.charAt(1) === '\u00A0') ? 2 : 1);
    const isF = rfFocusedLine(editor) === ln;
    const cOff = isF ? rfCaretOffsetIn(ln) : -1;
    const tn = rfFirstText(ln);
    let ate = false;
    if (tn && tn.deleteData && tn.textContent.length >= eat) { try { tn.deleteData(0, eat); ate = true; } catch (e) {} }
    if (!ate) ln.textContent = b.slice(eat);
    just.add(ln);
    if (isX && !wasDone) ln.classList.add('rfn-done');
    if (ln.textContent === '') rfStripEmptyTextNodes(ln);
    rfKeepLineVisible(ln);
    if (isF && cOff >= 0) rfPlaceCaretAtChar(ln, Math.max(0, cOff - eat));
  }

  // Fase 3: baris plain yang mulai diketik '>' → jadi task/radio
  for (const ln of rfSimpleLines(editor)) {
    if (ln.classList.contains('rfn-task') || ln.classList.contains('rfn-done')) continue;
    const before = ln.textContent || '';
    const m = rfParseLine(before);
    if (m.kind === 'plain') continue;
    const isF = rfFocusedLine(editor) === ln;
    const caretOff = isF ? rfCaretOffsetIn(ln) : -1;
    ln.classList.add('rfn-task');
    if (m.kind === 'done') ln.classList.add('rfn-done');
    const markerLen = before.length - m.text.length;
    const tn = rfFirstText(ln);
    let delOk = false;
    if (tn && tn.deleteData && tn.textContent.length >= markerLen) { try { tn.deleteData(0, markerLen); delOk = true; } catch (e) {} }
    if (!delOk) ln.textContent = m.text;
    if (ln.textContent === '') rfStripEmptyTextNodes(ln);
    rfKeepLineVisible(ln);
    if (isF && caretOff >= 0) rfPlaceCaretAtChar(ln, Math.max(0, caretOff - markerLen));
    just.add(ln);
  }
}

// Enter pada baris task — port rfSplitAtCaret addon.
// Return true bila Enter sudah ditangani (caller wajib preventDefault).
function rfSplitAtCaret(editor) {
  const kids = rfSimpleLines(editor);
  let ln = rfFocusedLine(editor);
  if (!ln || !kids.includes(ln)) return false; // caret di blok kaya → default
  const isTaskLn = ln.classList.contains('rfn-task');
  const isDoneLn = ln.classList.contains('rfn-done');
  // HANYA baris task/done yang di-intercept — baris plain pakai Enter default
  // Chrome (bug awal: split manual di semua baris mengubah perilaku bawaan).
  if (!isTaskLn && !isDoneLn) return false;
  const off = rfCaretOffsetIn(ln);
  const cur = ln.textContent || '';
  const hasCaret = off >= 0;

  // Enter di bullet KOSONG = keluar mode task (ala Word, tanpa buat baris baru)
  if (isTaskLn && !isDoneLn && cur.length === 0) {
    ln.classList.remove('rfn-task');
    if (editor.__rfJustConv) editor.__rfJustConv.delete(ln);
    rfStripEmptyTextNodes(ln);
    rfKeepLineVisible(ln);
    rfPlaceCaretAtChar(ln, 0);
    return true;
  }

  const before = hasCaret ? cur.slice(0, off) : cur;
  const after = hasCaret ? cur.slice(off) : '';
  // Jangan sentuh DOM bila tidak ada potongan yang berubah — textContent=''
  // membunuh text node rumah caret & melempar seleksi (normalisasi Chrome).
  if (before !== cur) { ln.textContent = before; }
  rfStripEmptyTextNodes(ln);
  rfKeepLineVisible(ln);
  // Lanjutan baris task aktif = baris task baru ber-radio; done/plain = baris polos
  const contTask = !!(isTaskLn && !isDoneLn);
  const nl = document.createElement('div');
  if (contTask) nl.classList.add('rfn-task');
  if (after !== '') nl.textContent = after;
  rfKeepLineVisible(nl);
  // v1.16.0: baris kosong HARUS childless — text node ber-length 0 membuat
  // caret (el,1) dinormalisasi Chrome ke ujung baris SEBELUMNYA sehingga
  // ketikan berikutnya mendarat di baris salah. Bentuk caret native Chrome
  // setelah Enter = (div kosong, 0) tanpa anak — bentuk itulah yang kita
  // pakai lewat fallback rfPlaceCaretAtChar.
  editor.insertBefore(nl, ln.nextSibling || null);
  rfPlaceCaretAtChar(nl, 0);
  return true;
}

function rfStripEmptyTextNodes(el) {
  // buang text node ber-length 0 di level atas baris — sisa deleteData/
  // textContent='' yang mengacaukan kanonikalisasi caret Chrome.
  try {
    for (const c of Array.from(el.childNodes || [])) {
      if (c.nodeType === 3 && c.textContent.length === 0) el.removeChild(c);
    }
  } catch (e) {}
}

function rfKeepLineVisible(el) {
  // baris kosong hasil manipulasi engine diberi <br> placeholder — bentuk
  // native Chrome (<div><br></div>) yang membuat caret TETAP di baris itu;
  // div kosong tanpa apa-apa dikanonikalisasi Chrome ke ujung baris sebelumnya.
  try {
    if ((el.textContent || '') === '' && !el.querySelector('br') && !el.querySelector('img')) {
      el.innerHTML = '<br>';
    }
  } catch (e) {}
}

// Klik radio (gutter kiri) — port rfToggleDone addon: toggle selesai +
// reorder (selesai → dasar deret; aktif → sebelum blok done pertama).
function rfToggleDone(editor, ln) {
  const wasDone = ln.classList.contains('rfn-done');
  const wasFocused = rfFocusedLine(editor) === ln;
  const saveOff = rfCaretOffsetIn(ln);
  ln.classList.toggle('rfn-done', !wasDone);
  ln.classList.add('rfn-task');
  editor.removeChild(ln);
  if (!wasDone) {
    editor.appendChild(ln);
  } else {
    let ref = null;
    for (const c of editor.children) {
      if (c !== ln && c.classList && c.classList.contains('rfn-done')) { ref = c; break; }
    }
    if (ref) editor.insertBefore(ln, ref); else editor.appendChild(ln);
  }
  if (wasFocused) rfPlaceCaretAtChar(ln, saveOff >= 0 ? saveOff : (ln.textContent || '').length);
}

// Pasang engine ke editor contenteditable note.
function rfInitNoteEditor(editor) {
  if (!editor) return;
  try { rfNormalizeRootFlow(editor); } catch (e) {}
  try { rfRederive(editor); } catch (e) {}   // rederive saat load — catatan addon ikut ber-radio

  editor.addEventListener('compositionstart', () => { editor.__rfComposing = true; });
  editor.addEventListener('compositionend', () => {
    editor.__rfComposing = false;
    try { rfOnInput(editor); } catch (e) {}
  });

  editor.addEventListener('input', () => {
    try { if (!editor.__rfComposing) rfOnInput(editor); } catch (e) {}
  });

  editor.addEventListener('keydown', (e) => {
    try {
      if (editor.__rfComposing || e.isComposing) return;
      if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (rfSplitAtCaret(editor)) e.preventDefault();
        return;
      }
      if (e.key === 'Backspace') {
        const sel = window.getSelection();
        if (!sel || !sel.rangeCount || !sel.getRangeAt(0).collapsed) return;
        const ln = rfFocusedLine(editor);
        if (!ln || !ln.classList) return;
        if (!ln.classList.contains('rfn-task') && !ln.classList.contains('rfn-done')) return;
        if (rfCaretOffsetIn(ln) !== 0) return;
        e.preventDefault();
        if (ln.classList.contains('rfn-done')) {
          ln.classList.remove('rfn-done');           // done → un-done dulu
        } else {
          ln.classList.remove('rfn-task');           // task → lepas mode (dedent)
          if (editor.__rfJustConv) editor.__rfJustConv.delete(ln);
        }
        rfPlaceCaretAtChar(ln, 0);
      }
    } catch (e2) {}
  });

  editor.addEventListener('click', (e) => {
    try {
      let ln = e.target;
      while (ln && ln.parentNode !== editor) ln = ln.parentNode;
      if (!ln || ln.nodeType !== 1 || !ln.classList || !ln.classList.contains('rfn-task')) return;
      const rect = ln.getBoundingClientRect();
      const left = (typeof e.clientX === 'number' && rect) ? e.clientX - rect.left : -1;
      if (left >= 0 && left <= RF_GUTTER) {
        e.preventDefault();
        e.stopPropagation();
        rfToggleDone(editor, ln);
      }
    } catch (e2) {}
  });
}

function rfOnInput(editor) {
  try { rfNormalizeRootFlow(editor); } catch (e) {}
  try { rfRederive(editor); } catch (e) {}
}

// Serialisasi body saat SIMPAN: baris task/done → teks '> '/' >x ' (interop
// addon, tanpa class — sanitize memang membuang class); konten lain → HTML
// apa adanya (identik perilaku lama bodyEl.innerHTML).
function rfSerializeEditorBody(editor) {
  let html = '';
  for (const n of Array.from(editor.childNodes || [])) {
    if (n.nodeType === 1 && rfIsSimpleLine(n) &&
        (n.classList.contains('rfn-task') || n.classList.contains('rfn-done'))) {
      const kind = n.classList.contains('rfn-done') ? 'done' : 'task';
      // Dibungkus <div> — tanpa wrapper, teks escaped jadi node telanjang
      // di root dan menyatu dengan teks tetangga saat di-load kembali.
      const tmp = document.createElement('div');
      tmp.textContent = rfSerializeLine(kind, n.textContent || '');
      html += tmp.outerHTML;
    } else if (n.nodeType === 3) {
      const tmp = document.createElement('div');
      tmp.textContent = n.textContent;
      html += tmp.innerHTML;
    } else {
      html += n.outerHTML;
    }
  }
  return html;
}

export function renderNotes(user, onRefresh) {
  _onRefresh = onRefresh;
  const main = document.getElementById('appMain');
  if (!main) return;
  main.innerHTML = `
    <div class="view-header">
      <h2>📝 Catatan</h2>
      <div class="header-actions">
        <button class="icon-btn" id="batchToggle" title="Mode batch">☑️</button>
        <button class="icon-btn" id="refreshBtn" title="Refresh">↻</button>
      </div>
    </div>
    <div class="notes-toolbar">
      <div class="notes-search-wrap" id="notesSearchWrap">
        <input type="search" enterkeyhint="search" autocomplete="off" spellcheck="false" class="notes-search" id="noteSearch" placeholder="🔍 Cari catatan... (Enter)">
        <button class="notes-search-clear" id="noteSearchClear" title="Hapus pencarian" aria-label="Hapus pencarian" style="display:none">✕</button>
      </div>
      <select class="notes-sort" id="noteSort" title="Urutkan">
        <option value="recent" ${_notesSortMode === 'recent' ? 'selected' : ''}>Terbaru</option>
        <option value="created" ${_notesSortMode === 'created' ? 'selected' : ''}>Dibuat</option>
        <option value="title" ${_notesSortMode === 'title' ? 'selected' : ''}>Judul A-Z</option>
      </select>
      <button class="notes-view-toggle" id="noteViewToggle" title="${_notesViewMode === 'list' ? 'Mode grid' : 'Mode list'}">${_notesViewMode === 'list' ? '▦' : '☰'}</button>
    </div>
    <div class="batch-bar" id="batchBar" style="display:none">
      <span id="batchCount">0 dipilih</span>
      <div class="batch-actions">
        <button class="btn btn-secondary" id="batchCopy">📋 Copy Teks</button>
        <button class="btn btn-danger" id="batchDelete">🗑️ Hapus</button>
        <button class="btn btn-ghost" id="batchCancel">✕</button>
      </div>
    </div>
    <div class="notes-list" id="notesList"><div class="loading">Memuat...</div></div>
  `;
  document.getElementById('refreshBtn').addEventListener('click', () => onRefresh());
  document.getElementById('batchToggle').addEventListener('click', toggleBatchMode);
  document.getElementById('batchCancel').addEventListener('click', () => exitBatchMode());
  document.getElementById('batchCopy').addEventListener('click', doBatchCopy);
  document.getElementById('batchDelete').addEventListener('click', doBatchDelete);

  // v1.5.0: Search trigger saat Enter (bukan real-time). Escape = clear.
  const searchInput = document.getElementById('noteSearch');
  const searchClearBtn = document.getElementById('noteSearchClear');
  function updateSearchClearVisibility() {
    if (searchClearBtn) {
      searchClearBtn.style.display = (_notesSearchQuery.length > 0) ? 'flex' : 'none';
    }
  }
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      _notesSearchQuery = searchInput.value.trim();
      updateSearchClearVisibility();
      refreshList();
      const newInput = document.getElementById('noteSearch');
      if (newInput) {
        newInput.focus();
        const len = newInput.value.length;
        newInput.setSelectionRange(len, len);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (_notesSearchQuery || searchInput.value) {
        _notesSearchQuery = '';
        searchInput.value = '';
        updateSearchClearVisibility();
        refreshList();
        const newInput = document.getElementById('noteSearch');
        if (newInput) newInput.focus();
      }
    }
  });
  // v1.5.0: Tombol X clear search
  if (searchClearBtn) {
    searchClearBtn.addEventListener('click', () => {
      _notesSearchQuery = '';
      searchInput.value = '';
      updateSearchClearVisibility();
      refreshList();
      searchInput.focus();
    });
  }

  // v1.5.0: Sort dropdown
  document.getElementById('noteSort').addEventListener('change', (e) => {
    _notesSortMode = e.target.value;
    localStorage.setItem('rf_notes_sort', _notesSortMode);
    refreshList();
  });

  // v1.5.0: View toggle list ↔ grid
  document.getElementById('noteViewToggle').addEventListener('click', () => {
    _notesViewMode = _notesViewMode === 'list' ? 'grid' : 'list';
    localStorage.setItem('rf_notes_view', _notesViewMode);
    document.getElementById('noteViewToggle').textContent = _notesViewMode === 'list' ? '▦' : '☰';
    document.getElementById('noteViewToggle').title = _notesViewMode === 'list' ? 'Mode grid' : 'Mode list';
    refreshList();
  });

  refreshList();
}

async function refreshList() {
  const list = document.getElementById('notesList');
  if (!list) return;
  const q = _notesSearchQuery.toLowerCase();
  let notes = await dbGetAllNotes();
  notes = notes.filter(n => !n.archived);
  // v1.5.0: Search di judul + body (body di-strip HTML dulu)
  if (q) {
    notes = notes.filter(n => {
      const title = (n.title || '').toLowerCase();
      const body = stripHtmlForPreview(n.body || '').toLowerCase();
      return title.includes(q) || body.includes(q);
    });
  }
  // v1.5.0: Apply sort mode (pinned selalu di atas)
  const pinnedFirst = (a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0);
  if (_notesSortMode === 'title') {
    notes.sort((a, b) => {
      const p = pinnedFirst(a, b);
      if (p !== 0) return p;
      return (a.title || '').localeCompare(b.title || '', 'id', { sensitivity: 'base' });
    });
  } else if (_notesSortMode === 'created') {
    notes.sort((a, b) => {
      const p = pinnedFirst(a, b);
      if (p !== 0) return p;
      return new Date(b.created_at || 0) - new Date(a.created_at || 0);
    });
  } else {
    // 'recent' — by updated_at desc
    notes.sort((a, b) => {
      const p = pinnedFirst(a, b);
      if (p !== 0) return p;
      return new Date(b.updated_at || 0) - new Date(a.updated_at || 0);
    });
  }

  // v1.5.0: Tambah class 'notes-grid-mode' kalau viewMode = 'grid'
  list.className = 'notes-list' + (_notesViewMode === 'grid' ? ' notes-grid-mode' : '');

  if (notes.length === 0) {
    if (q) {
      list.innerHTML = `<div class="empty">🔍 Tidak ada catatan cocok dengan "<strong>${escapeHtml(_notesSearchQuery)}</strong>".<br><br>Coba kata kunci lain atau hapus filter pencarian.</div>`;
    } else {
      list.innerHTML = '<div class="empty">📝 Belum ada catatan.<br><br>Ketuk tombol <strong>+</strong> di bawah untuk buat catatan baru.</div>';
    }
    return;
  }
  list.innerHTML = notes.map(note => {
    const color = NOTE_COLORS.find(c => c.id === (note.color || 'default')) || NOTE_COLORS[0];
    const selected = _batchSelected.has(note.id);
    // v1.5.0: Strip HTML untuk preview
    const body = stripHtmlForPreview(note.body || '').slice(0, 120);
    return `
      <div class="note-card ${selected ? 'selected' : ''}" data-id="${note.id}" style="background:${color.bg};color:${color.fg};border-color:${color.border}">
        ${_batchMode ? `<div class="check">${selected ? '✓' : ''}</div>` : ''}
        ${note.pinned ? '<div class="pin">📌</div>' : ''}
        <div class="note-title">${escapeHtml(note.title || 'Tanpa judul')}</div>
        <div class="note-body">${escapeHtml(body)}${note.body && stripHtmlForPreview(note.body).length > 120 ? '…' : ''}</div>
        <div class="note-meta">
          ${note.group ? `<span class="badge">${escapeHtml(note.group)}</span>` : ''}
          <span>${new Date(note.updated_at).toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' })}</span>
        </div>
      </div>
    `;
  }).join('');
  list.querySelectorAll('.note-card').forEach(card => {
    card.addEventListener('click', () => {
      const id = card.dataset.id;
      if (_batchMode) {
        if (_batchSelected.has(id)) _batchSelected.delete(id);
        else _batchSelected.add(id);
        updateBatchUI();
        refreshList();
      } else {
        openNoteEditor(id, _onRefresh);
      }
    });
  });
}

function toggleBatchMode() {
  _batchMode = !_batchMode;
  _batchSelected.clear();
  document.getElementById('batchBar').style.display = _batchMode ? 'flex' : 'none';
  document.getElementById('batchToggle').classList.toggle('active', _batchMode);
  refreshList();
}

function exitBatchMode() {
  _batchMode = false;
  _batchSelected.clear();
  document.getElementById('batchBar').style.display = 'none';
  document.getElementById('batchToggle').classList.toggle('active', false);
  refreshList();
}

function updateBatchUI() {
  const countEl = document.getElementById('batchCount');
  if (countEl) countEl.textContent = _batchSelected.size + ' dipilih';
}

// ===== Note editor (dipanggil dari list click atau FAB menu) =====
export async function openNoteEditor(noteId, onDone) {
  let note = null;
  if (noteId) {
    const all = await dbGetAllNotes();
    note = all.find(n => n.id === noteId);
  }
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  // v1.5.0: Ganti <textarea> → <div contenteditable> supaya bisa paste tabel + format dasar.
  // Body disimpan sebagai HTML (sama seperti addon v3.13.0+). Backward-compat: catatan lama
  // plain text di-load via loadNoteBody() yang escape + newline → <br>.
  modal.innerHTML = `
    <div class="modal-card modal-editor">
      <div class="modal-header">
        <input type="text" id="noteTitle" placeholder="Judul (opsional)" value="${escapeHtml(note?.title || '')}">
        <button class="icon-btn" data-action="close">✕</button>
      </div>
      <div class="modal-body">
        <div class="nbody-edit" id="noteBody" contenteditable="true" data-placeholder="Tulis catatan... Paste tabel atau teks berformat akan dipertahankan.">${loadNoteBody(note?.body || '')}</div>
        <div class="note-options">
          <label>🎨 Warna</label>
          <div class="color-row">
            ${NOTE_COLORS.map(c => `<button class="color-chip ${c.id === (note?.color || 'default') ? 'active' : ''}" data-color="${c.id}" style="background:${c.bg};border:2px solid ${c.border}"></button>`).join('')}
          </div>
          <label>📁 Grup / Proyek</label>
          <input type="text" id="noteGroup" placeholder="(opsional, mis. Rapat, Ide)" value="${escapeHtml(note?.group || '')}">
          <div class="toggle-row">
            <label><input type="checkbox" id="notePinned" ${note?.pinned ? 'checked' : ''}> 📌 Pin di atas</label>
            <label><input type="checkbox" id="noteArchived" ${note?.archived ? 'checked' : ''}> 🗄️ Arsip</label>
          </div>
        </div>
      </div>
      <div class="modal-footer">
        ${note ? '<button class="btn btn-danger" data-action="delete">🗑️ Hapus</button>' : ''}
        <button class="btn btn-primary" data-action="save">💾 Simpan</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  setTimeout(() => modal.classList.add('open'), 10);

  // v1.11.3: Auto-focus + auto-select judul catatan saat modal dibuka —
  //   user bisa langsung ketik untuk menimpa judul lama (kalau edit existing note).
  //   User: "nama file ketika di pencet itu dalam kondisi terblok, sehingga bisa
  //   langsung di rename/ ditimpa untuk diberi nama baru.
  //   tolong standarkan dengan fungsi lainnya selain screnshot harus kondisi sudah
  //   terblok sehingga memudahkan dalam melakukan rename."
  const noteTitleEl = modal.querySelector('#noteTitle');
  if (noteTitleEl) {
    noteTitleEl.addEventListener('focus', () => {
      setTimeout(() => noteTitleEl.select(), 0);
    });
    setTimeout(() => {
      try { noteTitleEl.focus(); noteTitleEl.select(); } catch (e) { /* ignore */ }
    }, 120);
  }

  let selectedColor = note?.color || 'default';
  modal.querySelectorAll('.color-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      selectedColor = chip.dataset.color;
      modal.querySelectorAll('.color-chip').forEach(c => c.classList.toggle('active', c.dataset.color === selectedColor));
    });
  });

  // v1.5.0: Paste handler untuk contenteditable — sanitize HTML dari clipboard.
  const bodyEl = document.getElementById('noteBody');
  // v1.16.0: Task bullet engine (port RecallNote addon) — '>' → radio, Enter
  // lanjut bullet, klik gutter = toggle selesai, backspace depan = keluar mode.
  rfInitNoteEditor(bodyEl);
  bodyEl.addEventListener('paste', (e) => {
    e.preventDefault();
    const html = e.clipboardData.getData('text/html');
    const text = e.clipboardData.getData('text/plain');
    let insertHtml;
    if (html && html.trim()) {
      insertHtml = sanitizeNoteHtml(html);
    } else if (text) {
      insertHtml = escapeHtml(text).replace(/\n/g, '<br>');
    } else {
      return;
    }
    try {
      document.execCommand('insertHTML', false, insertHtml);
    } catch (err) {
      bodyEl.innerHTML += insertHtml;
    }
    bodyEl.dispatchEvent(new Event('input'));
  });

  const close = () => {
    modal.classList.remove('open');
    setTimeout(() => { if (modal.parentNode) document.body.removeChild(modal); }, 200);
  };

  modal.addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (btn) {
      const action = btn.dataset.action;
      if (action === 'close') { close(); return; }
      if (action === 'save') {
        const title = document.getElementById('noteTitle').value.trim();
        // v1.16.0: Serialisasi task bullet — baris radio ditulis '> teks' / '>x teks'
        // (interop addon); konten lain tetap HTML seperti perilaku lama.
        const body = rfSerializeEditorBody(bodyEl);
        const group = document.getElementById('noteGroup').value.trim();
        const pinned = document.getElementById('notePinned').checked;
        const archived = document.getElementById('noteArchived').checked;
        showToast('Menyimpan...');
        try {
          if (note) {
            await updateNote(window.__rfUser, note.id, { title, body, group, pinned, archived, color: selectedColor });
          } else {
            await createNote(window.__rfUser, { title, body, group, pinned, archived, color: selectedColor });
          }
          showToast('✓ Tersimpan & tersinkron');
          close();
          if (window.__rfNavigate) window.__rfNavigate('notes');
          if (onDone) onDone();
        } catch (e) {
          console.error('[RecallFox] save note failed:', e);
          showToast('Gagal: ' + e.message, true);
        }
        return;
      }
      if (action === 'delete') {
        if (!confirm('Hapus catatan ini?')) return;
        await deleteNote(window.__rfUser, note.id);
        showToast('✓ Dihapus');
        close();
        if (onDone) onDone();
        return;
      }
    }
    if (e.target === modal) close();
  });
}

async function doBatchCopy() {
  if (_batchSelected.size === 0) { showToast('Pilih minimal 1 catatan', true); return; }
  const all = await dbGetAllNotes();
  const notes = all.filter(n => _batchSelected.has(n.id));
  if (notes.length === 0) return;
  // v1.5.0: Strip HTML dari body untuk copy plain text
  const parts = notes.map((n, i) => {
    const bodyText = stripHtmlForPreview(n.body || '');
    let s = `${i + 1}. ${n.title || 'Tanpa judul'}\n${bodyText}`;
    if (n.group) s += `\n[Grup: ${n.group}]`;
    return s;
  });
  const text = parts.join('\n\n---\n\n');
  try {
    await navigator.clipboard.writeText(text);
    showToast(`✓ ${notes.length} catatan tersalin`);
  } catch (e) {
    showToast('Gagal: ' + e.message, true);
  }
}

async function doBatchDelete() {
  if (_batchSelected.size === 0) { showToast('Pilih minimal 1 catatan', true); return; }
  if (!confirm(`Hapus ${_batchSelected.size} catatan?`)) return;
  for (const id of _batchSelected) {
    await deleteNote(window.__rfUser, id);
  }
  showToast('✓ Dihapus');
  exitBatchMode();
  if (_onRefresh) _onRefresh();
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function showToast(msg, isError = false) {
  const t = document.createElement('div');
  t.className = 'toast' + (isError ? ' toast-error' : '');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.classList.add('show'), 10);
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => { if (t.parentNode) document.body.removeChild(t); }, 300); }, 2500);
}
