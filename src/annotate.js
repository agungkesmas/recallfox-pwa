// src/annotate.js — Annotation editor (PORT dari addon content/annotate.js)
// Mobile-friendly: toolbar di bawah, touch events, 8 tools + Kompres (v1.3.0).
// Tools: arrow, line, rect, ellipse, text, highlight, blur, pen, + Kompres

const TOOLS = [
  { id: 'pen',       icon: '✏️', label: 'Pena' },
  { id: 'arrow',     icon: '➜', label: 'Panah' },
  { id: 'line',      icon: '／', label: 'Garis' },
  { id: 'rect',      icon: '▭', label: 'Kotak' },
  { id: 'ellipse',   icon: '◯', label: 'Lingkaran' },
  { id: 'text',      icon: 'T',  label: 'Teks' },
  { id: 'highlight', icon: '🖍️', label: 'Highlight' },
  { id: 'blur',      icon: '🌫️', label: 'Blur' }
];

// v1.3.0: Compression presets — quick one-tap compress
const COMPRESS_PRESETS = [
  { id: 'light',  label: 'Ringan',  quality: 0.85, maxDim: 2560, desc: 'Kualitas tinggi' },
  { id: 'medium', label: 'Sedang',  quality: 0.70, maxDim: 1920, desc: 'Seimbang (default)' },
  { id: 'strong', label: 'Kuat',    quality: 0.55, maxDim: 1280, desc: 'Hemat kuota' },
  { id: 'custom', label: 'Custom',  quality: 0.70, maxDim: 1920, desc: 'Atur sendiri' }
];

const COLORS = ['#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899', '#000000', '#ffffff'];

/**
 * Open annotation editor fullscreen.
 * @param {string} dataUrl - original image data URL
 * @param {Object} opts - { initialNote }
 * @returns {Promise<{dataUrl: string, annotationNote: string, cancelled: boolean}>}
 */
export function openAnnotateEditor(dataUrl, opts = {}) {
  return new Promise((resolve) => {
    // ===== State =====
    let currentTool = 'arrow';
    let currentColor = '#ef4444';
    let currentStroke = 4;
    let drawing = false;
    let startX = 0, startY = 0, lastX = 0, lastY = 0;
    let freehandPath = [];
    let undoStack = [];
    let redoStack = [];
    let imgWidth = 0, imgHeight = 0;
    let displayScale = 1;
    let annotationNote = opts.initialNote || '';

    // ===== DOM =====
    const overlay = document.createElement('div');
    overlay.className = 'rf-annotate-overlay';
    overlay.innerHTML = `
      <div class="rf-anno-top">
        <button class="rf-anno-btn" data-action="cancel">✕</button>
        <div class="rf-anno-title">Anotasi</div>
        <button class="rf-anno-btn rf-anno-primary" data-action="done">✓</button>
      </div>
      <div class="rf-anno-canvas-wrap">
        <canvas class="rf-anno-bg"></canvas>
        <canvas class="rf-anno-draw"></canvas>
        <canvas class="rf-anno-preview"></canvas>
        <input class="rf-anno-text-input" type="text" style="display:none" placeholder="Teks...">
      </div>
      <div class="rf-anno-note-row">
        <input class="rf-anno-note-input" type="text" placeholder="📝 Catatan anotasi (opsional)..." value="${annotationNote.replace(/"/g, '&quot;')}">
      </div>
      <div class="rf-anno-toolbar">
        <div class="rf-anno-tools">
          ${TOOLS.map(t => `<button class="rf-anno-tool ${t.id === currentTool ? 'active' : ''}" data-tool="${t.id}"><span class="rf-anno-ic">${t.icon}</span><span class="rf-anno-lb">${t.label}</span></button>`).join('')}
        </div>
        <div class="rf-anno-colors">
          ${COLORS.map(c => `<button class="rf-anno-color ${c === currentColor ? 'active' : ''}" style="background:${c}" data-color="${c}"></button>`).join('')}
        </div>
        <div class="rf-anno-actions">
          <button class="rf-anno-btn" data-action="undo">↶</button>
          <button class="rf-anno-btn" data-action="redo">↷</button>
          <button class="rf-anno-btn rf-anno-compress" data-action="compress" title="Kompresi">🗜️</button>
          <button class="rf-anno-btn rf-anno-danger" data-action="clear">🗑️</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    document.body.style.overflow = 'hidden';

    const bgCanvas = overlay.querySelector('.rf-anno-bg');
    const drawCanvas = overlay.querySelector('.rf-anno-draw');
    const previewCanvas = overlay.querySelector('.rf-anno-preview');
    const textInput = overlay.querySelector('.rf-anno-text-input');
    const noteInput = overlay.querySelector('.rf-anno-note-input');
    const bgCtx = bgCanvas.getContext('2d');
    const drawCtx = drawCanvas.getContext('2d');
    const previewCtx = previewCanvas.getContext('2d');

    // ===== Load image =====
    const img = new Image();
    img.onload = () => {
      imgWidth = img.naturalWidth;
      imgHeight = img.naturalHeight;
      // Scale to fit viewport (max width = viewport - 20px, max height = 60vh)
      const wrap = overlay.querySelector('.rf-anno-canvas-wrap');
      const maxW = window.innerWidth - 20;
      const maxH = window.innerHeight * 0.55;
      displayScale = Math.min(maxW / imgWidth, maxH / imgHeight, 1);
      const dispW = imgWidth * displayScale;
      const dispH = imgHeight * displayScale;

      [bgCanvas, drawCanvas, previewCanvas].forEach(c => {
        c.width = imgWidth;
        c.height = imgHeight;
        c.style.width = dispW + 'px';
        c.style.height = dispH + 'px';
      });
      bgCtx.drawImage(img, 0, 0);
    };
    img.src = dataUrl;

    // ===== Helper: get canvas coords from touch/mouse =====
    function getCoords(e) {
      const rect = drawCanvas.getBoundingClientRect();
      const clientX = e.touches?.[0]?.clientX ?? e.clientX;
      const clientY = e.touches?.[0]?.clientY ?? e.clientY;
      return {
        x: (clientX - rect.left) / displayScale,
        y: (clientY - rect.top) / displayScale
      };
    }

    function saveUndoState() {
      undoStack.push(drawCanvas.toDataURL());
      if (undoStack.length > 30) undoStack.shift();
      redoStack = [];
    }

    function restoreUndoState() {
      if (undoStack.length === 0) return;
      const dataUrl = undoStack.pop();
      const img2 = new Image();
      img2.onload = () => {
        drawCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
        drawCtx.drawImage(img2, 0, 0);
      };
      img2.src = dataUrl;
    }

    function restoreRedoState() {
      if (redoStack.length === 0) return;
      const dataUrl = redoStack.pop();
      undoStack.push(drawCanvas.toDataURL());
      const img2 = new Image();
      img2.onload = () => {
        drawCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
        drawCtx.drawImage(img2, 0, 0);
      };
      img2.src = dataUrl;
    }

    function clearAll() {
      saveUndoState();
      drawCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
    }

    // ===== Draw functions =====
    function drawArrow(ctx, x1, y1, x2, y2, color, stroke) {
      const headLen = Math.max(stroke * 3, 10);
      const angle = Math.atan2(y2 - y1, x2 - x1);
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = stroke;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - headLen * Math.cos(angle - Math.PI / 6), y2 - headLen * Math.sin(angle - Math.PI / 6));
      ctx.lineTo(x2 - headLen * Math.cos(angle + Math.PI / 6), y2 - headLen * Math.sin(angle + Math.PI / 6));
      ctx.closePath();
      ctx.fill();
    }

    function drawShape(ctx, tool, x1, y1, x2, y2, color, stroke) {
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = stroke;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      if (tool === 'line') {
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      } else if (tool === 'rect') {
        ctx.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
      } else if (tool === 'ellipse') {
        ctx.beginPath();
        ctx.ellipse((x1 + x2) / 2, (y1 + y2) / 2, Math.abs(x2 - x1) / 2, Math.abs(y2 - y1) / 2, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    function applyBlur(ctx, x1, y1, x2, y2) {
      const sx = Math.min(x1, x2), sy = Math.min(y1, y2);
      const sw = Math.abs(x2 - x1), sh = Math.abs(y2 - y1);
      if (sw < 2 || sh < 2) return;
      const tmp = document.createElement('canvas');
      tmp.width = sw;
      tmp.height = sh;
      const tmpCtx = tmp.getContext('2d');
      tmpCtx.drawImage(bgCanvas, sx, sy, sw, sh, 0, 0, sw, sh);
      tmpCtx.filter = 'blur(8px)';
      tmpCtx.drawImage(tmp, 0, 0);
      ctx.drawImage(tmp, sx, sy);
    }

    function drawFreehand(ctx, path, color, stroke) {
      if (path.length < 2) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = stroke;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(path[0].x, path[0].y);
      for (let i = 1; i < path.length; i++) {
        ctx.lineTo(path[i].x, path[i].y);
      }
      ctx.stroke();
    }

    function drawHighlight(ctx, path, color) {
      if (path.length < 2) return;
      ctx.strokeStyle = color + '60'; // semi-transparent
      ctx.lineWidth = 20;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(path[0].x, path[0].y);
      for (let i = 1; i < path.length; i++) {
        ctx.lineTo(path[i].x, path[i].y);
      }
      ctx.stroke();
    }

    // ===== Pointer events =====
    function onStart(e) {
      e.preventDefault();
      if (currentTool === 'text') {
        const { x, y } = getCoords(e);
        showTextInput(x, y);
        return;
      }
      drawing = true;
      const { x, y } = getCoords(e);
      startX = x; startY = y; lastX = x; lastY = y;
      saveUndoState();
      if (currentTool === 'pen' || currentTool === 'highlight') {
        freehandPath = [{ x, y }];
      }
    }

    function onMove(e) {
      if (!drawing) return;
      e.preventDefault();
      const { x, y } = getCoords(e);
      if (currentTool === 'pen') {
        freehandPath.push({ x, y });
        previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
        drawFreehand(previewCtx, freehandPath, currentColor, currentStroke);
      } else if (currentTool === 'highlight') {
        freehandPath.push({ x, y });
        previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
        drawHighlight(previewCtx, freehandPath, currentColor);
      } else if (currentTool === 'blur') {
        previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
        applyBlur(previewCtx, startX, startY, x, y);
      } else {
        previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
        if (currentTool === 'arrow') {
          drawArrow(previewCtx, startX, startY, x, y, currentColor, currentStroke);
        } else {
          drawShape(previewCtx, currentTool, startX, startY, x, y, currentColor, currentStroke);
        }
      }
      lastX = x; lastY = y;
    }

    function onEnd(e) {
      if (!drawing) return;
      drawing = false;
      // Composite preview ke draw canvas
      drawCtx.drawImage(previewCanvas, 0, 0);
      previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
      freehandPath = [];
    }

    function showTextInput(x, y) {
      const rect = drawCanvas.getBoundingClientRect();
      textInput.style.display = 'block';
      textInput.style.left = (rect.left + x * displayScale) + 'px';
      textInput.style.top = (rect.top + y * displayScale - 12) + 'px';
      textInput.value = '';
      textInput.focus();
      const commit = () => {
        const txt = textInput.value.trim();
        if (txt) {
          saveUndoState();
          drawCtx.fillStyle = currentColor;
          drawCtx.font = `${16 / displayScale * 2}px sans-serif`;
          drawCtx.textBaseline = 'middle';
          drawCtx.fillText(txt, x, y);
        }
        textInput.style.display = 'none';
        textInput.removeEventListener('blur', commit);
        textInput.removeEventListener('keydown', onTextKey);
      };
      const onTextKey = (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
        if (ev.key === 'Escape') { textInput.style.display = 'none'; textInput.removeEventListener('blur', commit); textInput.removeEventListener('keydown', onTextKey); }
      };
      textInput.addEventListener('blur', commit);
      textInput.addEventListener('keydown', onTextKey);
    }

    // Mouse + touch events on preview canvas (top layer)
    previewCanvas.addEventListener('mousedown', onStart);
    previewCanvas.addEventListener('mousemove', onMove);
    previewCanvas.addEventListener('mouseup', onEnd);
    previewCanvas.addEventListener('mouseleave', onEnd);
    previewCanvas.addEventListener('touchstart', onStart, { passive: false });
    previewCanvas.addEventListener('touchmove', onMove, { passive: false });
    previewCanvas.addEventListener('touchend', onEnd);

    // ===== Button handlers =====
    overlay.addEventListener('click', (e) => {
      const target = e.target.closest('button');
      if (!target) return;
      const action = target.dataset.action;
      const tool = target.dataset.tool;
      const color = target.dataset.color;

      if (tool) {
        currentTool = tool;
        overlay.querySelectorAll('.rf-anno-tool').forEach(b => b.classList.toggle('active', b.dataset.tool === tool));
      } else if (color) {
        currentColor = color;
        overlay.querySelectorAll('.rf-anno-color').forEach(b => b.classList.toggle('active', b.dataset.color === color));
      } else if (action === 'cancel') {
        cleanup();
        resolve({ cancelled: true });
      } else if (action === 'done') {
        // Composite draw onto bg → export PNG
        bgCtx.drawImage(drawCanvas, 0, 0);
        const outDataUrl = bgCanvas.toDataURL('image/png');
        annotationNote = noteInput.value.trim();
        cleanup();
        resolve({ dataUrl: outDataUrl, annotationNote, cancelled: false });
      } else if (action === 'undo') {
        restoreUndoState();
      } else if (action === 'redo') {
        restoreRedoState();
      } else if (action === 'clear') {
        clearAll();
      } else if (action === 'compress') {
        // v1.3.0: Buka modal kompresi
        openCompressModal();
      }
    });

    // ===== v1.3.0: Compression Modal =====
    function openCompressModal() {
      // Composite dulu draw onto bg supaya preview = hasil akhir (sebelum compress)
      const previewCanvas = document.createElement('canvas');
      previewCanvas.width = imgWidth;
      previewCanvas.height = imgHeight;
      const previewCtx = previewCanvas.getContext('2d');
      previewCtx.drawImage(bgCanvas, 0, 0);
      previewCtx.drawImage(drawCanvas, 0, 0);
      const currentDataUrl = previewCanvas.toDataURL('image/png');
      const currentBytes = Math.round(currentDataUrl.length * 0.75); // approx base64 → bytes

      // Default preset: medium
      let selectedPreset = 'medium';
      let customQuality = 0.70;
      let customMaxDim = 1920;
      let customFormat = 'image/jpeg';

      const modal = document.createElement('div');
      modal.className = 'rf-compress-overlay';
      modal.innerHTML = `
        <div class="rf-compress-card">
          <div class="rf-compress-header">
            <h3>🗜️ Kompresi Gambar</h3>
            <button class="rf-compress-close" data-action="cancel">✕</button>
          </div>
          <div class="rf-compress-body">
            <div class="rf-compress-current">
              <div>Ukuran saat ini</div>
              <div class="rf-compress-size" id="rfCurSize">${formatBytes(currentBytes)}</div>
            </div>

            <div class="rf-compress-presets">
              ${COMPRESS_PRESETS.map(p => `
                <button class="rf-preset-btn ${p.id === selectedPreset ? 'active' : ''}" data-preset="${p.id}">
                  <div class="rf-preset-name">${p.label}</div>
                  <div class="rf-preset-desc">${p.desc}</div>
                </button>
              `).join('')}
            </div>

            <div class="rf-compress-custom" id="rfCustomPanel" style="display:none">
              <div class="rf-compress-field">
                <label>Quality: <span id="rfQualityVal">70%</span></label>
                <input type="range" min="10" max="100" value="70" id="rfQuality" class="rf-range">
              </div>
              <div class="rf-compress-field">
                <label>Max dimensi: <span id="rfMaxDimVal">1920px</span></label>
                <select id="rfMaxDim" class="rf-select">
                  <option value="4096">4096px (asli)</option>
                  <option value="2560" selected>2560px</option>
                  <option value="1920">1920px</option>
                  <option value="1280">1280px</option>
                  <option value="1024">1024px</option>
                  <option value="768">768px</option>
                </select>
              </div>
              <div class="rf-compress-field">
                <label>Format:</label>
                <select id="rfFormat" class="rf-select">
                  <option value="image/jpeg" selected>JPEG (lebih kecil)</option>
                  <option value="image/webp">WebP (modern, kecil)</option>
                  <option value="image/png">PNG (lossless, besar)</option>
                </select>
              </div>
            </div>

            <div class="rf-compress-preview">
              <div class="rf-compress-arrow">→</div>
              <div class="rf-compress-result">
                <div class="rf-compress-result-label">Hasil estimasi</div>
                <div class="rf-compress-result-size" id="rfResultSize">—</div>
                <div class="rf-compress-result-saved" id="rfResultSaved"></div>
              </div>
            </div>
          </div>
          <div class="rf-compress-footer">
            <button class="btn btn-ghost" data-action="cancel">Batal</button>
            <button class="btn btn-primary" data-action="apply">Terapkan</button>
          </div>
        </div>
      `;
      document.body.appendChild(modal);
      setTimeout(() => modal.classList.add('open'), 10);

      const qualityInput = modal.querySelector('#rfQuality');
      const maxDimSelect = modal.querySelector('#rfMaxDim');
      const formatSelect = modal.querySelector('#rfFormat');
      const customPanel = modal.querySelector('#rfCustomPanel');
      const resultSizeEl = modal.querySelector('#rfResultSize');
      const resultSavedEl = modal.querySelector('#rfResultSaved');

      // Recompute preview whenever preset/quality/dim/format changes
      let previewTimer = null;
      async function updatePreview() {
        const preset = COMPRESS_PRESETS.find(p => p.id === selectedPreset);
        let q, maxD, fmt;
        if (selectedPreset === 'custom') {
          q = customQuality;
          maxD = customMaxDim;
          fmt = customFormat;
        } else {
          q = preset.quality;
          maxD = preset.maxDim;
          fmt = 'image/jpeg';
        }
        // Compress to estimate
        const compressed = await compressImageDataUrl(currentDataUrl, q, maxD, fmt);
        const compressedBytes = Math.round(compressed.dataUrl.length * 0.75);
        const saved = currentBytes > 0 ? Math.round((1 - compressedBytes / currentBytes) * 100) : 0;
        resultSizeEl.textContent = formatBytes(compressedBytes);
        resultSavedEl.textContent = saved > 0 ? `Hemat ${saved}%` : 'Tidak ada penghematan';
        resultSavedEl.style.color = saved > 0 ? 'var(--success)' : 'var(--text-muted)';
      }

      function debouncedUpdate() {
        if (previewTimer) clearTimeout(previewTimer);
        previewTimer = setTimeout(updatePreview, 200);
      }

      modal.addEventListener('click', async (e) => {
        const btn = e.target.closest('button');
        if (btn) {
          const action = btn.dataset.action;
          const preset = btn.dataset.preset;
          if (action === 'cancel') {
            modal.classList.remove('open');
            setTimeout(() => { if (modal.parentNode) document.body.removeChild(modal); }, 200);
            return;
          }
          if (action === 'apply') {
            // Apply compression to bgCanvas
            const preset = COMPRESS_PRESETS.find(p => p.id === selectedPreset);
            let q, maxD, fmt;
            if (selectedPreset === 'custom') {
              q = customQuality; maxD = customMaxDim; fmt = customFormat;
            } else {
              q = preset.quality; maxD = preset.maxDim; fmt = 'image/jpeg';
            }
            // Composite draw onto bg first
            bgCtx.drawImage(drawCanvas, 0, 0);
            const compressed = await compressImageDataUrl(bgCanvas.toDataURL('image/png'), q, maxD, fmt);
            // Replace bg with compressed image, clear draw
            const newImg = new Image();
            newImg.onload = () => {
              // Recompute display scale if dimensions changed
              const newW = newImg.naturalWidth;
              const newH = newImg.naturalHeight;
              const wrap = overlay.querySelector('.rf-anno-canvas-wrap');
              const maxW = window.innerWidth - 20;
              const maxH = window.innerHeight * 0.55;
              displayScale = Math.min(maxW / newW, maxH / newH, 1);
              const dispW = newW * displayScale;
              const dispH = newH * displayScale;
              [bgCanvas, drawCanvas, previewCanvas].forEach(c => {
                c.width = newW;
                c.height = newH;
                c.style.width = dispW + 'px';
                c.style.height = dispH + 'px';
              });
              bgCtx.drawImage(newImg, 0, 0);
              imgWidth = newW;
              imgHeight = newH;
              drawCtx.clearRect(0, 0, newW, newH);
              previewCtx.clearRect(0, 0, newW, newH);
              undoStack = [];
              redoStack = [];
            };
            newImg.src = compressed.dataUrl;
            modal.classList.remove('open');
            setTimeout(() => { if (modal.parentNode) document.body.removeChild(modal); }, 200);
            return;
          }
          if (preset) {
            selectedPreset = preset;
            modal.querySelectorAll('.rf-preset-btn').forEach(b => b.classList.toggle('active', b.dataset.preset === preset));
            customPanel.style.display = preset === 'custom' ? 'block' : 'none';
            debouncedUpdate();
            return;
          }
        }
        if (e.target === modal) {
          modal.classList.remove('open');
          setTimeout(() => { if (modal.parentNode) document.body.removeChild(modal); }, 200);
        }
      });

      // Custom controls
      qualityInput.addEventListener('input', () => {
        customQuality = parseInt(qualityInput.value) / 100;
        modal.querySelector('#rfQualityVal').textContent = qualityInput.value + '%';
        debouncedUpdate();
      });
      maxDimSelect.addEventListener('change', () => {
        customMaxDim = parseInt(maxDimSelect.value);
        modal.querySelector('#rfMaxDimVal').textContent = maxDimSelect.value + 'px';
        debouncedUpdate();
      });
      formatSelect.addEventListener('change', () => {
        customFormat = formatSelect.value;
        debouncedUpdate();
      });

      // Initial preview
      updatePreview();
    }

    function cleanup() {
      document.body.removeChild(overlay);
      document.body.style.overflow = '';
    }
  });
}

// ===== v1.3.0: Helper — compress image dataUrl =====
/**
 * Compress image dataUrl by quality + max dimension.
 * @param {string} dataUrl - Source image data URL
 * @param {number} quality - 0..1 (JPEG/WebP quality)
 * @param {number} maxDim - Max width/height in pixels (preserves aspect ratio)
 * @param {string} format - 'image/jpeg' | 'image/webp' | 'image/png'
 * @returns {Promise<{dataUrl: string, width: number, height: number, bytes: number}>}
 */
export async function compressImageDataUrl(dataUrl, quality, maxDim, format = 'image/jpeg') {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const origW = img.naturalWidth;
      const origH = img.naturalHeight;
      // Compute scaled dimensions (preserve aspect ratio)
      let outW = origW;
      let outH = origH;
      if (Math.max(origW, origH) > maxDim) {
        const scale = maxDim / Math.max(origW, origH);
        outW = Math.round(origW * scale);
        outH = Math.round(origH * scale);
      }
      const canvas = document.createElement('canvas');
      canvas.width = outW;
      canvas.height = outH;
      const ctx = canvas.getContext('2d');
      // High quality downscale
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      // White background for JPEG (no transparency)
      if (format === 'image/jpeg') {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, outW, outH);
      }
      ctx.drawImage(img, 0, 0, outW, outH);
      const outDataUrl = canvas.toDataURL(format, quality);
      const bytes = Math.round(outDataUrl.length * 0.75);
      resolve({ dataUrl: outDataUrl, width: outW, height: outH, bytes });
    };
    img.onerror = () => resolve({ dataUrl, width: 0, height: 0, bytes: 0 });
    img.src = dataUrl;
  });
}

// ===== Helper: format bytes =====
function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}
