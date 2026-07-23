// src/document.js — Document editor (CamScanner-like, MVP v1.3.0)
// Phase 2: Manual 4-point crop + save as type='document'
// Phase 3: Filter Magic Color / B&W / Grayscale / Rotate via Canvas API (no OpenCV)
//
// Limitations MVP:
//   - No auto-detect tepi (Phase 4 — OpenCV lazy load)
//   - No perspective warp — crop pakai axis-aligned bounding box dari 4 titik
//     (Perspective warp akan menyusul di Phase 4 bareng OpenCV)
//   - Single page only (Phase 5 — batch multi-halaman)
//
// Filters:
//   - magic: CLAHE-like (kontras adaptif) + bg subtraction sederhana
//   - bw:    Adaptive threshold (Gaussian) — tulisan hitam di atas putih
//   - gray:  Desaturate
//   - lighten: Gamma correction
//   - rotate: 90° kiri/kanan

const FILTERS = [
  { id: 'original', icon: '🖼️', label: 'Asli' },
  { id: 'magic',   icon: '✨', label: 'Magic' },
  { id: 'bw',      icon: '🖤', label: 'B&W' },
  { id: 'gray',    icon: '🔁', label: 'Gray' },
  { id: 'lighten', icon: '☀️', label: 'Lighten' }
];

/**
 * Open document editor (CamScanner-like).
 * @param {string} dataUrl - original photo data URL
 * @param {Object} opts - { initialTitle, initialNote }
 * @returns {Promise<{dataUrl: string, filter: string, title: string, note: string, cancelled: boolean}>}
 */
export function openDocumentEditor(dataUrl, opts = {}) {
  return new Promise((resolve) => {
    // ===== State =====
    let originalDataUrl = dataUrl;       // foto asli (tidak berubah)
    let workingDataUrl = dataUrl;        // foto setelah filter (sebelum crop)
    let currentFilter = 'original';
    let imgWidth = 0, imgHeight = 0;
    let displayScale = 1;
    let title = opts.initialTitle || `Dokumen ${new Date().toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' })}`;
    let note = opts.initialNote || '';

    // 4 titik sudut (TL, TR, BR, BL) — koordinat image (bukan display)
    // Default: full image dengan margin 5%
    let corners = [];

    // ===== DOM =====
    const overlay = document.createElement('div');
    overlay.className = 'rf-doc-overlay';
    overlay.innerHTML = `
      <div class="rf-doc-top">
        <button class="rf-doc-btn" data-action="cancel">✕</button>
        <div class="rf-doc-title">📄 Edit Dokumen</div>
        <button class="rf-doc-btn rf-doc-primary" data-action="done">✓</button>
      </div>
      <div class="rf-doc-canvas-wrap">
        <canvas class="rf-doc-bg"></canvas>
        <canvas class="rf-doc-overlay-canvas"></canvas>
      </div>
      <div class="rf-doc-meta">
        <input class="rf-doc-title-input" type="text" placeholder="Judul dokumen..." value="${title.replace(/"/g, '&quot;')}">
        <input class="rf-doc-note-input" type="text" placeholder="📝 Catatan (opsional)..." value="${note.replace(/"/g, '&quot;')}">
      </div>
      <div class="rf-doc-toolbar">
        <div class="rf-doc-section-label">📁 Crop</div>
        <div class="rf-doc-row">
          <button class="rf-doc-tool" data-action="reset-crop"><span class="rf-doc-ic">↻</span><span class="rf-doc-lb">Reset</span></button>
          <button class="rf-doc-tool" data-action="auto-margin"><span class="rf-doc-ic">🔍</span><span class="rf-doc-lb">Auto Margin</span></button>
          <button class="rf-doc-tool" data-action="apply-crop"><span class="rf-doc-ic">✂️</span><span class="rf-doc-lb">Potong</span></button>
        </div>
        <div class="rf-doc-section-label">🎨 Filter</div>
        <div class="rf-doc-filter-row">
          ${FILTERS.map(f => `<button class="rf-doc-filter ${f.id === currentFilter ? 'active' : ''}" data-filter="${f.id}"><span class="rf-doc-ic">${f.icon}</span><span class="rf-doc-lb">${f.label}</span></button>`).join('')}
        </div>
        <div class="rf-doc-section-label">🔄 Rotate</div>
        <div class="rf-doc-row">
          <button class="rf-doc-tool" data-action="rotate-left"><span class="rf-doc-ic">↺</span><span class="rf-doc-lb">Kiri 90°</span></button>
          <button class="rf-doc-tool" data-action="rotate-right"><span class="rf-doc-ic">↻</span><span class="rf-doc-lb">Kanan 90°</span></button>
        </div>
      </div>
      <div class="rf-doc-hint">
        💡 Drag 4 titik sudut untuk menandai tepi kertas, lalu tap <strong>Potong</strong>
      </div>
    `;
    document.body.appendChild(overlay);
    document.body.style.overflow = 'hidden';

    const bgCanvas = overlay.querySelector('.rf-doc-bg');
    const overlayCanvas = overlay.querySelector('.rf-doc-overlay-canvas');
    const bgCtx = bgCanvas.getContext('2d');
    const overlayCtx = overlayCanvas.getContext('2d');
    const titleInput = overlay.querySelector('.rf-doc-title-input');
    const noteInput = overlay.querySelector('.rf-doc-note-input');

    // ===== Load image & init =====
    const img = new Image();
    img.onload = () => {
      imgWidth = img.naturalWidth;
      imgHeight = img.naturalHeight;
      // Scale to fit viewport
      const maxW = window.innerWidth - 16;
      const maxH = window.innerHeight * 0.45;
      displayScale = Math.min(maxW / imgWidth, maxH / imgHeight, 1);
      const dispW = imgWidth * displayScale;
      const dispH = imgHeight * displayScale;
      [bgCanvas, overlayCanvas].forEach(c => {
        c.width = imgWidth;
        c.height = imgHeight;
        c.style.width = dispW + 'px';
        c.style.height = dispH + 'px';
      });
      bgCtx.drawImage(img, 0, 0);
      // Default corners: 5% margin dari tepi
      const m = 0.05;
      corners = [
        { x: imgWidth * m,         y: imgHeight * m         },  // TL
        { x: imgWidth * (1 - m),   y: imgHeight * m         },  // TR
        { x: imgWidth * (1 - m),   y: imgHeight * (1 - m)   },  // BR
        { x: imgWidth * m,         y: imgHeight * (1 - m)   }   // BL
      ];
      drawOverlay();
    };
    img.src = dataUrl;

    // ===== Draw overlay (crop polygon + 4 draggable points) =====
    function drawOverlay() {
      overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
      // Dim area outside polygon
      overlayCtx.fillStyle = 'rgba(0,0,0,0.45)';
      overlayCtx.fillRect(0, 0, overlayCanvas.width, overlayCanvas.height);
      // Clear polygon area (cut hole)
      overlayCtx.globalCompositeOperation = 'destination-out';
      overlayCtx.beginPath();
      overlayCtx.moveTo(corners[0].x, corners[0].y);
      for (let i = 1; i < 4; i++) overlayCtx.lineTo(corners[i].x, corners[i].y);
      overlayCtx.closePath();
      overlayCtx.fill();
      overlayCtx.globalCompositeOperation = 'source-over';
      // Polygon outline
      overlayCtx.strokeStyle = '#6d3df5';
      overlayCtx.lineWidth = Math.max(2, imgWidth / 400);
      overlayCtx.beginPath();
      overlayCtx.moveTo(corners[0].x, corners[0].y);
      for (let i = 1; i < 4; i++) overlayCtx.lineTo(corners[i].x, corners[i].y);
      overlayCtx.closePath();
      overlayCtx.stroke();
      // 4 corner handles
      const handleR = Math.max(12, imgWidth / 60);
      corners.forEach((c, i) => {
        overlayCtx.fillStyle = '#6d3df5';
        overlayCtx.strokeStyle = '#fff';
        overlayCtx.lineWidth = 3;
        overlayCtx.beginPath();
        overlayCtx.arc(c.x, c.y, handleR, 0, Math.PI * 2);
        overlayCtx.fill();
        overlayCtx.stroke();
        // Label
        overlayCtx.fillStyle = '#fff';
        overlayCtx.font = `${handleR}px sans-serif`;
        overlayCtx.textAlign = 'center';
        overlayCtx.textBaseline = 'middle';
        const labels = ['1', '2', '3', '4'];
        overlayCtx.fillText(labels[i], c.x, c.y);
      });
    }

    // ===== Drag handlers for corner points =====
    let draggingIdx = -1;
    function getCoords(e) {
      const rect = overlayCanvas.getBoundingClientRect();
      const clientX = e.touches?.[0]?.clientX ?? e.clientX;
      const clientY = e.touches?.[0]?.clientY ?? e.clientY;
      return {
        x: (clientX - rect.left) / displayScale,
        y: (clientY - rect.top) / displayScale
      };
    }

    function findNearestCorner(x, y) {
      const handleR = Math.max(12, imgWidth / 60) / displayScale * 1.5; // bigger touch target
      let nearest = -1;
      let minDist = Infinity;
      corners.forEach((c, i) => {
        const d = Math.hypot(c.x - x, c.y - y);
        if (d < handleR && d < minDist) {
          minDist = d;
          nearest = i;
        }
      });
      return nearest;
    }

    function onStart(e) {
      e.preventDefault();
      const { x, y } = getCoords(e);
      draggingIdx = findNearestCorner(x, y);
    }
    function onMove(e) {
      if (draggingIdx < 0) return;
      e.preventDefault();
      const { x, y } = getCoords(e);
      // Clamp to image bounds
      corners[draggingIdx].x = Math.max(0, Math.min(imgWidth, x));
      corners[draggingIdx].y = Math.max(0, Math.min(imgHeight, y));
      drawOverlay();
    }
    function onEnd() {
      draggingIdx = -1;
    }

    overlayCanvas.addEventListener('mousedown', onStart);
    overlayCanvas.addEventListener('mousemove', onMove);
    overlayCanvas.addEventListener('mouseup', onEnd);
    overlayCanvas.addEventListener('mouseleave', onEnd);
    overlayCanvas.addEventListener('touchstart', onStart, { passive: false });
    overlayCanvas.addEventListener('touchmove', onMove, { passive: false });
    overlayCanvas.addEventListener('touchend', onEnd);

    // ===== Apply filter to working image =====
    async function applyFilter(filterId) {
      const filterImg = new Image();
      await new Promise((r) => {
        filterImg.onload = r;
        filterImg.src = originalDataUrl;
      });
      const canvas = document.createElement('canvas');
      canvas.width = filterImg.naturalWidth;
      canvas.height = filterImg.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(filterImg, 0, 0);
      if (filterId === 'original') {
        // no-op
      } else if (filterId === 'magic') {
        applyMagicColor(ctx, canvas.width, canvas.height);
      } else if (filterId === 'bw') {
        applyAdaptiveThreshold(ctx, canvas.width, canvas.height);
      } else if (filterId === 'gray') {
        applyGrayscale(ctx, canvas.width, canvas.height);
      } else if (filterId === 'lighten') {
        applyLighten(ctx, canvas.width, canvas.height, 1.4);
      }
      workingDataUrl = canvas.toDataURL('image/jpeg', 0.92);
      currentFilter = filterId;
      // Reload bg canvas with filtered image
      const newImg = new Image();
      await new Promise((r) => {
        newImg.onload = r;
        newImg.src = workingDataUrl;
      });
      // Preserve corner positions (they're in image coords of original)
      bgCtx.clearRect(0, 0, bgCanvas.width, bgCanvas.height);
      bgCtx.drawImage(newImg, 0, 0);
      drawOverlay();
    }

    // ===== Crop =====
    async function applyCrop() {
      // Compute axis-aligned bounding box of 4 corners
      const xs = corners.map(c => c.x);
      const ys = corners.map(c => c.y);
      const minX = Math.max(0, Math.floor(Math.min(...xs)));
      const maxX = Math.min(imgWidth, Math.ceil(Math.max(...xs)));
      const minY = Math.max(0, Math.floor(Math.min(...ys)));
      const maxY = Math.min(imgHeight, Math.ceil(Math.max(...ys)));
      const cropW = maxX - minX;
      const cropH = maxY - minY;
      if (cropW < 10 || cropH < 10) return; // too small, ignore

      // Crop workingDataUrl
      const cropImg = new Image();
      await new Promise((r) => {
        cropImg.onload = r;
        cropImg.src = workingDataUrl;
      });
      const canvas = document.createElement('canvas');
      canvas.width = cropW;
      canvas.height = cropH;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(cropImg, minX, minY, cropW, cropH, 0, 0, cropW, cropH);
      const croppedDataUrl = canvas.toDataURL('image/jpeg', 0.92);

      // Update state
      originalDataUrl = croppedDataUrl;
      workingDataUrl = croppedDataUrl;
      imgWidth = cropW;
      imgHeight = cropH;
      currentFilter = 'original';

      // Re-render bg canvas with new size
      const maxW = window.innerWidth - 16;
      const maxH = window.innerHeight * 0.45;
      displayScale = Math.min(maxW / imgWidth, maxH / imgHeight, 1);
      const dispW = imgWidth * displayScale;
      const dispH = imgHeight * displayScale;
      [bgCanvas, overlayCanvas].forEach(c => {
        c.width = imgWidth;
        c.height = imgHeight;
        c.style.width = dispW + 'px';
        c.style.height = dispH + 'px';
      });
      const newImg = new Image();
      await new Promise((r) => {
        newImg.onload = r;
        newImg.src = croppedDataUrl;
      });
      bgCtx.drawImage(newImg, 0, 0);

      // Reset corners to full new image
      const m = 0.02;
      corners = [
        { x: imgWidth * m,         y: imgHeight * m         },
        { x: imgWidth * (1 - m),   y: imgHeight * m         },
        { x: imgWidth * (1 - m),   y: imgHeight * (1 - m)   },
        { x: imgWidth * m,         y: imgHeight * (1 - m)   }
      ];
      // Reset filter UI
      overlay.querySelectorAll('.rf-doc-filter').forEach(b => b.classList.toggle('active', b.dataset.filter === 'original'));
      drawOverlay();
    }

    // ===== Rotate 90° =====
    async function applyRotate(direction) {
      // direction: 'left' (-90°) or 'right' (+90°)
      const rotImg = new Image();
      await new Promise((r) => {
        rotImg.onload = r;
        rotImg.src = workingDataUrl;
      });
      const w = rotImg.naturalWidth;
      const h = rotImg.naturalHeight;
      const canvas = document.createElement('canvas');
      // After 90° rotation: width ↔ height
      canvas.width = h;
      canvas.height = w;
      const ctx = canvas.getContext('2d');
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate(direction === 'left' ? -Math.PI / 2 : Math.PI / 2);
      ctx.drawImage(rotImg, -w / 2, -h / 2);
      const rotatedDataUrl = canvas.toDataURL('image/jpeg', 0.92);

      // Also rotate original so filters work correctly
      const rotOrigImg = new Image();
      await new Promise((r) => {
        rotOrigImg.onload = r;
        rotOrigImg.src = originalDataUrl;
      });
      const ow = rotOrigImg.naturalWidth;
      const oh = rotOrigImg.naturalHeight;
      const origCanvas = document.createElement('canvas');
      origCanvas.width = oh;
      origCanvas.height = ow;
      const origCtx = origCanvas.getContext('2d');
      origCtx.translate(origCanvas.width / 2, origCanvas.height / 2);
      origCtx.rotate(direction === 'left' ? -Math.PI / 2 : Math.PI / 2);
      origCtx.drawImage(rotOrigImg, -ow / 2, -oh / 2);
      originalDataUrl = origCanvas.toDataURL('image/jpeg', 0.95);
      workingDataUrl = rotatedDataUrl;
      imgWidth = h;
      imgHeight = w;
      currentFilter = 'original';

      // Re-render
      const maxW = window.innerWidth - 16;
      const maxH = window.innerHeight * 0.45;
      displayScale = Math.min(maxW / imgWidth, maxH / imgHeight, 1);
      const dispW = imgWidth * displayScale;
      const dispH = imgHeight * displayScale;
      [bgCanvas, overlayCanvas].forEach(c => {
        c.width = imgWidth;
        c.height = imgHeight;
        c.style.width = dispW + 'px';
        c.style.height = dispH + 'px';
      });
      const newImg = new Image();
      await new Promise((r) => {
        newImg.onload = r;
        newImg.src = rotatedDataUrl;
      });
      bgCtx.drawImage(newImg, 0, 0);
      const m = 0.02;
      corners = [
        { x: imgWidth * m,         y: imgHeight * m         },
        { x: imgWidth * (1 - m),   y: imgHeight * m         },
        { x: imgWidth * (1 - m),   y: imgHeight * (1 - m)   },
        { x: imgWidth * m,         y: imgHeight * (1 - m)   }
      ];
      overlay.querySelectorAll('.rf-doc-filter').forEach(b => b.classList.toggle('active', b.dataset.filter === 'original'));
      drawOverlay();
    }

    // ===== Reset crop to default =====
    function resetCrop() {
      const m = 0.05;
      corners = [
        { x: imgWidth * m,         y: imgHeight * m         },
        { x: imgWidth * (1 - m),   y: imgHeight * m         },
        { x: imgWidth * (1 - m),   y: imgHeight * (1 - m)   },
        { x: imgWidth * m,         y: imgHeight * (1 - m)   }
      ];
      drawOverlay();
    }

    // ===== Auto-margin: shrink corners 2% inward from current =====
    function autoMargin() {
      const xs = corners.map(c => c.x);
      const ys = corners.map(c => c.y);
      const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
      const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
      const shrink = 0.02;
      corners = corners.map(c => ({
        x: c.x + (cx - c.x) * shrink,
        y: c.y + (cy - c.y) * shrink
      }));
      drawOverlay();
    }

    // ===== Button handlers =====
    overlay.addEventListener('click', async (e) => {
      const target = e.target.closest('button');
      if (!target) return;
      const action = target.dataset.action;
      const filter = target.dataset.filter;

      if (action === 'cancel') {
        cleanup();
        resolve({ cancelled: true });
      } else if (action === 'done') {
        // Export working image (current filter applied) — corners not auto-cropped, user must tap "Potong"
        // If user didn't tap "Potong", we'll auto-crop here using current corners
        // Actually let's auto-crop on done for convenience
        const xs = corners.map(c => c.x);
        const ys = corners.map(c => c.y);
        const minX = Math.max(0, Math.floor(Math.min(...xs)));
        const maxX = Math.min(imgWidth, Math.ceil(Math.max(...xs)));
        const minY = Math.max(0, Math.floor(Math.min(...ys)));
        const maxY = Math.min(imgHeight, Math.ceil(Math.max(...ys)));
        const cropW = maxX - minX;
        const cropH = maxY - minY;

        let finalDataUrl = workingDataUrl;
        // Only crop if corners are meaningfully smaller than full image
        const isFullImage = (minX < 5 && minY < 5 &&
                            maxX > imgWidth - 5 && maxY > imgHeight - 5);
        if (!isFullImage && cropW > 10 && cropH > 10) {
          const cropImg = new Image();
          await new Promise((r) => {
            cropImg.onload = r;
            cropImg.src = workingDataUrl;
          });
          const canvas = document.createElement('canvas');
          canvas.width = cropW;
          canvas.height = cropH;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(cropImg, minX, minY, cropW, cropH, 0, 0, cropW, cropH);
          finalDataUrl = canvas.toDataURL('image/jpeg', 0.92);
        }
        title = titleInput.value.trim();
        note = noteInput.value.trim();
        cleanup();
        resolve({
          dataUrl: finalDataUrl,
          filter: currentFilter,
          title,
          note,
          cancelled: false
        });
      } else if (action === 'reset-crop') {
        resetCrop();
      } else if (action === 'auto-margin') {
        autoMargin();
      } else if (action === 'apply-crop') {
        await applyCrop();
      } else if (action === 'rotate-left') {
        await applyRotate('left');
      } else if (action === 'rotate-right') {
        await applyRotate('right');
      }

      if (filter) {
        overlay.querySelectorAll('.rf-doc-filter').forEach(b => b.classList.toggle('active', b.dataset.filter === filter));
        await applyFilter(filter);
      }
    });

    function cleanup() {
      document.body.removeChild(overlay);
      document.body.style.overflow = '';
    }
  });
}

// ============================================================================
// FILTER IMPLEMENTATIONS (Phase 3 — Canvas API, no OpenCV)
// ============================================================================

/**
 * Magic Color — CLAHE-like contrast enhancement + background normalization.
 * Approach:
 *   1. Estimate background via large kernel median/mean (cheap: downscale+upscale blur)
 *   2. Subtract background → flatten illumination
 *   3. Stretch contrast (per-channel histogram stretch)
 *   4. Boost saturation for vibrancy
 */
function applyMagicColor(ctx, w, h) {
  const src = ctx.getImageData(0, 0, w, h);
  const data = src.data;

  // Step 1: Estimate background via downscale (32x32) then upscale
  const small = document.createElement('canvas');
  const sw = 32, sh = 32;
  small.width = sw;
  small.height = sh;
  const smallCtx = small.getContext('2d');
  smallCtx.drawImage(ctx.canvas, 0, 0, sw, sh);
  const bgSmall = smallCtx.getImageData(0, 0, sw, sh).data;
  // Upscale background to full size
  const bgCanvas = document.createElement('canvas');
  bgCanvas.width = w;
  bgCanvas.height = h;
  const bgCtx2 = bgCanvas.getContext('2d');
  bgCtx2.imageSmoothingEnabled = true;
  bgCtx2.imageSmoothingQuality = 'high';
  bgCtx2.drawImage(small, 0, 0, sw, sh, 0, 0, w, h);
  const bgFull = bgCtx2.getImageData(0, 0, w, h).data;

  // Step 2: Subtract background (flatten illumination)
  // For each pixel: out = in * (255 / bg) — division-based flattening
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const br = bgFull[i] || 1;
    const bgG = bgFull[i + 1] || 1;
    const bgB = bgFull[i + 2] || 1;
    data[i]     = Math.min(255, (r * 255 / Math.max(br, 1)));
    data[i + 1] = Math.min(255, (g * 255 / Math.max(bgG, 1)));
    data[i + 2] = Math.min(255, (b * 255 / Math.max(bgB, 1)));
  }

  // Step 3: Per-channel histogram stretch (percentile 2% → 98%)
  const n = w * h;
  const rArr = new Uint8Array(n);
  const gArr = new Uint8Array(n);
  const bArr = new Uint8Array(n);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    rArr[j] = data[i];
    gArr[j] = data[i + 1];
    bArr[j] = data[i + 2];
  }
  const stretch = (arr) => {
    const sorted = new Uint8Array(arr).sort();
    const lo = sorted[Math.floor(n * 0.02)];
    const hi = sorted[Math.floor(n * 0.98)];
    return { lo, hi };
  };
  const rs = stretch(rArr);
  const gs = stretch(gArr);
  const bs = stretch(bArr);
  const applyStretch = (v, lo, hi) => {
    if (hi <= lo) return v;
    return Math.max(0, Math.min(255, ((v - lo) * 255) / (hi - lo)));
  };
  for (let i = 0; i < data.length; i += 4) {
    data[i]     = applyStretch(data[i],     rs.lo, rs.hi);
    data[i + 1] = applyStretch(data[i + 1], gs.lo, gs.hi);
    data[i + 2] = applyStretch(data[i + 2], bs.lo, bs.hi);
  }

  // Step 4: Boost saturation (1.3x)
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const avg = (r + g + b) / 3;
    data[i]     = Math.max(0, Math.min(255, avg + (r - avg) * 1.3));
    data[i + 1] = Math.max(0, Math.min(255, avg + (g - avg) * 1.3));
    data[i + 2] = Math.max(0, Math.min(255, avg + (b - avg) * 1.3));
  }

  ctx.putImageData(src, 0, 0);
}

/**
 * B&W Document — adaptive threshold using local mean (Gaussian-ish via box blur).
 * Result: black text on white background.
 */
function applyAdaptiveThreshold(ctx, w, h) {
  // First convert to grayscale
  const src = ctx.getImageData(0, 0, w, h);
  const data = src.data;
  const gray = new Uint8ClampedArray(w * h);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    gray[j] = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0;
  }

  // Box blur (3 passes ~ Gaussian) — radius ~ w/40 but capped
  const radius = Math.max(5, Math.min(40, Math.floor(w / 40)));
  const blurred = boxBlur(gray, w, h, radius);

  // Adaptive threshold: pixel is black if gray < blurred * 0.9 (slightly below local mean)
  // Bias constant 10 supaya noise tidak terlalu agresif
  for (let j = 0; j < w * h; j++) {
    const thr = blurred[j] * 0.9 - 10;
    const v = gray[j] < thr ? 0 : 255;
    const idx = j * 4;
    data[idx] = v;
    data[idx + 1] = v;
    data[idx + 2] = v;
    // alpha tetap 255
  }
  ctx.putImageData(src, 0, 0);
}

/**
 * Grayscale — desaturate via luminosity method.
 */
function applyGrayscale(ctx, w, h) {
  const src = ctx.getImageData(0, 0, w, h);
  const data = src.data;
  for (let i = 0; i < data.length; i += 4) {
    const v = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0;
    data[i] = v;
    data[i + 1] = v;
    data[i + 2] = v;
  }
  ctx.putImageData(src, 0, 0);
}

/**
 * Lighten — gamma correction (gamma < 1 = brighter).
 */
function applyLighten(ctx, w, h, gamma = 1.4) {
  const src = ctx.getImageData(0, 0, w, h);
  const data = src.data;
  // Precompute LUT
  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) {
    lut[i] = Math.min(255, Math.round(255 * Math.pow(i / 255, 1 / gamma)));
  }
  for (let i = 0; i < data.length; i += 4) {
    data[i]     = lut[data[i]];
    data[i + 1] = lut[data[i + 1]];
    data[i + 2] = lut[data[i + 2]];
  }
  ctx.putImageData(src, 0, 0);
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Box blur (separable) — O(n) per channel.
 * @param {Uint8ClampedArray} src
 * @param {number} w
 * @param {number} h
 * @param {number} r - radius
 * @returns {Uint8ClampedArray}
 */
function boxBlur(src, w, h, r) {
  const tmp = new Uint8ClampedArray(w * h);
  const dst = new Uint8ClampedArray(w * h);
  const norm = 2 * r + 1;
  // Horizontal pass
  for (let y = 0; y < h; y++) {
    let sum = 0;
    // Initial window
    for (let k = -r; k <= r; k++) {
      const xk = Math.max(0, Math.min(w - 1, k));
      sum += src[y * w + xk];
    }
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = sum / norm;
      // Slide window
      const xOut = Math.max(0, Math.min(w - 1, x - r));
      const xIn = Math.max(0, Math.min(w - 1, x + r + 1));
      sum += src[y * w + xIn] - src[y * w + xOut];
    }
  }
  // Vertical pass
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let k = -r; k <= r; k++) {
      const yk = Math.max(0, Math.min(h - 1, k));
      sum += tmp[yk * w + x];
    }
    for (let y = 0; y < h; y++) {
      dst[y * w + x] = sum / norm;
      const yOut = Math.max(0, Math.min(h - 1, y - r));
      const yIn = Math.max(0, Math.min(h - 1, y + r + 1));
      sum += tmp[yIn * w + x] - tmp[yOut * w + x];
    }
  }
  return dst;
}
