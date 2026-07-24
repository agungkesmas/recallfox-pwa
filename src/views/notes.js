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
        <input type="text" class="notes-search" id="noteSearch" placeholder="🔍 Cari catatan... (Enter)">
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

  let selectedColor = note?.color || 'default';
  modal.querySelectorAll('.color-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      selectedColor = chip.dataset.color;
      modal.querySelectorAll('.color-chip').forEach(c => c.classList.toggle('active', c.dataset.color === selectedColor));
    });
  });

  // v1.5.0: Paste handler untuk contenteditable — sanitize HTML dari clipboard.
  const bodyEl = document.getElementById('noteBody');
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
        // v1.5.0: Body sekarang HTML dari contenteditable (bukan .value)
        const body = bodyEl.innerHTML;
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
