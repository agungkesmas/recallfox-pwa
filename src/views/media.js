// src/views/media.js — Media tab: list + batch + detail
// v1.1.0: Render to #appMain (bukan #app) supaya bottom nav + FAB persist.
// v1.1.0: Capture flow dipindah ke startCaptureFlow() yang dipanggil dari FAB menu.
// v1.1.0: Tambah "Copy Teks Saja" di batch mode.

import { deleteVaultItem, getOrDownloadScreenshotBlob, createScreenshotItem } from '../sync.js';
import { buildScreenshotCaption, buildBatchCaption, writeScreenshotToClipboard } from '../copy-format.js';
import { dbGetAllVaultItems } from '../db.js';
import { pickImage, pasteFromClipboard } from '../capture.js';
import { openAnnotateEditor } from '../annotate.js';

let _batchMode = false;
let _batchSelected = new Set();
let _onRefresh = null;

export function renderMedia(user, onRefresh) {
  _onRefresh = onRefresh;
  const main = document.getElementById('appMain');
  if (!main) return;
  main.innerHTML = `
    <div class="view-header">
      <h2>📸 Media</h2>
      <div class="header-actions">
        <button class="icon-btn" id="batchToggle" title="Mode batch">☑️</button>
        <button class="icon-btn" id="refreshBtn" title="Refresh">↻</button>
      </div>
    </div>
    <div class="batch-bar" id="batchBar" style="display:none">
      <span id="batchCount">0 dipilih</span>
      <div class="batch-actions">
        <button class="btn btn-secondary" id="batchCopyCaption">📋 + Keterangan</button>
        <button class="btn btn-secondary" id="batchCopyImg">🖼️ Gambar</button>
        <button class="btn btn-secondary" id="batchCopyText">📝 Teks Saja</button>
        <button class="btn btn-danger" id="batchDelete">🗑️ Hapus</button>
        <button class="btn btn-ghost" id="batchCancel">✕</button>
      </div>
    </div>
    <div class="media-grid" id="mediaGrid"><div class="loading">Memuat...</div></div>
  `;

  document.getElementById('refreshBtn').addEventListener('click', () => onRefresh());
  document.getElementById('batchToggle').addEventListener('click', toggleBatchMode);
  document.getElementById('batchCancel').addEventListener('click', () => exitBatchMode());
  document.getElementById('batchCopyCaption').addEventListener('click', () => doBatchCopy('caption'));
  document.getElementById('batchCopyImg').addEventListener('click', () => doBatchCopy('image'));
  document.getElementById('batchCopyText').addEventListener('click', () => doBatchCopy('text'));
  document.getElementById('batchDelete').addEventListener('click', doBatchDelete);

  refreshList();
}

async function refreshList() {
  const grid = document.getElementById('mediaGrid');
  if (!grid) return;
  try {
    const items = (await dbGetAllVaultItems()).filter(i => i.type === 'screenshot' && !i.archived);
    items.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
    if (items.length === 0) {
      grid.innerHTML = '<div class="empty">📂 Belum ada media.<br><br>Ketuk tombol <strong>+</strong> di bawah untuk tambah foto dari kamera, galeri, atau paste.</div>';
      return;
    }
    grid.innerHTML = items.map(item => {
      const selected = _batchSelected.has(item.id);
      const thumb = item.thumbnail_data_url || '';
      const date = new Date(item.created_at).toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' });
      const hasNote = (item.annotation_note || item.source?.annotationNote) ? '<span class="has-note">📝</span>' : '';
      return `
        <div class="media-card ${selected ? 'selected' : ''}" data-id="${item.id}">
          ${_batchMode ? `<div class="check">${selected ? '✓' : ''}</div>` : ''}
          <div class="thumb">${thumb ? `<img src="${thumb}" alt="" loading="lazy">` : '<div class="thumb-ph">🖼️</div>'}</div>
          <div class="meta">
            <div class="title">${escapeHtml(item.title || 'Untitled')}</div>
            <div class="date">${hasNote}${date}</div>
          </div>
        </div>
      `;
    }).join('');
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
  } catch (e) {
    grid.innerHTML = '<div class="empty">❌ Gagal memuat: ' + escapeHtml(e.message) + '</div>';
    console.error('[RecallFox] refreshList error:', e);
  }
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

async function openItemDetail(id) {
  const items = await dbGetAllVaultItems();
  const item = items.find(i => i.id === id);
  if (!item) return;
  showToast('Memuat gambar...');
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
        <div class="caption-preview">${escapeHtml(cap.textPlain).replace(/\n/g, '<br>')}</div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" data-action="copy-img">🖼️ Gambar</button>
        <button class="btn btn-primary" data-action="copy-cap">📋 + Keterangan</button>
        <button class="btn btn-secondary" data-action="copy-text">📝 Teks</button>
        <button class="btn btn-danger" data-action="delete">🗑️</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  setTimeout(() => modal.classList.add('open'), 10);

  const close = () => {
    modal.classList.remove('open');
    setTimeout(() => { if (modal.parentNode) document.body.removeChild(modal); }, 200);
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
    } else if (action === 'copy-text') {
      try { await navigator.clipboard.writeText(cap.textPlain); showToast('✓ Teks tersalin'); }
      catch (e) { showToast('Gagal: ' + e.message, true); }
    } else if (action === 'delete') {
      if (!confirm('Hapus screenshot ini? Tidak bisa di-undo.')) return;
      await deleteVaultItem(window.__rfUser, id);
      showToast('✓ Dihapus');
      close();
      refreshList();
      if (_onRefresh) _onRefresh();
    }
  });
}

async function doBatchCopy(mode) {
  if (_batchSelected.size === 0) { showToast('Pilih minimal 1 item', true); return; }
  showToast('Menyalin...');
  const items = await dbGetAllVaultItems();
  const screenshots = [];
  for (const id of _batchSelected) {
    const item = items.find(i => i.id === id);
    if (!item || item.type !== 'screenshot') continue;
    let dataUrl = null;
    if (mode !== 'text') {
      const blobRes = await getOrDownloadScreenshotBlob(item);
      dataUrl = blobRes.dataUrl;
    }
    screenshots.push({ item, dataUrl });
  }
  if (screenshots.length === 0) { showToast('Tidak ada screenshot valid', true); return; }

  if (mode === 'caption') {
    const cap = buildBatchCaption(screenshots);
    const r = await writeScreenshotToClipboard(screenshots[0]?.dataUrl, cap.textPlain, cap.textHtml);
    showToast(r.ok ? r.message : 'Gagal: ' + r.error, !r.ok);
  } else if (mode === 'image') {
    const r = await writeScreenshotToClipboard(screenshots[0]?.dataUrl, '', '');
    showToast(r.ok ? r.message : 'Gagal: ' + r.error, !r.ok);
  } else if (mode === 'text') {
    // Copy Teks Saja — gabungan judul + catatan anotasi semua item terpilih
    const parts = screenshots.map((s, i) => {
      const item = s.item;
      const pageTitle = item.source?.title || item.title || 'screenshot';
      const capturedAt = item.source?.capturedAt || item.created_at;
      const modeLabel = item.screenshot_mode === 'visible' ? 'Viewport'
        : item.screenshot_mode === 'selection' ? 'Area'
        : item.screenshot_mode === 'entire' ? 'Seluruh halaman'
        : (item.screenshot_mode || '-');
      const dims = (item.screenshot_width || 0) + '×' + (item.screenshot_height || 0) + ' px';
      const annotationNote = item.annotation_note || item.annotationNote || item.source?.annotationNote || '';
      const pageUrl = item.source?.url || '';
      const dateStr = new Date(capturedAt).toLocaleString('id-ID', { dateStyle: 'full', timeStyle: 'short' });
      let s_text = `${i + 1}. ${pageTitle}\n`;
      if (pageUrl) s_text += `Sumber: ${pageUrl}\n`;
      s_text += `Waktu: ${dateStr}\n`;
      s_text += `Mode: ${modeLabel} · ${dims}\n`;
      if (annotationNote) s_text += `Catatan: ${annotationNote}\n`;
      return s_text;
    });
    const fullText = parts.join('\n---\n\n');
    try {
      await navigator.clipboard.writeText(fullText);
      showToast(`✓ ${screenshots.length} item tersalin (teks saja)`);
    } catch (e) {
      showToast('Gagal: ' + e.message, true);
    }
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

// ===== Capture flow (dipanggil dari FAB menu) =====
export async function startCaptureFlow(source, onDone) {
  let picked = null;
  try {
    if (source === 'camera' || source === 'gallery') {
      picked = await pickImage(source);
    } else if (source === 'paste') {
      picked = await pasteFromClipboard();
      if (!picked) { showToast('Clipboard tidak ada gambar', true); return; }
    }
  } catch (e) {
    showToast('Gagal memuat gambar: ' + e.message, true);
    return;
  }
  if (!picked) return;

  // Buka annotate editor
  let annoRes;
  try {
    annoRes = await openAnnotateEditor(picked.dataUrl, {});
  } catch (e) {
    console.error('[RecallFox] annotate failed:', e);
    showToast('Anotasi gagal: ' + e.message, true);
    return;
  }
  if (annoRes.cancelled) return;

  const finalDataUrl = annoRes.dataUrl;
  showToast('Menyimpan...');

  // Pastikan user masih login
  if (!window.__rfUser) {
    showToast('Sesi habis. Login ulang.', true);
    return;
  }

  try {
    const res = await createScreenshotItem(window.__rfUser, {
      dataUrl: finalDataUrl,
      width: picked.width,
      height: picked.height,
      mode: 'selection',
      title: `HP Capture ${new Date().toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' })}`,
      annotationNote: annoRes.annotationNote
    });
    console.log('[RecallFox] createScreenshotItem result:', res);
    // v1.2.0: Toast akurat berdasarkan status sync
    if (res.ok && res.synced) {
      showToast('✓ Tersimpan & tersinkron');
    } else if (res.ok && res.partial) {
      // vault_items saved, but Storage upload failed — retry in background
      showToast('⚠ Tersimpan — gambar sedang diupload ulang', true);
    } else if (!res.ok && res.localOnly) {
      // Hanya tersimpan lokal — sync gagal, akan retry otomatis
      showToast('⚠ Tersimpan lokal — sync cloud gagal, akan retry otomatis', true);
    } else if (!res.ok) {
      showToast('Gagal: ' + (res.error || 'unknown'), true);
    }
    // Tetap refresh list supaya item muncul (meski hanya lokal)
    if (res.ok || res.localOnly) {
      if (window.__rfNavigate) window.__rfNavigate('media');
      else refreshList();
      if (onDone) onDone();
    }
  } catch (e) {
    console.error('[RecallFox] save failed:', e);
    showToast('Gagal simpan: ' + e.message, true);
  }
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
