// src/views/notes.js — Notes tab: list + editor + batch operations
// v1.1.0: Render to #appMain (bukan #app) supaya bottom nav + FAB persist.
// v1.1.0: openNoteEditor dipanggil dari FAB menu (tombol + → Catatan Baru).
// v1.1.0: Tambah "Copy Teks Saja" di batch mode.

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
    <div class="search-row">
      <input type="search" id="noteSearch" placeholder="🔍 Cari catatan...">
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
  document.getElementById('noteSearch').addEventListener('input', refreshList);
  refreshList();
}

async function refreshList() {
  const list = document.getElementById('notesList');
  if (!list) return;
  const q = (document.getElementById('noteSearch')?.value || '').toLowerCase();
  let notes = await dbGetAllNotes();
  notes = notes.filter(n => !n.archived);
  if (q) {
    notes = notes.filter(n => (n.title || '').toLowerCase().includes(q) || (n.body || '').toLowerCase().includes(q));
  }
  notes.sort((a, b) => {
    if (a.pinned && !b.pinned) return -1;
    if (!a.pinned && b.pinned) return 1;
    return new Date(b.updated_at) - new Date(a.updated_at);
  });
  if (notes.length === 0) {
    list.innerHTML = '<div class="empty">📝 Belum ada catatan.<br><br>Ketuk tombol <strong>+</strong> di bawah untuk buat catatan baru.</div>';
    return;
  }
  list.innerHTML = notes.map(note => {
    const color = NOTE_COLORS.find(c => c.id === (note.color || 'default')) || NOTE_COLORS[0];
    const selected = _batchSelected.has(note.id);
    const body = (note.body || '').slice(0, 120);
    return `
      <div class="note-card ${selected ? 'selected' : ''}" data-id="${note.id}" style="background:${color.bg};color:${color.fg};border-color:${color.border}">
        ${_batchMode ? `<div class="check">${selected ? '✓' : ''}</div>` : ''}
        ${note.pinned ? '<div class="pin">📌</div>' : ''}
        <div class="note-title">${escapeHtml(note.title || 'Tanpa judul')}</div>
        <div class="note-body">${escapeHtml(body)}${note.body?.length > 120 ? '…' : ''}</div>
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
  modal.innerHTML = `
    <div class="modal-card modal-editor">
      <div class="modal-header">
        <input type="text" id="noteTitle" placeholder="Judul (opsional)" value="${escapeHtml(note?.title || '')}">
        <button class="icon-btn" data-action="close">✕</button>
      </div>
      <div class="modal-body">
        <textarea id="noteBody" placeholder="Tulis catatan...">${escapeHtml(note?.body || '')}</textarea>
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
        const body = document.getElementById('noteBody').value;
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
  const parts = notes.map((n, i) => {
    let s = `${i + 1}. ${n.title || 'Tanpa judul'}\n${n.body || ''}`;
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
