// src/document-viewer.js — Document viewer multi-page (Fase 6)
// RecallFox PWA v1.4.0
//
// Fitur:
//   - Swipe ←/→ untuk ganti halaman
//   - Pagination dots
//   - Tombol: prev/next, copy halaman ini, copy semua halaman, copy keterangan, hapus
//   - Lazy download per halaman dari Supabase Storage

import { writeScreenshotToClipboard, buildScreenshotCaption, escapeHtml } from './copy-format.js';
import { deleteVaultItem } from './sync.js';

/**
 * Open multi-page document viewer.
 * @param {Object} item - vault item type='document'
 * @param {Function} onRefresh - callback after delete
 */
export async function openDocumentViewer(item, onRefresh) {
  const pages = item.source?.pages || [];
  if (pages.length === 0) {
    alert('Dokumen tidak punya halaman');
    return;
  }

  let currentPage = 0;
  const totalPages = pages.length;
  const pageDataUrls = new Array(totalPages).fill(null); // cache downloaded

  const modal = document.createElement('div');
  modal.className = 'modal-overlay modal-doc-viewer';
  modal.innerHTML = `
    <div class="modal-card modal-card-doc-viewer">
      <div class="modal-header">
        <h3>📄 ${escapeHtml(item.title || 'Dokumen')}</h3>
        <button class="icon-btn" data-action="close">✕</button>
      </div>
      <div class="modal-body">
        <div class="doc-viewer-pages" id="docViewerPages">
          <div class="doc-viewer-loading">⏳ Memuat halaman 1...</div>
        </div>
        ${totalPages > 1 ? `
          <div class="doc-pagination">
            ${Array.from({ length: totalPages }, (_, i) =>
              `<span class="doc-page-dot ${i === 0 ? 'active' : ''}" data-idx="${i}"></span>`
            ).join('')}
          </div>
        ` : ''}
      </div>
      <div class="modal-footer">
        ${totalPages > 1 ? `<button class="btn btn-secondary" data-action="prev">◀</button>` : ''}
        <span class="doc-page-indicator" id="docPageIndicator">Hal 1/${totalPages}</span>
        ${totalPages > 1 ? `<button class="btn btn-secondary" data-action="next">▶</button>` : ''}
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" data-action="copy-page">🖼️ Hal Ini</button>
        ${totalPages > 1 ? `<button class="btn btn-secondary" data-action="copy-all">📚 Semua</button>` : ''}
        <button class="btn btn-primary" data-action="copy-cap">📋 + Keterangan</button>
        <button class="btn btn-danger" data-action="delete">🗑️</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  setTimeout(() => modal.classList.add('open'), 10);

  const pagesContainer = modal.querySelector('#docViewerPages');
  const pageIndicator = modal.querySelector('#docPageIndicator');

  // Download page image (lazy + cache)
  async function loadPage(idx) {
    if (pageDataUrls[idx]) return pageDataUrls[idx];
    const page = pages[idx];
    if (!page?.url) return null;
    try {
      const res = await fetch(page.url);
      if (!res.ok) return null;
      const blob = await res.blob();
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('filereader_failed'));
        reader.readAsDataURL(blob);
      });
      pageDataUrls[idx] = dataUrl;
      return dataUrl;
    } catch (e) {
      console.error('[RecallFox] loadPage failed:', e.message);
      return null;
    }
  }

  async function renderPage(idx) {
    currentPage = idx;
    if (pageIndicator) pageIndicator.textContent = `Hal ${idx + 1}/${totalPages}`;
    // Update pagination dots
    modal.querySelectorAll('.doc-page-dot').forEach((d, i) => {
      d.classList.toggle('active', i === idx);
    });

    pagesContainer.innerHTML = '<div class="doc-viewer-loading">⏳ Memuat halaman ' + (idx + 1) + '...</div>';
    const dataUrl = await loadPage(idx);
    if (!dataUrl) {
      pagesContainer.innerHTML = '<div class="empty">❌ Gagal memuat halaman</div>';
      return;
    }
    pagesContainer.innerHTML = `<img src="${dataUrl}" class="doc-page-image" alt="Halaman ${idx + 1}">`;
  }

  // Swipe handlers
  let touchStartX = 0, touchEndX = 0;
  pagesContainer.addEventListener('touchstart', (e) => {
    touchStartX = e.touches[0].clientX;
  });
  pagesContainer.addEventListener('touchend', (e) => {
    touchEndX = e.changedTouches[0].clientX;
    const diff = touchStartX - touchEndX;
    if (Math.abs(diff) > 50) {
      if (diff > 0 && currentPage < totalPages - 1) {
        renderPage(currentPage + 1);
      } else if (diff < 0 && currentPage > 0) {
        renderPage(currentPage - 1);
      }
    }
  });

  // Pagination dot click
  modal.querySelectorAll('.doc-page-dot').forEach(dot => {
    dot.addEventListener('click', () => {
      renderPage(parseInt(dot.dataset.idx));
    });
  });

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
    if (action === 'prev') {
      if (currentPage > 0) renderPage(currentPage - 1);
    } else if (action === 'next') {
      if (currentPage < totalPages - 1) renderPage(currentPage + 1);
    } else if (action === 'copy-page') {
      const dataUrl = pageDataUrls[currentPage];
      if (!dataUrl) { showToast('Halaman belum termuat', true); return; }
      const r = await writeScreenshotToClipboard(dataUrl, '', '');
      showToast(r.ok ? '✓ Halaman tersalin' : 'Gagal: ' + r.error, !r.ok);
    } else if (action === 'copy-all') {
      // Composite semua halaman jadi 1 gambar (vertical stack)
      showToast('Menyiapkan semua halaman...');
      const dataUrls = await Promise.all(pages.map((_, i) => loadPage(i)));
      const validUrls = dataUrls.filter(Boolean);
      if (validUrls.length === 0) { showToast('Tidak ada halaman termuat', true); return; }
      // Load all images
      const imgs = await Promise.all(validUrls.map(loadImage));
      const totalH = imgs.reduce((sum, img) => sum + img.naturalHeight, 0);
      const maxW = Math.max(...imgs.map(img => img.naturalWidth));
      const canvas = document.createElement('canvas');
      canvas.width = maxW;
      canvas.height = totalH;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, maxW, totalH);
      let y = 0;
      for (const img of imgs) {
        ctx.drawImage(img, 0, y);
        y += img.naturalHeight;
      }
      const allDataUrl = canvas.toDataURL('image/png');
      // Build caption with all pages
      const cap = buildDocCaption(item, validUrls.length);
      const r = await writeScreenshotToClipboard(allDataUrl, cap.textPlain, cap.textHtml);
      showToast(r.ok ? `✓ ${validUrls.length} halaman tersalin` : 'Gagal: ' + r.error, !r.ok);
    } else if (action === 'copy-cap') {
      const dataUrl = pageDataUrls[currentPage];
      const cap = buildDocCaption(item, totalPages, currentPage + 1);
      const r = await writeScreenshotToClipboard(dataUrl, cap.textPlain, cap.textHtml);
      showToast(r.ok ? '✓ Keterangan tersalin' : 'Gagal: ' + r.error, !r.ok);
    } else if (action === 'delete') {
      if (!confirm(`Hapus dokumen "${item.title}" (${totalPages} halaman)? Tidak bisa di-undo.`)) return;
      await deleteVaultItem(window.__rfUser, item.id);
      showToast('✓ Dokumen dihapus');
      close();
      if (onRefresh) onRefresh();
    }
  });

  // Initial load
  renderPage(0);
}

// ===== Helpers =====

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image load failed'));
    img.src = dataUrl;
  });
}

function buildDocCaption(item, totalPages, currentPage) {
  const pageTitle = item.title || 'Dokumen';
  const capturedAt = item.source?.capturedAt || item.created_at || new Date().toISOString();
  const capturedDateStr = new Date(capturedAt).toLocaleString('id-ID', { dateStyle: 'full', timeStyle: 'short' });
  const note = item.source?.annotationNote || '';
  const pageStr = totalPages > 1 ? (currentPage ? ` (hal ${currentPage}/${totalPages})` : ` (${totalPages} halaman)`) : '';

  const textPlain = `📄 ${pageTitle}${pageStr}\n`
    + `Waktu: ${capturedDateStr}\n`
    + (totalPages > 1 ? `Total halaman: ${totalPages}\n` : '')
    + (note ? `📝 Catatan: ${note}\n` : '')
    + `Ditangkap oleh RecallFox`;

  const textHtml = `<div style="font-family:-apple-system,system-ui,sans-serif;font-size:13px;color:#1c1917">`
    + `<p style="margin:8px 0 2px"><strong>📄 ${escapeHtml(pageTitle)}${pageStr}</strong></p>`
    + `<p style="margin:0 0 2px;color:#57534e">🕒 ${escapeHtml(capturedDateStr)}</p>`
    + (totalPages > 1 ? `<p style="margin:0 0 2px;color:#57534e">📚 ${totalPages} halaman</p>` : '')
    + (note ? `<p style="margin:0 0 2px;color:#92400e;background:#fef3c7;padding:4px 8px;border-radius:4px">📝 ${escapeHtml(note)}</p>` : '')
    + `<p style="margin:0;color:#78716c">🔧 RecallFox Dokumen</p>`
    + `</div>`;

  return { textPlain, textHtml };
}

function showToast(msg, isError = false) {
  const t = document.createElement('div');
  t.className = 'toast' + (isError ? ' toast-error' : '');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.classList.add('show'), 10);
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => { if (t.parentNode) document.body.removeChild(t); }, 300); }, 2500);
}
