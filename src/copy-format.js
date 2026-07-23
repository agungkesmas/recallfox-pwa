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
  // v1.2.0 FIX BUG #1: Copy-paste gambar gagal di HP Android (WhatsApp/Gemini/ChatGPT).
  //
  // Penyebab sebelumnya:
  //   1. Strategy 1 pakai multi-mime (image/png + text/html + text/plain). Banyak
  //      app Android hanya baca image/png ATAU text/plain dari ClipboardItem — kalau
  //      ada text/html juga, mereka ambil text/html (yang tidak mereka render) → paste kosong.
  //   2. fetch(dataUrl) untuk data URL besar (>2MB) kadang gagal di mobile.
  //   3. canvas.toBlob() untuk dimensi besar bisa hang di mobile kelas menengah.
  //
  // Fix:
  //   - Mobile (Android/iOS): coba image/png saja DULU (paling kompatibel).
  //     Kalau user minta caption, kasih toast "Gambar tersalin, ketuk Teks untuk caption".
  //   - Desktop: coba multi-mime DULU (rich paste di Slack/Gmail/Notion).
  //   - Konversi dataUrl → Blob pakai atob (lebih reliable di mobile) + fallback fetch.
  //   - Limit dimensi canvas ke 2000px max — kalau lebih, resize dulu supaya toBlob tidak hang.
  //
  // Strategi fallback:
  //   1a. Desktop multi-mime (image/png + text/html + text/plain)
  //   1b. Image/png saja (mobile atau desktop fallback)
  //   2. text/html + text/plain (image sebagai <img src=dataUrl> embedded)
  //   3. text-only

  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const hasCaption = !!(textPlain && textHtml);

  // ===== Strategy 1: ClipboardItem dengan image/png =====
  if (typeof ClipboardItem !== 'undefined' && dataUrl) {
    try {
      // Konversi dataUrl → Blob (pakai atob lebih reliable di mobile)
      let blob = dataUrlToBlobLocal(dataUrl);
      if (!blob) {
        // Fallback ke fetch (untuk data URL non-base64 atau blob: URLs)
        const resp = await fetch(dataUrl);
        if (!resp.ok) throw new Error('fetch_failed_' + resp.status);
        blob = await resp.blob();
      }
      if (!blob || blob.size === 0) throw new Error('empty_blob');

      // Convert ke PNG + limit dimensi supaya toBlob tidak hang di mobile
      let pngBlob;
      if (blob.type === 'image/png') {
        // Tetap perlu cek dimensi — kalau terlalu besar, resize dulu
        pngBlob = await maybeResizePng(blob);
      } else {
        const img = await createImageBitmap(blob);
        const canvas = document.createElement('canvas');
        const MAX_DIM = 2000;
        let w = img.width;
        let h = img.height;
        if (w > MAX_DIM || h > MAX_DIM) {
          const scale = Math.min(MAX_DIM / w, MAX_DIM / h);
          w = Math.round(w * scale);
          h = Math.round(h * scale);
        }
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        pngBlob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png', 0.92));
      }
      if (!pngBlob) throw new Error('png_conversion_failed');

      // Desktop: coba multi-mime DULU kalau ada caption (rich paste di Slack/Gmail/Notion)
      if (!isMobile && hasCaption) {
        try {
          const item = new ClipboardItem({
            'image/png': pngBlob,
            'text/html': new Blob([textHtml], { type: 'text/html' }),
            'text/plain': new Blob([textPlain], { type: 'text/plain' })
          });
          await navigator.clipboard.write([item]);
          return { ok: true, message: '✓ Gambar + keterangan tersalin ke clipboard' };
        } catch (e) {
          console.warn('[RecallFox] desktop multi-mime failed, fallback to image-only:', e.message);
        }
      }

      // Mobile ATAU desktop tanpa caption: image/png saja (paling kompatibel)
      const item = new ClipboardItem({ 'image/png': pngBlob });
      await navigator.clipboard.write([item]);
      return {
        ok: true,
        message: isMobile && hasCaption
          ? '✓ Gambar tersalin. Untuk keterangan, ketuk "📝 Teks" setelah paste gambar.'
          : '✓ Gambar tersalin ke clipboard'
      };
    } catch (e) {
      console.warn('[RecallFox] clipboard.write ClipboardItem failed:', e.message);
    }
  }

  // ===== Strategy 2: text/html + text/plain (image sebagai <img src=dataUrl> embedded) =====
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

  // ===== Strategy 3: text-only =====
  if (textPlain && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(textPlain);
      return { ok: true, message: '✓ Keterangan tersalin (text-only)', fallback: 'text_only' };
    } catch (e) {}
  }
  return { ok: false, error: 'clipboard_write_failed' };
}

// ===== Local helpers =====
function dataUrlToBlobLocal(dataUrl) {
  try {
    if (!dataUrl || !dataUrl.startsWith('data:')) return null;
    const [meta, b64] = dataUrl.split(',');
    if (!b64 || !meta.includes(';base64')) return null;
    const mimeMatch = meta.match(/data:([^;]+)/);
    const mime = mimeMatch ? mimeMatch[1] : 'image/png';
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  } catch (e) {
    return null;
  }
}

async function maybeResizePng(pngBlob) {
  try {
    // Cek dimensi — kalau >2000px, resize dulu
    const img = await createImageBitmap(pngBlob);
    const MAX_DIM = 2000;
    if (img.width <= MAX_DIM && img.height <= MAX_DIM) {
      return pngBlob; // tidak perlu resize
    }
    const scale = Math.min(MAX_DIM / img.width, MAX_DIM / img.height);
    const w = Math.round(img.width * scale);
    const h = Math.round(img.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(img, 0, 0, w, h);
    return await new Promise(resolve => canvas.toBlob(resolve, 'image/png', 0.92));
  } catch (e) {
    // Kalau resize gagal, kembalikan blob asli
    return pngBlob;
  }
}
