// src/document-editor-v14.js — Document editor v1.4.0
// Fase 4 (auto-detect tepi via OpenCV) + Fase 5 (batch multi-halaman)
//
// Strategi: refaktor openDocumentEditor lama → tambah state `pages` (array),
// tombol "+ Halaman" untuk add page, nav antar page, dan auto-detect per page.

import { autoDetectEdges, warpPerspective } from './edge-detect.js';
import { openCompressModal } from './compress.js';
import { pickImage } from './capture.js';

const FILTERS = [
  { id: 'enhance', icon: '✨', label: 'Enhance' },  // v1.4.2: DEFAULT — bg norm + saturation + sharpen, preserve color
  { id: 'original', icon: '🖼️', label: 'Asli' },
  { id: 'magic',   icon: '🎨', label: 'Magic' },
  { id: 'bw',      icon: '🖤', label: 'B&W' },
  { id: 'gray',    icon: '🔁', label: 'Gray' },
  { id: 'lighten', icon: '☀️', label: 'Lighten' }
];

// v1.4.2: Default filter untuk dokumen baru = 'enhance'
// User feedback: "PERBAIKI fitur mengeluarkan warna teks nya secara default
//   saat foto dokumen dari pwa, sehingga teks tu terbaca jelas dalam kondisi
//   foto apapun"
// v1.6.0: REWRITE algoritma 'enhance' — VLM-evaluated v4 hybrid
//   User feedback: "foto formulir aja yang jelas prinannya, ketika difoto
//     dokumen banyak garis atau teks yang hilang, foto biasa juga gitu"
//   VLM evaluation pada 5 sample (bersih, shadow, low contrast, blue ink,
//   dark photo) menunjukkan v1.4.2 (bg norm 250 + sat 1.25 + sharpen 1.2)
//   terlalu agresif — kalah di 4/5 sample:
//     - Gagal di shadow (target 250 statis tidak adaptif)
//     - Washed out di dark photo (over-exposed)
//     - Pudar di blue ink (CLAHE/saturation ganggu warna)
//     - Noise/halo di formulir ideal (sharpen 1.2 terlalu tinggi)
//   v4 hybrid menang di 3/5 sample (bersih, low contrast, dark photo),
//   kalah tipis di shadow & blue ink (v3 gentle menang — tapi v3 kalah di
//   low contrast & dark photo karena terlalu konservatif).
//
//   Algoritma v4 (CamScanner-inspired, lebih gentle dari v1.4.2):
//     1. Bg normalization ADAPTIF: target = min(240, max(215, bg_median * 0.96))
//        (bukan statis 250) — tidak over-force area gelap, tidak over-expose area terang
//     2. CLAHE di L channel (luminance) dengan clip limit 1.5 — adaptif per region,
//        preserve teks tipis pensil tanpa noise
//     3. Light saturation boost 1.08 (bukan 1.25) — subtle, preserve warna biru
//     4. Light sharpen 0.5 (bukan 1.2) — crisp tanpa halo
//
//   Hasil VLM eval v4 (skala 1-10):
//     - Bersih: R=9 TP=9 CP=8 N=8 (winner)
//     - Shadow: R=8 TP=7 CP=7 N=7 (2nd, v3 menang tipis)
//     - Low contrast: R=9 TP=8 CP=8 N=8 (winner — teks pensil tetap terbaca)
//     - Blue ink: R=7 TP=7 CP=8 N=6 (2nd, v3 menang tipis — biru lebih preserve)
//     - Dark photo: R=9 TP=8 CP=8 N=8 (winner — recovery dark tanpa washed out)
const DEFAULT_FILTER = 'enhance';

const MAX_PAGES = 10;

/**
 * Open multi-page document editor (CamScanner-like v1.4.0).
 * @param {string} initialDataUrl - foto pertama (dari camera/gallery)
 * @param {Object} opts - { initialTitle, initialNote }
 * @returns {Promise<{
 *   pages: Array<{dataUrl: string, filter: string, width: number, height: number}>,
 *   title: string,
 *   note: string,
 *   cancelled: boolean
 * }>}
 */
export function openDocumentEditorMultiPage(initialDataUrl, opts = {}) {
  return new Promise((resolve) => {
    // ===== State =====
    // Setiap page: { originalDataUrl, workingDataUrl, filter, corners, imgWidth, imgHeight }
    const pages = [];
    let currentPageIdx = 0;
    let displayScale = 1;
    let title = opts.initialTitle || `Dokumen ${new Date().toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' })}`;
    let note = opts.initialNote || '';

    // Helper: inisialisasi page baru dari dataUrl
    // v1.4.2: Default filter = 'enhance' (bukan 'original')
    function createPage(dataUrl) {
      return {
        originalDataUrl: dataUrl,
        workingDataUrl: dataUrl,
        filter: 'original',  // akan di-set ke DEFAULT_FILTER saat renderCurrentPage
        corners: null,
        imgWidth: 0,
        imgHeight: 0,
        autoDetected: false,
        defaultApplied: false  // flag: default filter sudah auto-apply
      };
    }

    pages.push(createPage(initialDataUrl));

    // ===== DOM =====
    const overlay = document.createElement('div');
    overlay.className = 'rf-doc-overlay rf-doc-overlay-v14';
    overlay.innerHTML = `
      <div class="rf-doc-top">
        <button class="rf-doc-btn" data-action="cancel">✕</button>
        <div class="rf-doc-title">📄 <span id="pageIndicator">Hal 1/1</span></div>
        <button class="rf-doc-btn rf-doc-primary" data-action="done">✓</button>
      </div>
      <div class="rf-doc-canvas-wrap">
        <canvas class="rf-doc-bg"></canvas>
        <canvas class="rf-doc-overlay-canvas"></canvas>
        <div class="rf-doc-loading" id="docLoading" style="display:none">⏳ Memuat OpenCV.js (8MB, first time only)...</div>
      </div>
      <div class="rf-doc-page-nav" id="pageNav">
        <button class="rf-doc-nav-btn" data-action="prev-page">◀</button>
        <div id="pageThumbs" class="rf-doc-thumbs"></div>
        <button class="rf-doc-nav-btn" data-action="next-page">▶</button>
        <button class="rf-doc-add-page" data-action="add-page">+ Hal</button>
      </div>
      <div class="rf-doc-meta">
        <input class="rf-doc-title-input" type="text" placeholder="Judul dokumen..." value="${title.replace(/"/g, '&quot;')}">
        <input class="rf-doc-note-input" type="text" placeholder="📝 Catatan (opsional)..." value="${note.replace(/"/g, '&quot;')}">
      </div>
      <div class="rf-doc-toolbar">
        <div class="rf-doc-section-label">📁 Crop & Auto-detect</div>
        <div class="rf-doc-row">
          <button class="rf-doc-tool" data-action="auto-detect"><span class="rf-doc-ic">🎯</span><span class="rf-doc-lb">Auto-detect</span></button>
          <button class="rf-doc-tool" data-action="reset-crop"><span class="rf-doc-ic">↺</span><span class="rf-doc-lb">Reset</span></button>
          <button class="rf-doc-tool" data-action="apply-crop"><span class="rf-doc-ic">✂️</span><span class="rf-doc-lb">Potong</span></button>
          <button class="rf-doc-tool" data-action="apply-warp"><span class="rf-doc-ic">📐</span><span class="rf-doc-lb">Warp</span></button>
        </div>
        <div class="rf-doc-section-label">🎨 Filter</div>
        <div class="rf-doc-filter-row">
          ${FILTERS.map(f => `<button class="rf-doc-filter ${f.id === DEFAULT_FILTER ? 'active' : ''}" data-filter="${f.id}"><span class="rf-doc-ic">${f.icon}</span><span class="rf-doc-lb">${f.label}</span></button>`).join('')}
        </div>
        <div class="rf-doc-section-label">🔄 Rotate & Kompres</div>
        <div class="rf-doc-row">
          <button class="rf-doc-tool" data-action="rotate-left"><span class="rf-doc-ic">↺</span><span class="rf-doc-lb">Kiri 90°</span></button>
          <button class="rf-doc-tool" data-action="rotate-right"><span class="rf-doc-ic">↻</span><span class="rf-doc-lb">Kanan 90°</span></button>
          <button class="rf-doc-tool" data-action="compress"><span class="rf-doc-ic">🗜️</span><span class="rf-doc-lb">Kompres</span></button>
        </div>
      </div>
      <div class="rf-doc-hint">
        💡 Tap <strong>Auto-detect</strong> untuk deteksi tepi otomatis, atau drag 4 titik sudut manual. Tap <strong>+ Hal</strong> untuk tambah halaman.
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
    const pageIndicator = overlay.querySelector('#pageIndicator');
    const pageThumbs = overlay.querySelector('#pageThumbs');
    const loadingEl = overlay.querySelector('#docLoading');

    // ===== Render current page =====
    async function renderCurrentPage() {
      const page = pages[currentPageIdx];
      if (!page) return;

      // Load image to get dimensions if not yet
      if (page.imgWidth === 0) {
        const img = await loadImage(page.workingDataUrl);
        page.imgWidth = img.naturalWidth;
        page.imgHeight = img.naturalHeight;
        // Default corners: 5% margin
        const m = 0.05;
        page.corners = [
          { x: page.imgWidth * m, y: page.imgHeight * m },
          { x: page.imgWidth * (1 - m), y: page.imgHeight * m },
          { x: page.imgWidth * (1 - m), y: page.imgHeight * (1 - m) },
          { x: page.imgWidth * m, y: page.imgHeight * (1 - m) }
        ];
      }

      // v1.4.2: Auto-apply default filter ('enhance') saat page pertama kali di-render.
      // User feedback: "teks terbaca jelas dalam kondisi foto apapun" — default
      // filter harus langsung improve readability tanpa user perlu pilih manual.
      if (!page.defaultApplied && DEFAULT_FILTER !== 'original') {
        page.defaultApplied = true;
        await applyFilter(DEFAULT_FILTER);
        return;  // applyFilter akan call renderCurrentPage lagi setelah selesai
      }

      // Scale to fit viewport
      const maxW = window.innerWidth - 16;
      const maxH = window.innerHeight * 0.4;
      displayScale = Math.min(maxW / page.imgWidth, maxH / page.imgHeight, 1);
      const dispW = page.imgWidth * displayScale;
      const dispH = page.imgHeight * displayScale;
      [bgCanvas, overlayCanvas].forEach(c => {
        c.width = page.imgWidth;
        c.height = page.imgHeight;
        c.style.width = dispW + 'px';
        c.style.height = dispH + 'px';
      });

      // Draw image
      const img = await loadImage(page.workingDataUrl);
      bgCtx.clearRect(0, 0, bgCanvas.width, bgCanvas.height);
      bgCtx.drawImage(img, 0, 0);
      drawOverlay();

      // Update filter UI
      overlay.querySelectorAll('.rf-doc-filter').forEach(b => b.classList.toggle('active', b.dataset.filter === page.filter));

      // Update page indicator
      pageIndicator.textContent = `Hal ${currentPageIdx + 1}/${pages.length}`;

      // Update thumbnails
      renderThumbs();
    }

    function renderThumbs() {
      pageThumbs.innerHTML = pages.map((p, i) => `
        <div class="rf-doc-thumb ${i === currentPageIdx ? 'active' : ''}" data-idx="${i}">
          <img src="${p.workingDataUrl}" alt="">
          <span class="rf-doc-thumb-num">${i + 1}</span>
          ${pages.length > 1 ? `<button class="rf-doc-thumb-del" data-del-idx="${i}">✕</button>` : ''}
        </div>
      `).join('');
    }

    // ===== Draw overlay (crop polygon + 4 draggable points) =====
    function drawOverlay() {
      const page = pages[currentPageIdx];
      if (!page || !page.corners) return;
      const corners = page.corners;
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
      overlayCtx.lineWidth = Math.max(2, page.imgWidth / 400);
      overlayCtx.beginPath();
      overlayCtx.moveTo(corners[0].x, corners[0].y);
      for (let i = 1; i < 4; i++) overlayCtx.lineTo(corners[i].x, corners[i].y);
      overlayCtx.closePath();
      overlayCtx.stroke();
      // 4 corner handles
      const handleR = Math.max(12, page.imgWidth / 60);
      corners.forEach((c, i) => {
        overlayCtx.fillStyle = '#6d3df5';
        overlayCtx.strokeStyle = '#fff';
        overlayCtx.lineWidth = 3;
        overlayCtx.beginPath();
        overlayCtx.arc(c.x, c.y, handleR, 0, Math.PI * 2);
        overlayCtx.fill();
        overlayCtx.stroke();
        overlayCtx.fillStyle = '#fff';
        overlayCtx.font = `${handleR}px sans-serif`;
        overlayCtx.textAlign = 'center';
        overlayCtx.textBaseline = 'middle';
        overlayCtx.fillText(['1', '2', '3', '4'][i], c.x, c.y);
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
      const page = pages[currentPageIdx];
      const handleR = Math.max(12, page.imgWidth / 60) / displayScale * 1.5;
      let nearest = -1, minDist = Infinity;
      page.corners.forEach((c, i) => {
        const d = Math.hypot(c.x - x, c.y - y);
        if (d < handleR && d < minDist) { minDist = d; nearest = i; }
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
      const page = pages[currentPageIdx];
      page.corners[draggingIdx].x = Math.max(0, Math.min(page.imgWidth, x));
      page.corners[draggingIdx].y = Math.max(0, Math.min(page.imgHeight, y));
      drawOverlay();
    }
    function onEnd() { draggingIdx = -1; }

    overlayCanvas.addEventListener('mousedown', onStart);
    overlayCanvas.addEventListener('mousemove', onMove);
    overlayCanvas.addEventListener('mouseup', onEnd);
    overlayCanvas.addEventListener('mouseleave', onEnd);
    overlayCanvas.addEventListener('touchstart', onStart, { passive: false });
    overlayCanvas.addEventListener('touchmove', onMove, { passive: false });
    overlayCanvas.addEventListener('touchend', onEnd);

    // ===== Filter implementations (port dari document.js lama) =====
    async function applyFilter(filterId) {
      const page = pages[currentPageIdx];
      const filterImg = await loadImage(page.originalDataUrl);
      const canvas = document.createElement('canvas');
      canvas.width = filterImg.naturalWidth;
      canvas.height = filterImg.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(filterImg, 0, 0);
      if (filterId === 'enhance') await applyEnhance(ctx, canvas.width, canvas.height);
      else if (filterId === 'magic') applyMagicColor(ctx, canvas.width, canvas.height);
      else if (filterId === 'bw') applyAdaptiveThreshold(ctx, canvas.width, canvas.height);
      else if (filterId === 'gray') applyGrayscale(ctx, canvas.width, canvas.height);
      else if (filterId === 'lighten') applyLighten(ctx, canvas.width, canvas.height, 1.4);
      // 'original' = no-op
      page.workingDataUrl = canvas.toDataURL('image/jpeg', 0.92);
      page.filter = filterId;
      await renderCurrentPage();
    }

    // ===== Crop (axis-aligned bounding box) =====
    async function applyCrop() {
      const page = pages[currentPageIdx];
      const xs = page.corners.map(c => c.x);
      const ys = page.corners.map(c => c.y);
      const minX = Math.max(0, Math.floor(Math.min(...xs)));
      const maxX = Math.min(page.imgWidth, Math.ceil(Math.max(...xs)));
      const minY = Math.max(0, Math.floor(Math.min(...ys)));
      const maxY = Math.min(page.imgHeight, Math.ceil(Math.max(...ys)));
      const cropW = maxX - minX, cropH = maxY - minY;
      if (cropW < 10 || cropH < 10) return;
      const cropImg = await loadImage(page.workingDataUrl);
      const canvas = document.createElement('canvas');
      canvas.width = cropW; canvas.height = cropH;
      canvas.getContext('2d').drawImage(cropImg, minX, minY, cropW, cropH, 0, 0, cropW, cropH);
      page.originalDataUrl = canvas.toDataURL('image/jpeg', 0.92);
      page.workingDataUrl = page.originalDataUrl;
      page.imgWidth = cropW;
      page.imgHeight = cropH;
      page.filter = 'original';
      const m = 0.02;
      page.corners = [
        { x: cropW * m, y: cropH * m },
        { x: cropW * (1 - m), y: cropH * m },
        { x: cropW * (1 - m), y: cropH * (1 - m) },
        { x: cropW * m, y: cropH * (1 - m) }
      ];
      await renderCurrentPage();
    }

    // ===== Warp perspective (Fase 4 — OpenCV) =====
    async function applyWarp() {
      const page = pages[currentPageIdx];
      loadingEl.style.display = 'block';
      try {
        // Compute target w/h dari corners
        const wTop = dist(page.corners[0], page.corners[1]);
        const wBot = dist(page.corners[3], page.corners[2]);
        const hLeft = dist(page.corners[0], page.corners[3]);
        const hRight = dist(page.corners[1], page.corners[2]);
        const width = Math.max(wTop, wBot);
        const height = Math.max(hLeft, hRight);
        const warped = await warpPerspective(page.workingDataUrl, page.corners, width, height);
        page.originalDataUrl = warped;
        page.workingDataUrl = warped;
        page.imgWidth = width;
        page.imgHeight = height;
        page.filter = 'original';
        const m = 0.02;
        page.corners = [
          { x: width * m, y: height * m },
          { x: width * (1 - m), y: height * m },
          { x: width * (1 - m), y: height * (1 - m) },
          { x: width * m, y: height * (1 - m) }
        ];
        await renderCurrentPage();
        showToast('✓ Perspective warp berhasil');
      } catch (e) {
        showToast('Warp gagal: ' + e.message, true);
      } finally {
        loadingEl.style.display = 'none';
      }
    }

    // ===== Auto-detect tepi (Fase 4 — OpenCV) =====
    async function applyAutoDetect() {
      const page = pages[currentPageIdx];
      loadingEl.style.display = 'block';
      loadingEl.textContent = '⏳ Memuat OpenCV.js (8MB, first time only)...';
      try {
        const result = await autoDetectEdges(page.workingDataUrl);
        if (result && result.points) {
          page.corners = result.points;
          page.autoDetected = true;
          drawOverlay();
          showToast('✓ Tepi terdeteksi — tap "Warp" untuk rapihin');
        } else {
          showToast('Auto-detect gagal — atur manual 4 titik', true);
        }
      } catch (e) {
        showToast('Auto-detect error: ' + e.message, true);
      } finally {
        loadingEl.style.display = 'none';
        loadingEl.textContent = '⏳ Memuat OpenCV.js (8MB, first time only)...';
      }
    }

    // ===== Rotate 90° =====
    async function applyRotate(direction) {
      const page = pages[currentPageIdx];
      const rotImg = await loadImage(page.workingDataUrl);
      const w = rotImg.naturalWidth, h = rotImg.naturalHeight;
      const canvas = document.createElement('canvas');
      canvas.width = h; canvas.height = w;
      const ctx = canvas.getContext('2d');
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate(direction === 'left' ? -Math.PI / 2 : Math.PI / 2);
      ctx.drawImage(rotImg, -w / 2, -h / 2);
      const rotatedDataUrl = canvas.toDataURL('image/jpeg', 0.92);

      // Also rotate original
      const rotOrigImg = await loadImage(page.originalDataUrl);
      const ow = rotOrigImg.naturalWidth, oh = rotOrigImg.naturalHeight;
      const origCanvas = document.createElement('canvas');
      origCanvas.width = oh; origCanvas.height = ow;
      const origCtx = origCanvas.getContext('2d');
      origCtx.translate(origCanvas.width / 2, origCanvas.height / 2);
      origCtx.rotate(direction === 'left' ? -Math.PI / 2 : Math.PI / 2);
      origCtx.drawImage(rotOrigImg, -ow / 2, -oh / 2);
      page.originalDataUrl = origCanvas.toDataURL('image/jpeg', 0.95);
      page.workingDataUrl = rotatedDataUrl;
      page.imgWidth = h;
      page.imgHeight = w;
      page.filter = 'original';
      const m = 0.02;
      page.corners = [
        { x: h * m, y: w * m },
        { x: h * (1 - m), y: w * m },
        { x: h * (1 - m), y: w * (1 - m) },
        { x: h * m, y: w * (1 - m) }
      ];
      await renderCurrentPage();
    }

    // ===== Reset crop =====
    function resetCrop() {
      const page = pages[currentPageIdx];
      const m = 0.05;
      page.corners = [
        { x: page.imgWidth * m, y: page.imgHeight * m },
        { x: page.imgWidth * (1 - m), y: page.imgHeight * m },
        { x: page.imgWidth * (1 - m), y: page.imgHeight * (1 - m) },
        { x: page.imgWidth * m, y: page.imgHeight * (1 - m) }
      ];
      page.autoDetected = false;
      drawOverlay();
    }

    // ===== Add page (Fase 5) =====
    async function addPage() {
      if (pages.length >= MAX_PAGES) {
        showToast(`Maksimal ${MAX_PAGES} halaman`, true);
        return;
      }
      // Pick image from camera/gallery
      const picked = await pickImage('camera');
      if (!picked) return;
      pages.push(createPage(picked.dataUrl));
      currentPageIdx = pages.length - 1;
      await renderCurrentPage();
      showToast(`✓ Halaman ${pages.length} ditambahkan`);
    }

    // ===== Delete page =====
    async function deletePage(idx) {
      if (pages.length <= 1) {
        showToast('Tidak bisa hapus halaman terakhir', true);
        return;
      }
      pages.splice(idx, 1);
      if (currentPageIdx >= pages.length) currentPageIdx = pages.length - 1;
      await renderCurrentPage();
      showToast('✓ Halaman dihapus');
    }

    // ===== Switch page =====
    async function switchPage(idx) {
      if (idx < 0 || idx >= pages.length) return;
      currentPageIdx = idx;
      await renderCurrentPage();
    }

    // ===== Button handlers =====
    overlay.addEventListener('click', async (e) => {
      const target = e.target.closest('button');
      const thumbEl = e.target.closest('.rf-doc-thumb');
      const delBtn = e.target.closest('[data-del-idx]');

      if (delBtn) {
        e.stopPropagation();
        await deletePage(parseInt(delBtn.dataset.delIdx));
        return;
      }
      if (thumbEl && !delBtn) {
        await switchPage(parseInt(thumbEl.dataset.idx));
        return;
      }
      if (!target) return;

      const action = target.dataset.action;
      const filter = target.dataset.filter;

      if (action === 'cancel') {
        cleanup();
        resolve({ cancelled: true, pages: [] });
      } else if (action === 'done') {
        // Export semua pages
        title = titleInput.value.trim();
        note = noteInput.value.trim();
        cleanup();
        resolve({
          pages: pages.map(p => ({
            dataUrl: p.workingDataUrl,
            filter: p.filter,
            width: p.imgWidth,
            height: p.imgHeight
          })),
          title,
          note,
          cancelled: false
        });
      } else if (action === 'auto-detect') {
        await applyAutoDetect();
      } else if (action === 'reset-crop') {
        resetCrop();
      } else if (action === 'apply-crop') {
        await applyCrop();
      } else if (action === 'apply-warp') {
        await applyWarp();
      } else if (action === 'rotate-left') {
        await applyRotate('left');
      } else if (action === 'rotate-right') {
        await applyRotate('right');
      } else if (action === 'compress') {
        const page = pages[currentPageIdx];
        const compressed = await openCompressModal(page.workingDataUrl);
        if (compressed) {
          page.workingDataUrl = compressed;
          await renderCurrentPage();
          showToast('✓ Kompresi diterapkan');
        }
      } else if (action === 'add-page') {
        await addPage();
      } else if (action === 'prev-page') {
        await switchPage(currentPageIdx - 1);
      } else if (action === 'next-page') {
        await switchPage(currentPageIdx + 1);
      }

      if (filter) {
        await applyFilter(filter);
      }
    });

    function cleanup() {
      document.body.removeChild(overlay);
      document.body.style.overflow = '';
    }

    function showToast(msg, isError = false) {
      const t = document.createElement('div');
      t.className = 'toast' + (isError ? ' toast-error' : '');
      t.textContent = msg;
      document.body.appendChild(t);
      setTimeout(() => t.classList.add('show'), 10);
      setTimeout(() => { t.classList.remove('show'); setTimeout(() => { if (t.parentNode) document.body.removeChild(t); }, 300); }, 2500);
    }

    function dist(a, b) {
      return Math.round(Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2));
    }

    // Initial render
    renderCurrentPage().catch(e => {
      console.error('[RecallFox] document editor init failed:', e);
      showToast('Gagal memuat editor: ' + e.message, true);
    });
  });
}

// ============================================================================
// FILTER IMPLEMENTATIONS (port dari document.js lama)
// ============================================================================

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image load failed'));
    img.src = dataUrl;
  });
}

function applyMagicColor(ctx, w, h) {
  const imageData = ctx.getImageData(0, 0, w, h);
  const data = imageData.data;
  // Estimate background via large blur (downscale + upscale)
  const small = document.createElement('canvas');
  small.width = Math.max(1, Math.floor(w / 20));
  small.height = Math.max(1, Math.floor(h / 20));
  const sctx = small.getContext('2d');
  sctx.drawImage(ctx.canvas, 0, 0, small.width, small.height);
  const bgCanvas = document.createElement('canvas');
  bgCanvas.width = w; bgCanvas.height = h;
  bgCanvas.getContext('2d').drawImage(small, 0, 0, w, h);
  const bgData = bgCanvas.getContext('2d').getImageData(0, 0, w, h).data;
  // Subtract background, amplify contrast
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const br = (r + g + b) / 3;
    const bgR = bgData[i], bgG = bgData[i + 1], bgB = bgData[i + 2];
    const bgBr = (bgR + bgG + bgB) / 3;
    // Normalize: pixel = pixel / background * 200
    const norm = bgBr > 10 ? Math.min(255, br / bgBr * 200) : br;
    const contrast = 1.4;
    const out = Math.max(0, Math.min(255, (norm - 128) * contrast + 128));
    data[i] = out;
    data[i + 1] = out;
    data[i + 2] = out;
  }
  ctx.putImageData(imageData, 0, 0);
}

function applyAdaptiveThreshold(ctx, w, h) {
  // Convert ke grayscale dulu
  applyGrayscale(ctx, w, h);
  const imageData = ctx.getImageData(0, 0, w, h);
  const data = imageData.data;
  // Adaptive threshold: pixel < local_mean - C ? black : white
  const r = 15; // window radius
  const C = 10;
  const gray = new Uint8ClampedArray(w * h);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    gray[j] = data[i];
  }
  const mean = boxBlur(gray, w, h, r);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    const v = gray[j] < mean[j] - C ? 0 : 255;
    data[i] = v; data[i + 1] = v; data[i + 2] = v;
  }
  ctx.putImageData(imageData, 0, 0);
}

function applyGrayscale(ctx, w, h) {
  const imageData = ctx.getImageData(0, 0, w, h);
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    data[i] = gray; data[i + 1] = gray; data[i + 2] = gray;
  }
  ctx.putImageData(imageData, 0, 0);
}

function applyLighten(ctx, w, h, gamma = 1.4) {
  const imageData = ctx.getImageData(0, 0, w, h);
  const data = imageData.data;
  const inv = 1 / gamma;
  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) {
    lut[i] = Math.min(255, Math.round(255 * Math.pow(i / 255, inv)));
  }
  for (let i = 0; i < data.length; i += 4) {
    data[i] = lut[data[i]];
    data[i + 1] = lut[data[i + 1]];
    data[i + 2] = lut[data[i + 2]];
  }
  ctx.putImageData(imageData, 0, 0);
}

function boxBlur(src, w, h, r) {
  const tmp = new Float32Array(w * h);
  const dst = new Float32Array(w * h);
  const norm = 2 * r + 1;
  // Horizontal pass
  for (let y = 0; y < h; y++) {
    let sum = 0;
    for (let k = -r; k <= r; k++) {
      const xk = Math.max(0, Math.min(w - 1, k));
      sum += src[y * w + xk];
    }
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = sum / norm;
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

// ============================================================================
// v1.6.0: ENHANCE FILTER v4 hybrid — VLM-evaluated optimal for scan dokumen
// Port dari Python test_filter_v4.py (verified via VLM evaluation on 5 samples)
//
// Algoritma (CamScanner-inspired, gentle, preserve warna):
//   1. Bg normalization ADAPTIF: target = min(240, max(215, bg_median * 0.96))
//      (bukan statis 250) — tidak over-force area gelap, tidak over-expose area terang
//   2. CLAHE di L channel (luminance Y) dengan clip limit 1.5 — adaptif per region,
//      preserve teks tipis pensil tanpa noise, recovery dark photo tanpa washed out
//   3. Light saturation boost 1.08 (bukan 1.25) — subtle, preserve warna biru
//   4. Light sharpen 0.5 (bukan 1.2) — crisp tanpa halo
//
// VLM eval v4 vs v1.4.2 (5 sample):
//   - v1.4.2 kalah di 4/5 sample (over-processed, gagal di shadow/dark, pudar di blue ink)
//   - v4 menang di 3/5 sample (bersih, low contrast, dark photo), kalah tipis di shadow & blue ink
// ============================================================================

async function applyEnhance(ctx, w, h) {
  const imageData = ctx.getImageData(0, 0, w, h);
  const data = imageData.data;

  // ===== Step 1: Bg normalization ADAPTIF =====
  // Estimate background via downscale + upscale (cheap blur approximation)
  const bgCanvas = document.createElement('canvas');
  const smallW = Math.max(1, Math.floor(w / 18));
  const smallH = Math.max(1, Math.floor(h / 18));
  bgCanvas.width = smallW;
  bgCanvas.height = smallH;
  const bgCtx = bgCanvas.getContext('2d');
  bgCtx.drawImage(ctx.canvas, 0, 0, smallW, smallH);
  const bgFullCanvas = document.createElement('canvas');
  bgFullCanvas.width = w;
  bgFullCanvas.height = h;
  const bgFullCtx = bgFullCanvas.getContext('2d');
  bgFullCtx.imageSmoothingEnabled = true;
  bgFullCtx.drawImage(bgCanvas, 0, 0, w, h);
  const bgData = bgFullCtx.getImageData(0, 0, w, h).data;

  // Compute median bg dari pixel yang bright (paper)
  // Kalau bg sudah bright → target 240 (slight boost). Kalau dark → target 215 (jangan paksa).
  const brightSamples = [];
  for (let i = 0; i < bgData.length; i += 4 * 50) { // sample every 50th pixel
    const lum = (bgData[i] + bgData[i + 1] + bgData[i + 2]) / 3;
    if (lum > 100) brightSamples.push(lum);
  }
  brightSamples.sort((a, b) => a - b);
  const bgMedian = brightSamples.length > 0
    ? brightSamples[Math.floor(brightSamples.length / 2)]
    : 200;
  const target = Math.min(240, Math.max(215, bgMedian * 0.96));

  // Apply bg normalization dengan target adaptif
  for (let i = 0; i < data.length; i += 4) {
    const bgR = Math.max(50, bgData[i]);
    const bgG = Math.max(50, bgData[i + 1]);
    const bgB = Math.max(50, bgData[i + 2]);
    data[i]     = Math.min(255, (data[i]     * target) / bgR);
    data[i + 1] = Math.min(255, (data[i + 1] * target) / bgG);
    data[i + 2] = Math.min(255, (data[i + 2] * target) / bgB);
  }
  ctx.putImageData(imageData, 0, 0);

  // ===== Step 2: CLAHE di L channel (luminance Y) =====
  // Approximation L = 0.299R + 0.587G + 0.114B (BT.601)
  // CLAHE = Contrast Limited Adaptive Histogram Equalization — tile-based, clip limit
  const afterBgData = ctx.getImageData(0, 0, w, h);
  const ad = afterBgData.data;
  // Compute luminance
  const lum = new Uint8ClampedArray(w * h);
  for (let i = 0, j = 0; i < ad.length; i += 4, j++) {
    lum[j] = (0.299 * ad[i] + 0.587 * ad[i + 1] + 0.114 * ad[i + 2]) | 0;
  }
  // Apply CLAHE
  const tile_size = Math.max(32, Math.floor(Math.max(w, h) / 8));
  const clip_limit = 1.5;
  const lumClahe = claheApprox(lum, w, h, tile_size, clip_limit);
  // Apply CLAHE result ke original RGB: scale each channel by ratio (newL / oldL)
  for (let i = 0, j = 0; i < ad.length; i += 4, j++) {
    const oldL = lum[j];
    const newL = lumClahe[j];
    if (oldL > 5) {
      const ratio = newL / oldL;
      ad[i]     = Math.min(255, Math.max(0, ad[i]     * ratio));
      ad[i + 1] = Math.min(255, Math.max(0, ad[i + 1] * ratio));
      ad[i + 2] = Math.min(255, Math.max(0, ad[i + 2] * ratio));
    } else {
      // Very dark pixel — set langsung ke newL (grayscale fallback)
      ad[i] = newL; ad[i + 1] = newL; ad[i + 2] = newL;
    }
  }
  ctx.putImageData(afterBgData, 0, 0);

  // ===== Step 3: Light saturation boost 1.08 =====
  // Pakai approach yang lebih efisien: avg + (channel - avg) * 1.08
  const afterClaheData = ctx.getImageData(0, 0, w, h);
  const cd = afterClaheData.data;
  for (let i = 0; i < cd.length; i += 4) {
    const r = cd[i], g = cd[i + 1], b = cd[i + 2];
    const avg = (r + g + b) / 3;
    cd[i]     = Math.max(0, Math.min(255, avg + (r - avg) * 1.08));
    cd[i + 1] = Math.max(0, Math.min(255, avg + (g - avg) * 1.08));
    cd[i + 2] = Math.max(0, Math.min(255, avg + (b - avg) * 1.08));
  }
  ctx.putImageData(afterClaheData, 0, 0);

  // ===== Step 4: Light sharpen 0.5 (unsharp mask) =====
  const blurredCanvas = document.createElement('canvas');
  blurredCanvas.width = w;
  blurredCanvas.height = h;
  const blurredCtx = blurredCanvas.getContext('2d');
  blurredCtx.filter = 'blur(0.8px)';
  blurredCtx.drawImage(ctx.canvas, 0, 0);
  const blurredImageData = blurredCtx.getImageData(0, 0, w, h);
  const blurredData = blurredImageData.data;
  const sharpData = ctx.getImageData(0, 0, w, h);
  const sd = sharpData.data;
  for (let i = 0; i < sd.length; i += 4) {
    sd[i]     = Math.max(0, Math.min(255, sd[i]     + (sd[i]     - blurredData[i])     * 0.5));
    sd[i + 1] = Math.max(0, Math.min(255, sd[i + 1] + (sd[i + 1] - blurredData[i + 1]) * 0.5));
    sd[i + 2] = Math.max(0, Math.min(255, sd[i + 2] + (sd[i + 2] - blurredData[i + 2]) * 0.5));
  }
  ctx.putImageData(sharpData, 0, 0);
}

// ============================================================================
// CLAHE Approximation (Contrast Limited Adaptive Histogram Equalization)
// Tile-based histogram equalization dengan clip limit + bilinear interpolation.
// Port dari Python clahe_approx di test_filter_v4.py.
//
// @param {Uint8ClampedArray} src - L channel (luminance) 0-255
// @param {number} w, h - image dimensions
// @param {number} tileSize - tile size in pixels (e.g. 64-128)
// @param {number} clipLimit - clip limit (e.g. 1.5 = gentle, 2.0 = aggressive)
// @returns {Uint8ClampedArray} equalized L channel
// ============================================================================
function claheApprox(src, w, h, tileSize, clipLimit) {
  // Pad to multiple of tileSize (reflect mode)
  const padH = (tileSize - h % tileSize) % tileSize;
  const padW = (tileSize - w % tileSize) % tileSize;
  const padded = new Uint8ClampedArray((h + padH) * (w + padW));
  for (let y = 0; y < h + padH; y++) {
    for (let x = 0; x < w + padW; x++) {
      const sy = Math.min(h - 1, y < h ? y : (2 * h - y - 1));
      const sx = Math.min(w - 1, x < w ? x : (2 * w - x - 1));
      padded[y * (w + padW) + x] = src[sy * w + sx];
    }
  }
  const ph = h + padH;
  const pw = w + padW;
  const nTilesH = Math.floor(ph / tileSize);
  const nTilesW = Math.floor(pw / tileSize);

  // Compute equalization LUT per tile
  const luts = new Float32Array(nTilesH * nTilesW * 256);
  for (let ty = 0; ty < nTilesH; ty++) {
    for (let tx = 0; tx < nTilesW; tx++) {
      const hist = new Float32Array(256);
      for (let dy = 0; dy < tileSize; dy++) {
        for (let dx = 0; dx < tileSize; dx++) {
          const v = padded[(ty * tileSize + dy) * pw + (tx * tileSize + dx)];
          hist[v]++;
        }
      }
      // Clip histogram at clipLimit * mean
      const clipValue = clipLimit * (tileSize * tileSize) / 256;
      let excess = 0;
      for (let i = 0; i < 256; i++) {
        if (hist[i] > clipValue) {
          excess += hist[i] - clipValue;
          hist[i] = clipValue;
        }
      }
      // Redistribute excess uniformly
      const redist = excess / 256;
      for (let i = 0; i < 256; i++) hist[i] += redist;
      // CDF
      let cdf = 0;
      const lutBase = (ty * nTilesW + tx) * 256;
      for (let i = 0; i < 256; i++) {
        cdf += hist[i];
        luts[lutBase + i] = (cdf / (tileSize * tileSize)) * 255;
      }
    }
  }

  // Bilinear interpolation between tile LUTs
  const result = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ty = y / tileSize - 0.5;
      const tx = x / tileSize - 0.5;
      let ty0 = Math.floor(ty);
      let tx0 = Math.floor(tx);
      let ty1 = ty0 + 1;
      let tx1 = tx0 + 1;
      ty0 = Math.max(0, Math.min(nTilesH - 1, ty0));
      tx0 = Math.max(0, Math.min(nTilesW - 1, tx0));
      ty1 = Math.min(nTilesH - 1, ty1);
      tx1 = Math.min(nTilesW - 1, tx1);
      let fy = ty - ty0;
      let fx = tx - tx0;
      fy = Math.max(0, Math.min(1, fy));
      fx = Math.max(0, Math.min(1, fx));
      const v = src[y * w + x];
      const v00 = luts[(ty0 * nTilesW + tx0) * 256 + v];
      const v10 = luts[(ty1 * nTilesW + tx0) * 256 + v];
      const v01 = luts[(ty0 * nTilesW + tx1) * 256 + v];
      const v11 = luts[(ty1 * nTilesW + tx1) * 256 + v];
      const v0 = v00 * (1 - fy) + v10 * fy;
      const v1 = v01 * (1 - fy) + v11 * fy;
      result[y * w + x] = v0 * (1 - fx) + v1 * fx;
    }
  }
  return result;
}
