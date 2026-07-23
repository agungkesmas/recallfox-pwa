// src/views/media.js — Media tab: list + batch + detail
// v1.1.0: Render to #appMain (bukan #app) supaya bottom nav + FAB persist.
// v1.1.0: Capture flow dipindah ke startCaptureFlow() yang dipanggil dari FAB menu.
// v1.1.0: Tambah "Copy Teks Saja" di batch mode.
// v1.3.0: Tambah type='document' (CamScanner-like) — list display + viewer + startDocumentFlow

import { deleteVaultItem, getOrDownloadScreenshotBlob, createScreenshotItem, createDocumentItem, createDocumentItemMultiPage } from '../sync.js';
import { buildScreenshotCaption, buildBatchCaption, writeScreenshotToClipboard } from '../copy-format.js';
import { dbGetAllVaultItems } from '../db.js';
import { pickImage, pasteFromClipboard } from '../capture.js';
import { openAnnotateEditor } from '../annotate.js';
import { openDocumentEditor } from '../document.js';
import { openDocumentEditorMultiPage } from '../document-editor-v14.js';
import { openDocumentViewer } from '../document-viewer.js';

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
    // v1.3.0: Tampilkan screenshot DAN document
    const items = (await dbGetAllVaultItems()).filter(i =>
      (i.type === 'screenshot' || i.type === 'document') && !i.archived
    );
    items.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
    if (items.length === 0) {
      grid.innerHTML = '<div class="empty">📂 Belum ada media.<br><br>Ketuk tombol <strong>+</strong> di bawah untuk tambah foto, scan dokumen, atau paste.</div>';
      return;
    }
    grid.innerHTML = items.map(item => {
      const selected = _batchSelected.has(item.id);
      const thumb = item.thumbnail_data_url || '';
      const date = new Date(item.created_at).toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' });
      const hasNote = (item.annotation_note || item.source?.annotationNote) ? '<span class="has-note">📝</span>' : '';
      // v1.3.0: Badge khusus untuk document
      const isDoc = item.type === 'document';
      const docBadge = isDoc ? '<div class="type-badge type-doc">📄</div>' : '';
      const docPagesInfo = isDoc && item.source?.pages?.length > 1
        ? `${item.source.pages.length} hal · `
        : (isDoc ? '1 hal · ' : '');
      const filterBadge = isDoc && item.source?.pages?.[0]?.filter && item.source.pages[0].filter !== 'original'
        ? `<span class="filter-badge">${escapeHtml(item.source.pages[0].filter)}</span>`
        : '';
      const sizeKB = item.screenshot_bytes ? Math.round(item.screenshot_bytes * 0.75 / 1024) + ' KB' : '';
      return `
        <div class="media-card ${selected ? 'selected' : ''} ${isDoc ? 'media-card-doc' : ''}" data-id="${item.id}">
          ${docBadge}
          ${_batchMode ? `<div class="check">${selected ? '✓' : ''}</div>` : ''}
          <div class="thumb">${thumb ? `<img src="${thumb}" alt="" loading="lazy">` : '<div class="thumb-ph">🖼️</div>'}</div>
          <div class="meta">
            <div class="title">${escapeHtml(item.title || 'Untitled')}</div>
            <div class="date">${hasNote}${docPagesInfo}${date}${filterBadge ? ' · ' + filterBadge : ''}</div>
            ${sizeKB ? `<div class="size">${sizeKB}</div>` : ''}
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
  // v1.4.0: Route ke multi-page document viewer kalau type='document'
  if (item.type === 'document') {
    openDocumentViewer(item, refreshList);
    return;
  }
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

// ===== v1.3.0: Document viewer (CamScanner-like) =====
async function openDocumentDetail(item) {
  showToast('Memuat dokumen...');
  const blobRes = await getOrDownloadScreenshotBlob(item);
  const dataUrl = blobRes.dataUrl;
  const pages = item.source?.pages || [];
  const pageCount = pages.length || 1;
  const note = item.source?.annotationNote || '';
  const filter = pages[0]?.filter || 'original';
  const sizeKB = item.screenshot_bytes ? Math.round(item.screenshot_bytes * 0.75 / 1024) + ' KB' : '';
  const modal = document.createElement('div');
  modal.className = 'modal-overlay modal-doc';
  modal.innerHTML = `
    <div class="modal-card modal-card-doc">
      <div class="modal-header">
        <h3>📄 ${escapeHtml(item.title || 'Dokumen')}</h3>
        <button class="icon-btn" data-action="close">✕</button>
      </div>
      <div class="modal-body">
        <div class="doc-viewer">
          ${dataUrl
            ? `<img src="${dataUrl}" class="doc-image" alt="Dokumen">`
            : '<div class="empty">Gambar tidak tersedia</div>'}
        </div>
        <div class="doc-info">
          ${pageCount > 1 ? `<div class="doc-meta-row"><strong>Halaman:</strong> ${pageCount}</div>` : ''}
          <div class="doc-meta-row"><strong>Filter:</strong> <span class="filter-badge">${escapeHtml(filter)}</span></div>
          ${sizeKB ? `<div class="doc-meta-row"><strong>Ukuran:</strong> ${sizeKB}</div>` : ''}
          <div class="doc-meta-row"><strong>Dibuat:</strong> ${new Date(item.created_at).toLocaleString('id-ID', { dateStyle: 'full', timeStyle: 'short' })}</div>
          ${note ? `<div class="doc-meta-row"><strong>Catatan:</strong> ${escapeHtml(note)}</div>` : ''}
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" data-action="copy-img">🖼️ Gambar</button>
        <button class="btn btn-primary" data-action="copy-cap">📋 + Keterangan</button>
        <button class="btn btn-danger" data-action="delete">🗑️ Hapus</button>
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
      // Build custom caption for document
      const dateStr = new Date(item.created_at).toLocaleString('id-ID', { dateStyle: 'full', timeStyle: 'short' });
      const textPlain = `📄 ${item.title || 'Dokumen'}\n` +
        `Tipe: Dokumen scan${pageCount > 1 ? ` (${pageCount} halaman)` : ' (1 halaman)'}\n` +
        `Filter: ${filter}\n` +
        `Waktu: ${dateStr}\n` +
        (note ? `Catatan: ${note}\n` : '');
      const textHtml = `<div><p>📄 <b>${escapeHtml(item.title || 'Dokumen')}</b></p>` +
        `<p>Tipe: Dokumen scan${pageCount > 1 ? ` (${pageCount} halaman)` : ' (1 halaman)'}</p>` +
        `<p>Filter: ${escapeHtml(filter)}</p>` +
        `<p>Waktu: ${dateStr}</p>` +
        (note ? `<p>Catatan: ${escapeHtml(note)}</p>` : '') +
        `</div>`;
      const r = await writeScreenshotToClipboard(dataUrl, textPlain, textHtml);
      showToast(r.ok ? r.message : 'Gagal: ' + r.error, !r.ok);
    } else if (action === 'delete') {
      if (!confirm('Hapus dokumen ini? Tidak bisa di-undo.')) return;
      await deleteVaultItem(window.__rfUser, item.id);
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
    if (!item) continue;
    // v1.3.0: support both screenshot AND document
    if (item.type !== 'screenshot' && item.type !== 'document') continue;
    let dataUrl = null;
    if (mode !== 'text') {
      const blobRes = await getOrDownloadScreenshotBlob(item);
      dataUrl = blobRes.dataUrl;
    }
    screenshots.push({ item, dataUrl });
  }
  if (screenshots.length === 0) { showToast('Tidak ada item valid', true); return; }

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

// ===== v1.3.0: Document flow (CamScanner-like) =====
// Dipanggil dari FAB menu → option "Scan Dokumen"
export async function startDocumentFlow(source, onDone) {
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

  // v1.4.0: Buka multi-page document editor (Fase 4-5: auto-detect + batch)
  let docRes;
  try {
    docRes = await openDocumentEditorMultiPage(picked.dataUrl, {});
  } catch (e) {
    console.error('[RecallFox] document editor failed:', e);
    showToast('Editor dokumen gagal: ' + e.message, true);
    return;
  }
  if (docRes.cancelled || !docRes.pages || docRes.pages.length === 0) return;

  showToast(`Menyimpan ${docRes.pages.length} halaman...`);

  if (!window.__rfUser) {
    showToast('Sesi habis. Login ulang.', true);
    return;
  }

  try {
    const res = await createDocumentItemMultiPage(window.__rfUser, {
      pages: docRes.pages,
      title: docRes.title,
      note: docRes.note
    });
    console.log('[RecallFox] createDocumentItemMultiPage result:', res);
    if (res.ok) {
      showToast(`✓ ${docRes.pages.length} halaman tersimpan & tersinkron`);
    } else {
      showToast('⚠ Tersimpan lokal — sync cloud gagal: ' + (res.upsertError || 'unknown'), true);
    }
    if (window.__rfNavigate) window.__rfNavigate('media');
    else refreshList();
    if (onDone) onDone();
  } catch (e) {
    console.error('[RecallFox] save document failed:', e);
    showToast('Gagal simpan dokumen: ' + e.message, true);
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
