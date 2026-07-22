// src/views/media.js — Media tab: list + capture + annotate + batch operations

import { pickImage, pasteFromClipboard } from '../capture.js';
import { openAnnotateEditor } from '../annotate.js';
import { createScreenshotItem, deleteVaultItem, getOrDownloadScreenshotBlob } from '../sync.js';
import { buildScreenshotCaption, buildBatchCaption, writeScreenshotToClipboard } from '../copy-format.js';
import { dbGetAllVaultItems } from '../db.js';

let _batchMode = false;
let _batchSelected = new Set();
let _onRefresh = null;

export function renderMedia(user, onRefresh) {
  _onRefresh = onRefresh;
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="view-header">
      <h2>📸 Media</h2>
      <div class="header-actions">
        <button class="icon-btn" id="batchToggle">☑️</button>
        <button class="icon-btn" id="refreshBtn">↻</button>
      </div>
    </div>
    <div class="batch-bar" id="batchBar" style="display:none">
      <span id="batchCount">0 dipilih</span>
      <button class="btn btn-secondary" id="batchCopyCaption">📋 Copy + Keterangan</button>
      <button class="btn btn-secondary" id="batchCopyImg">🖼️ Copy Gambar</button>
      <button class="btn btn-danger" id="batchDelete">🗑️ Hapus</button>
      <button class="btn btn-ghost" id="batchCancel">✕</button>
    </div>
    <div class="media-grid" id="mediaGrid"><div class="loading">Memuat...</div></div>
    <button class="fab" id="fabAdd">+</button>
  `;

  document.getElementById('fabAdd').addEventListener('click', openCaptureSheet);
  document.getElementById('refreshBtn').addEventListener('click', () => onRefresh());
  document.getElementById('batchToggle').addEventListener('click', toggleBatchMode);
  document.getElementById('batchCancel').addEventListener('click', () => exitBatchMode());
  document.getElementById('batchCopyCaption').addEventListener('click', () => doBatchCopy(true));
  document.getElementById('batchCopyImg').addEventListener('click', () => doBatchCopy(false));
  document.getElementById('batchDelete').addEventListener('click', doBatchDelete);

  refreshList();
}

async function refreshList() {
  const grid = document.getElementById('mediaGrid');
  if (!grid) return;
  const items = (await dbGetAllVaultItems()).filter(i => i.type === 'screenshot' && !i.archived);
  items.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
  if (items.length === 0) {
    grid.innerHTML = '<div class="empty">Belum ada screenshot.<br>Klik + untuk capture.</div>';
    return;
  }
  grid.innerHTML = items.map(item => {
    const selected = _batchSelected.has(item.id);
    const thumb = item.thumbnail_data_url || '';
    return `
      <div class="media-card ${selected ? 'selected' : ''}" data-id="${item.id}">
        ${_batchMode ? `<div class="check">${selected ? '✓' : ''}</div>` : ''}
        <div class="thumb">${thumb ? `<img src="${thumb}" alt="">` : '🖼️'}</div>
        <div class="meta">
          <div class="title">${escapeHtml(item.title || 'Untitled')}</div>
          <div class="date">${new Date(item.created_at).toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' })}</div>
        </div>
      </div>
    `;
  }).join('');
  // Bind clicks
  grid.querySelectorAll('.media-card').forEach(card => {
    card.addEventListener('click', () => {
      const id = card.dataset.id;
      if (_batchMode) {
        if (_batchSelected.has(id)) _batchSelected.delete(id);
        else _batchSelected.add(id);
        updateBatchUI();
        refreshList();
      } else {
        openItemDetail(id);
      }
    });
  });
}

function toggleBatchMode() {
  _batchMode = !_batchMode;
  _batchSelected.clear();
  document.getElementById('batchBar').style.display = _batchMode ? 'flex' : 'none';
  refreshList();
}

function exitBatchMode() {
  _batchMode = false;
  _batchSelected.clear();
  document.getElementById('batchBar').style.display = 'none';
  refreshList();
}

function updateBatchUI() {
  const countEl = document.getElementById('batchCount');
  if (countEl) countEl.textContent = _batchSelected.size + ' dipilih';
}

async function openCaptureSheet() {
  const sheet = document.createElement('div');
  sheet.className = 'bottom-sheet';
  sheet.innerHTML = `
    <div class="sheet-backdrop"></div>
    <div class="sheet-content">
      <div class="sheet-handle"></div>
      <h3>Tambah Media</h3>
      <button class="sheet-btn" data-src="camera">📷 Kamera</button>
      <button class="sheet-btn" data-src="gallery">🖼️ Galeri</button>
      <button class="sheet-btn" data-src="paste">📋 Paste dari clipboard</button>
      <button class="sheet-btn sheet-cancel" data-action="cancel">Batal</button>
    </div>
  `;
  document.body.appendChild(sheet);
  setTimeout(() => sheet.classList.add('open'), 10);

  const close = () => {
    sheet.classList.remove('open');
    setTimeout(() => document.body.removeChild(sheet), 200);
  };

  sheet.addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) {
      if (e.target.classList.contains('sheet-backdrop')) close();
      return;
    }
    const src = btn.dataset.src;
    const action = btn.dataset.action;
    if (action === 'cancel') { close(); return; }
    if (!src) return;
    close();
    let picked = null;
    if (src === 'camera' || src === 'gallery') {
      picked = await pickImage(src);
    } else if (src === 'paste') {
      picked = await pasteFromClipboard();
      if (!picked) { showToast('Clipboard tidak ada gambar', true); return; }
    }
    if (!picked) return;
    // Buka annotate editor
    const annoRes = await openAnnotateEditor(picked.dataUrl, {});
    if (annoRes.cancelled) return;
    const finalDataUrl = annoRes.dataUrl;
    // Save
    showToast('Menyimpan...');
    const res = await createScreenshotItem(window.__rfUser, {
      dataUrl: finalDataUrl,
      width: picked.width,
      height: picked.height,
      mode: 'selection',
      title: `HP Capture ${new Date().toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' })}`,
      annotationNote: annoRes.annotationNote
    });
    if (res.ok) {
      showToast('✓ Tersimpan & tersinkron');
      refreshList();
      if (_onRefresh) _onRefresh();
    } else {
      showToast('Gagal: ' + (res.error || 'unknown'), true);
    }
  });
}

async function openItemDetail(id) {
  const items = await dbGetAllVaultItems();
  const item = items.find(i => i.id === id);
  if (!item) return;
  const blobRes = await getOrDownloadScreenshotBlob(item);
  const dataUrl = blobRes.dataUrl;
  const cap = buildScreenshotCaption(item, dataUrl);
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-card">
      <div class="modal-header">
        <h3>${escapeHtml(item.title || 'Screenshot')}</h3>
        <button class="icon-btn" data-action="close">✕</button>
      </div>
      <div class="modal-body">
        ${dataUrl ? `<img src="${dataUrl}" style="max-width:100%;border-radius:8px">` : '<div class="empty">Gambar tidak tersedia</div>'}
        <div class="caption-preview">${cap.textPlain.replace(/\n/g, '<br>')}</div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" data-action="copy-img">🖼️ Copy Gambar</button>
        <button class="btn btn-primary" data-action="copy-cap">📋 Copy + Keterangan</button>
        <button class="btn btn-danger" data-action="delete">🗑️ Hapus</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  setTimeout(() => modal.classList.add('open'), 10);

  const close = () => {
    modal.classList.remove('open');
    setTimeout(() => document.body.removeChild(modal), 200);
  };

  modal.addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) {
      if (e.target === modal) close();
      return;
    }
    const action = btn.dataset.action;
    if (action === 'close') { close(); return; }
    if (action === 'copy-img') {
      const r = await writeScreenshotToClipboard(dataUrl, '', '');
      showToast(r.ok ? r.message : 'Gagal: ' + r.error, !r.ok);
    } else if (action === 'copy-cap') {
      const r = await writeScreenshotToClipboard(dataUrl, cap.textPlain, cap.textHtml);
      showToast(r.ok ? r.message : 'Gagal: ' + r.error, !r.ok);
    } else if (action === 'delete') {
      if (!confirm('Hapus screenshot ini?')) return;
      await deleteVaultItem(window.__rfUser, id);
      showToast('✓ Dihapus');
      close();
      refreshList();
      if (_onRefresh) _onRefresh();
    }
  });
}

async function doBatchCopy(withCaption) {
  if (_batchSelected.size === 0) { showToast('Pilih minimal 1 item', true); return; }
  showToast('Menyalin...');
  const items = await dbGetAllVaultItems();
  const screenshots = [];
  for (const id of _batchSelected) {
    const item = items.find(i => i.id === id);
    if (!item || item.type !== 'screenshot') continue;
    const blobRes = await getOrDownloadScreenshotBlob(item);
    screenshots.push({ item, dataUrl: blobRes.dataUrl });
  }
  if (screenshots.length === 0) { showToast('Tidak ada screenshot valid', true); return; }
  if (withCaption) {
    const cap = buildBatchCaption(screenshots);
    const r = await writeScreenshotToClipboard(screenshots[0]?.dataUrl, cap.textPlain, cap.textHtml);
    showToast(r.ok ? r.message : 'Gagal: ' + r.error, !r.ok);
  } else {
    const r = await writeScreenshotToClipboard(screenshots[0]?.dataUrl, '', '');
    showToast(r.ok ? r.message : 'Gagal: ' + r.error, !r.ok);
  }
}

async function doBatchDelete() {
  if (_batchSelected.size === 0) { showToast('Pilih minimal 1 item', true); return; }
  if (!confirm(`Hapus ${_batchSelected.size} screenshot? Tidak bisa di-undo.`)) return;
  showToast('Menghapus...');
  for (const id of _batchSelected) {
    await deleteVaultItem(window.__rfUser, id);
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
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => document.body.removeChild(t), 300); }, 2500);
}
