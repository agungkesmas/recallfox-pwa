// src/copy-format.js — PORT dari addon lib/copy-format.js
// Format clipboard SAMA PERSIS dengan addon Firefox supaya paste konsisten.

export function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function buildScreenshotCaption(item, dataUrl, opts = {}) {
  if (!item) return { textPlain: '', textHtml: '' };

  const pageTitle = item.source?.title || item.title || 'screenshot';
  const pageUrl = item.source?.url || '';
  const capturedAt = item.source?.capturedAt || item.createdAt || new Date().toISOString();
  const modeRaw = item.screenshot_mode || item.screenshotMode || 'visible';
  const modeLabel = modeRaw === 'visible' ? 'Viewport'
    : modeRaw === 'selection' ? 'Area'
    : modeRaw === 'entire' ? 'Seluruh halaman'
    : modeRaw;
  const dims = (item.screenshot_width || item.screenshotWidth || 0) + '×' + (item.screenshot_height || item.screenshotHeight || 0) + ' px';
  const annotationNote = item.annotation_note || item.annotationNote || item.source?.annotationNote || item.source?.annotation_note || '';
  const capturedDateStr = new Date(capturedAt).toLocaleString('id-ID', { dateStyle: 'full', timeStyle: 'short' });

  const index = opts.index;
  const titlePrefix = (typeof index === 'number' && index > 0)
    ? '📸 ' + index + '. '
    : '📸 Screenshot — ';

  let textPlain = titlePrefix + pageTitle + '\n'
    + (pageUrl ? 'Sumber: ' + pageUrl + '\n' : '')
    + 'Waktu: ' + capturedDateStr + '\n'
    + 'Mode: ' + modeLabel + ' · ' + dims + '\n'
    + (annotationNote ? '📝 Catatan: ' + annotationNote + '\n' : '')
    + 'Ditangkap oleh RecallFox';

  let html = '<div style="font-family:-apple-system,system-ui,sans-serif;font-size:13px;color:#1c1917">';
  if (dataUrl) {
    html += '<p style="margin:0 0 6px"><img src="' + dataUrl + '" alt="screenshot" style="max-width:100%;border-radius:8px;border:1px solid #e7e5e4"/></p>';
  }
  html += '<p style="margin:8px 0 2px"><strong>' + titlePrefix + escapeHtml(pageTitle) + '</strong></p>';
  if (pageUrl) {
    html += '<p style="margin:0 0 2px;color:#57534e">🔗 <a href="' + escapeHtml(pageUrl) + '">' + escapeHtml(pageUrl) + '</a></p>';
  }
  html += '<p style="margin:0 0 2px;color:#57534e">🕒 ' + escapeHtml(capturedDateStr) + '</p>';
  if (annotationNote) {
    html += '<p style="margin:0 0 2px;color:#92400e;background:#fef3c7;padding:4px 8px;border-radius:4px">📝 ' + escapeHtml(annotationNote) + '</p>';
  }
  html += '<p style="margin:0;color:#78716c">🔧 ' + escapeHtml(modeLabel) + ' · ' + escapeHtml(dims) + ' · RecallFox</p>';
  html += '</div>';

  return { textPlain, textHtml: html };
}

export function buildBatchCaption(screenshots) {
  if (!Array.isArray(screenshots) || screenshots.length === 0) {
    return { textPlain: '', textHtml: '', count: 0 };
  }
  const now = new Date();
  const dateStr = now.toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });
  const count = screenshots.length;

  let textPlain = '# 📷 Screenshot Bundle — RecallFox\n'
    + 'Tanggal: ' + dateStr + ' · Total: ' + count + ' screenshot\n\n';
  let textHtml = '<div style="font-family:-apple-system,system-ui,sans-serif;font-size:13px;color:#1c1917">'
    + '<h1 style="margin:0 0 6px">📷 Screenshot Bundle — RecallFox</h1>'
    + '<p style="margin:0 0 10px;color:#57534e"><em>Tanggal: ' + escapeHtml(dateStr) + ' · Total: ' + count + ' screenshot</em></p>';

  for (let i = 0; i < screenshots.length; i++) {
    const { item, dataUrl } = screenshots[i];
    const idx = i + 1;
    const cap = buildScreenshotCaption(item, dataUrl, { index: idx });
    if (i > 0) {
      textPlain += '\n---\n\n';
      textHtml += '<hr style="border:none;border-top:1px solid #e7e5e4;margin:16px 0">';
    }
    textPlain += cap.textPlain + '\n\n';
    textPlain += '[📸 Gambar ' + idx + ' — ' + cap.dims + ']\n';
    textHtml += cap.textHtml;
  }
  textPlain += '\n— Ditangkap oleh RecallFox —';
  textHtml += '</div>';
  return { textPlain, textHtml, count };
}

export async function writeScreenshotToClipboard(dataUrl, textPlain, textHtml) {
  // Strategy 1: ClipboardItem multi-mime (image/png + text/html + text/plain)
  if (typeof ClipboardItem !== 'undefined' && dataUrl) {
    try {
      const resp = await fetch(dataUrl);
      const blob = await resp.blob();
      let pngBlob;
      if (blob.type === 'image/png') {
        pngBlob = blob;
      } else {
        const img = await createImageBitmap(blob);
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        canvas.getContext('2d').drawImage(img, 0, 0);
        pngBlob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      }
      if (!pngBlob) throw new Error('blob_conversion_failed');
      const item = new ClipboardItem({
        'image/png': pngBlob,
        'text/html': new Blob([textHtml], { type: 'text/html' }),
        'text/plain': new Blob([textPlain], { type: 'text/plain' })
      });
      await navigator.clipboard.write([item]);
      return { ok: true, message: '✓ Gambar + keterangan tersalin ke clipboard' };
    } catch (e) {
      console.warn('[RecallFox] clipboard.write ClipboardItem failed:', e.message);
    }
  }
  // Strategy 2: text/html + text/plain (image sebagai <img src=dataUrl>)
  if (typeof ClipboardItem !== 'undefined' && textHtml) {
    try {
      const item = new ClipboardItem({
        'text/html': new Blob([textHtml], { type: 'text/html' }),
        'text/plain': new Blob([textPlain], { type: 'text/plain' })
      });
      await navigator.clipboard.write([item]);
      return { ok: true, message: '✓ Keterangan + gambar (embedded) tersalin' };
    } catch (e) {
      console.warn('[RecallFox] clipboard.write text/html+plain failed:', e.message);
    }
  }
  // Strategy 3: text-only
  if (textPlain && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(textPlain);
      return { ok: true, message: '✓ Keterangan tersalin (text-only)', fallback: 'text_only' };
    } catch (e) {}
  }
  return { ok: false, error: 'clipboard_write_failed' };
}
