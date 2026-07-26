// src/compress.js — Kompresi gambar (quality + max dim + format)
// RecallFox PWA v1.4.0 — Fase 1: Kompresi (untuk foto biasa + dokumen)

/**
 * Kompresi gambar.
 * @param {string} dataUrl - input image data URL
 * @param {Object} opts
 *   - quality: 0-1 (default 0.7)
 *   - maxDim: max width/height in px (default 1920)
 *   - format: 'jpeg' | 'png' | 'webp' (default 'jpeg')
 * @returns {Promise<{dataUrl: string, originalSize: number, compressedSize: number, ratio: number}>}
 */
export async function compressImage(dataUrl, opts = {}) {
  const quality = opts.quality ?? 0.7;
  const maxDim = opts.maxDim ?? 1920;
  const format = opts.format || 'jpeg';

  const img = await loadImage(dataUrl);
  let w = img.naturalWidth;
  let h = img.naturalHeight;

  // Resize kalau melebihi maxDim
  const scale = Math.min(maxDim / w, maxDim / h, 1);
  if (scale < 1) {
    w = Math.round(w * scale);
    h = Math.round(h * scale);
  }

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');

  // Untuk JPEG, fill background putih dulu (karena JPEG tidak support alpha)
  if (format === 'jpeg') {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
  }

  ctx.drawImage(img, 0, 0, w, h);

  const mime = format === 'png' ? 'image/png'
    : format === 'webp' ? 'image/webp'
    : 'image/jpeg';
  const outDataUrl = canvas.toDataURL(mime, quality);

  const originalSize = estimateBase64Size(dataUrl);
  const compressedSize = estimateBase64Size(outDataUrl);
  const ratio = originalSize > 0 ? Math.round((1 - compressedSize / originalSize) * 100) : 0;

  return {
    dataUrl: outDataUrl,
    originalSize,
    compressedSize,
    ratio,
    width: w,
    height: h,
    format
  };
}

/**
 * Estimate ukuran bytes dari data URL base64.
 */
function estimateBase64Size(dataUrl) {
  if (!dataUrl) return 0;
  const commaIdx = dataUrl.indexOf(',');
  if (commaIdx < 0) return 0;
  const b64 = dataUrl.substring(commaIdx + 1);
  // base64 ~ 4/3 ratio
  return Math.round(b64.length * 0.75);
}

/**
 * Format bytes ke string human-readable.
 */
export function formatBytes(bytes) {
  if (!bytes || bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

/**
 * Open kompresi modal.
 * User pilih quality + maxDim + format → preview → terapkan.
 * @param {string} dataUrl
 * @returns {Promise<string|null>} compressed dataUrl, atau null kalau cancel
 */
export function openCompressModal(dataUrl) {
  return new Promise((resolve) => {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal-card modal-compress">
        <div class="modal-header">
          <h3>🗜️ Kompresi Gambar</h3>
          <button class="icon-btn" data-action="close">✕</button>
        </div>
        <div class="modal-body">
          <div class="compress-preview">
            <img id="compressPreview" src="${dataUrl}" alt="preview">
          </div>
          <div class="compress-stats" id="compressStats">
            <div>Original: <strong>${formatBytes(estimateBase64Size(dataUrl))}</strong></div>
            <div>Hasil: <strong id="compressResultSize">—</strong></div>
            <div>Hemat: <strong id="compressRatio">—</strong></div>
          </div>
          <div class="compress-controls">
            <label>Quality: <span id="qualityVal">70%</span></label>
            <input type="range" id="qualitySlider" min="10" max="100" value="70" step="5">

            <label>Max dimensi: <span id="maxDimVal">1920px</span></label>
            <select id="maxDimSelect">
              <option value="640">640px (kecil)</option>
              <option value="1024">1024px (sedang)</option>
              <option value="1920" selected>1920px (default)</option>
              <option value="2560">2560px (besar)</option>
              <option value="99999">Original (no resize)</option>
            </select>

            <label>Format:</label>
            <select id="formatSelect">
              <option value="jpeg" selected>JPEG (terkecil)</option>
              <option value="webp">WebP (modern)</option>
              <option value="png">PNG (lossless)</option>
            </select>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" data-action="close">Batal</button>
          <button class="btn btn-primary" data-action="apply">✓ Terapkan</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    setTimeout(() => modal.classList.add('open'), 10);

    const qualitySlider = modal.querySelector('#qualitySlider');
    const qualityVal = modal.querySelector('#qualityVal');
    const maxDimSelect = modal.querySelector('#maxDimSelect');
    const maxDimVal = modal.querySelector('#maxDimVal');
    const formatSelect = modal.querySelector('#formatSelect');
    const resultSize = modal.querySelector('#compressResultSize');
    const ratioEl = modal.querySelector('#compressRatio');
    const preview = modal.querySelector('#compressPreview');

    let previewTimer = null;
    let lastCompressed = null;

    async function updatePreview() {
      const quality = parseInt(qualitySlider.value) / 100;
      const maxDim = parseInt(maxDimSelect.value);
      const format = formatSelect.value;
      qualityVal.textContent = qualitySlider.value + '%';
      maxDimVal.textContent = maxDim >= 99999 ? 'Original' : maxDim + 'px';

      try {
        const res = await compressImage(dataUrl, { quality, maxDim, format });
        lastCompressed = res;
        preview.src = res.dataUrl;
        resultSize.textContent = formatBytes(res.compressedSize);
        ratioEl.textContent = res.ratio > 0 ? `-${res.ratio}%` : `+${Math.abs(res.ratio)}%`;
        ratioEl.style.color = res.ratio > 0 ? 'var(--success)' : 'var(--danger)';
      } catch (e) {
        resultSize.textContent = 'Error: ' + e.message;
      }
    }

    function debouncedUpdate() {
      if (previewTimer) clearTimeout(previewTimer);
      previewTimer = setTimeout(updatePreview, 300);
    }

    qualitySlider.addEventListener('input', debouncedUpdate);
    maxDimSelect.addEventListener('change', updatePreview);
    formatSelect.addEventListener('change', updatePreview);

    // Initial preview
    updatePreview();

    const close = (result) => {
      modal.classList.remove('open');
      setTimeout(() => { if (modal.parentNode) document.body.removeChild(modal); }, 200);
      resolve(result);
    };

    modal.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) {
        if (e.target === modal) close(null);
        return;
      }
      const action = btn.dataset.action;
      if (action === 'close') close(null);
      else if (action === 'apply') close(lastCompressed ? lastCompressed.dataUrl : dataUrl);
    });
  });
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image load failed'));
    img.src = dataUrl;
  });
}
