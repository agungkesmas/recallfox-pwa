// src/camscanner.js — Kamera live full-screen ala CamScanner (v1.25.1)
//
// PERILAKU YANG DITIRU DARI CAMSCANNER (dipelajari: UI, perilaku, hasil):
//   1. VIEWFINDER LIVE: kamera full-screen, polygon tepi kertas terdeteksi
//      REALTIME (garis hijau menyala di atas preview) — bukan foto buta.
//   2. AUTO-CAPTURE: saat tepi terdeteksi & stabil ±1,2 detik → jepret sendiri
//      (flash + getar), bisa dimatikan (tombol AUTO/MANUAL, tersimpan).
//   3. CROP 4 SUDUT: layar sesuaikan dgn titik sudut besar draggable + LOUPE
//      (kaca pembesar) saat digeser + koreksi perspektif otomatis saat lanjut.
//   4. FILTER: Enhance (default — teks tajam, kertas putih, warna asli),
//      Magic, Asli, Gray, B&W + slider Kecerahan/Kontras. Preview instan.
//   5. MULTI-HALAMAN: selesai satu halaman → balik ke viewfinder, halaman
//      bertambah; "Selesai" → judul+catatan → simpan (N halaman).
//   6. MODE PANORAMA v1.25.1: SWEEP KONTINYU ala kamera native — tekan jepret
//      SEKALI, kamera merekam otomatis tiap 450ms sambil HP digeser KANAN,
//      tiap frame disambung live (ZSAD tahan perubahan exposure); tekan lagi
//      = selesai. Tidak perlu jepret-jepret manual lagi (gagal total di v1.25.0).
//   7. Torch (lampu), ganti kamera depan/belakang, impor dari galeri.
//   8. Output JPEG q0.92 RESOLUSI PENUH — hanya 1x re-encode di akhir, teks
//      TIDAK hilang (filter baru: B&W window adaptif proporsional, Enhance
//      bg-division adaptif + gamma auto).
//
// Fallback: getUserMedia gagal (izin/no kamera/konteks tidak aman) → resolve
// {cancelled:true, fallback:true} → caller (media.js) lanjut alur lama.

import {
  detectQuad, defaultQuad, warpQuad, applyFilterImg, applyAdjust,
  FILTERS, resizeImg, makeGray, matchPanorama
} from './cam-ops.js';
import { pickImage } from './capture.js';

const MAX_PAGES = 10;
const WARP_CAP = 3200;       // sisi panjang maks output dokumen
const PANO_H = 1080;         // tinggi kerja panorama
const PANO_MAX_W = 10000;    // batas lebar panorama (jaga memori)
const PANO_TICK = 450;       // interval rekam sweep panorama (ms)
const LS_AUTO = 'rf-cam-auto';

export function openCameraScanner(opts = {}) {
  const startMode = opts.mode || 'doc';
  return new Promise((resolve) => {
    // ===== State =====
    let mode = startMode;                 // 'photo' | 'doc' | 'pano'
    let stream = null, track = null, torchOn = false, torchCapable = false;
    let facing = 'environment';
    let liveQuad = null;                  // hasil deteksi terakhir (koordinat video)
    let lastDetSize = { w: 0, h: 0 };
    let stableCount = 0;
    let detTimer = null, busy = false, finished = false;
    let streamReadyAt = 0;                // tunggu auto-exposure settle (ms epoch)
    let torchHinted = false, darkHintAt = 0, slowHintAt = 0;
    let panoSweep = false, panoTimer = null; // v1.25.1: sweep kontinyu
    let autoMode = '1';
    try { autoMode = localStorage.getItem(LS_AUTO) || '1'; } catch (e) { /* */ }
    const pages = [];                     // doc: {dataUrl, filter, width, height}
    const panoFrames = [];                // pano: dataURL
    let panoAcc = null;                   // canvas akumulasi
    let panoAccGray = null;               // {gray,width,height} skala deteksi
    let stitching = false;

    // ===== DOM =====
    const root = document.createElement('div');
    root.className = 'cs-root';
    root.innerHTML = `
      <div class="cs-top">
        <button class="cs-tbtn" data-act="close">✕</button>
        <div class="cs-tabs">
          <button class="cs-tab ${mode === 'doc' ? 'active' : ''}" data-mode="doc">📄 Dokumen</button>
          <button class="cs-tab ${mode === 'photo' ? 'active' : ''}" data-mode="photo">📷 Foto</button>
          <button class="cs-tab ${mode === 'pano' ? 'active' : ''}" data-mode="pano">🌐 Panorama</button>
        </div>
        <button class="cs-tbtn" data-act="torch" style="display:none">⚡</button>
      </div>
      <div class="cs-stage">
        <video class="cs-video" playsinline muted autoplay></video>
        <canvas class="cs-overlay"></canvas>
        <div class="cs-guide-band" style="display:none">
          <canvas class="cs-guide-strip"></canvas>
          <div class="cs-guide-label">◀ samakan dengan bayangan ini</div>
        </div>
        <div class="cs-flash"></div>
        <div class="cs-busy" style="display:none"><div class="cs-busy-card">⏳ <span>Memproses…</span></div></div>
      </div>
      <div class="cs-hint"><span id="csHintText">Deteksi tepi dokumen aktif…</span></div>
      <div class="cs-bottom">
        <div class="cs-bottom-row">
          <button class="cs-sbtn" data-act="gallery"><span>🖼️</span><small>Galeri</small></button>
          <button class="cs-shutter" data-act="shutter" aria-label="Jepret"><span class="cs-shutter-ring"></span></button>
          <button class="cs-sbtn" data-act="switch"><span>🔄</span><small>Ganti</small></button>
        </div>
        <div class="cs-bottom-row2">
          <button class="cs-pill" data-act="auto">⚡ Auto-jepret: <b>ON</b></button>
          <span class="cs-pages-chip" id="csPagesChip" style="display:none"></span>
          <button class="cs-pill cs-pill-primary" data-act="finish" id="csFinishBtn" style="display:none">💾 Selesai</button>
        </div>
      </div>
    `;
    document.body.appendChild(root);
    document.body.style.overflow = 'hidden';

    const video = root.querySelector('.cs-video');
    const overlayCv = root.querySelector('.cs-overlay');
    const overlayCtx = overlayCv.getContext('2d');
    const flashEl = root.querySelector('.cs-flash');
    const busyEl = root.querySelector('.cs-busy');
    const busyText = busyEl.querySelector('span');
    const hintText = root.querySelector('#csHintText');
    const torchBtn = root.querySelector('[data-act="torch"]');
    const autoPill = root.querySelector('[data-act="auto"]');
    const finishBtn = root.querySelector('#csFinishBtn');
    const pagesChip = root.querySelector('#csPagesChip');
    const guideBand = root.querySelector('.cs-guide-band');
    const guideStrip = root.querySelector('.cs-guide-strip');
    const shutterBtn = root.querySelector('.cs-shutter');

    // ===== Helper umum =====
    function stopStream() {
      try { if (stream) stream.getTracks().forEach(t => t.stop()); } catch (e) { /* */ }
      stream = null; track = null; torchCapable = false; torchOn = false;
    }
    function setBusy(on, text) {
      busy = on;
      busyEl.style.display = on ? 'flex' : 'none';
      if (text) busyText.textContent = text;
    }
    function flash() {
      flashEl.classList.remove('go');
      void flashEl.offsetWidth;
      flashEl.classList.add('go');
      try { navigator.vibrate && navigator.vibrate(30); } catch (e) { /* */ }
    }
    function updateAutoPill() {
      autoPill.innerHTML = mode === 'doc'
        ? `⚡ Auto-jepret: <b>${autoMode === '1' ? 'ON' : 'OFF'}</b>`
        : '⚡ Auto-jepret khusus mode Dokumen';
      autoPill.style.opacity = mode === 'doc' ? '1' : '0.45';
      autoPill.style.display = mode === 'doc' ? '' : 'none';
    }
    function updateFinishUI() {
      if (mode === 'doc') {
        pagesChip.style.display = pages.length ? '' : 'none';
        pagesChip.textContent = `📄 ${pages.length} halaman`;
        finishBtn.style.display = pages.length ? '' : 'none';
      } else if (mode === 'pano') {
        pagesChip.style.display = panoAcc ? '' : 'none';
        pagesChip.textContent = panoAcc
          ? `🌐 ${panoFrames.length} frame · ${panoAcc.width}×${panoAcc.height}px`
          : '';
        finishBtn.style.display = panoAcc ? '' : 'none';
      } else {
        pagesChip.style.display = 'none';
        finishBtn.style.display = 'none';
      }
    }
    function setMode(m) {
      if (mode === 'pano' && m !== 'pano' && panoSweep) stopPanoSweep(false);
      mode = m;
      root.querySelectorAll('.cs-tab').forEach(t => t.classList.toggle('active', t.dataset.mode === m));
      guideBand.style.display = 'none';
      updateAutoPill();
      updateFinishUI();
      hintText.textContent = m === 'doc'
        ? 'Arahkan ke dokumen — tepi terdeteksi otomatis'
        : m === 'pano'
          ? 'Tekan jepret SEKALI lalu geser KANAN perlahan — tekan lagi utk selesai'
          : 'Jepret seperti biasa — hasil langsung disimpan';
      overlayCtx.clearRect(0, 0, overlayCv.width, overlayCv.height);
      liveQuad = null; stableCount = 0;
    }

    async function startStream() {
      stopStream();
      // v1.25.1: 1920×1080 (dulu 2560×1440 — di banyak HP memicu mode HDR/berat
      // dgn exposure buruk; 1080p lebih terang, cepat, cukup utk dokumen & pano)
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: facing },
          width: { ideal: 1920 },
          height: { ideal: 1080 }
        }
      });
      track = stream.getVideoTracks()[0] || null;
      try {
        const caps = track && track.getCapabilities ? track.getCapabilities() : {};
        torchCapable = !!(caps && caps.torch);
      } catch (e) { torchCapable = false; }
      torchBtn.style.display = torchCapable ? '' : 'none';
      video.srcObject = stream;
      await video.play().catch(() => { /* autoplay guard */ });
      // v1.25.1: paksa auto-exposure/AWB kontinyu (beberapa HP mulai dgn exposure
      // terkunci → hasil gelap gulita) — abaikan bila browser tak dukung
      try {
        await track.applyConstraints({ advanced: [
          { exposureMode: 'continuous' }, { whiteBalanceMode: 'continuous' }
        ] });
      } catch (e) { /* opsional */ }
      streamReadyAt = Date.now() + 700; // beri waktu AE settle sebelum auto-jepret
    }
    async function toggleTorch() {
      if (!track || !torchCapable) return;
      torchOn = !torchOn;
      try { await track.applyConstraints({ advanced: [{ torch: torchOn }] }); } catch (e) { torchOn = false; }
      torchBtn.classList.toggle('on', torchOn);
    }

    // ===== Video → koordinat tampilan (object-fit: cover) =====
    function videoBox() {
      const stage = root.querySelector('.cs-stage');
      const cw = stage.clientWidth, ch = stage.clientHeight;
      const vw = video.videoWidth || 1280, vh = video.videoHeight || 720;
      const s = Math.max(cw / vw, ch / vh);
      const dw = vw * s, dh = vh * s;
      return { cw, ch, vw, vh, dx: (cw - dw) / 2, dy: (ch - dh) / 2, s, dw, dh };
    }

    // ===== Overlay tepi realtime (mode doc) =====
    function drawOverlay() {
      const box = videoBox();
      if (overlayCv.width !== box.cw || overlayCv.height !== box.ch) {
        overlayCv.width = box.cw; overlayCv.height = box.ch;
      }
      overlayCtx.clearRect(0, 0, box.cw, box.ch);
      if (mode !== 'doc' || !liveQuad) return;
      const pts = liveQuad.map(p => ({
        x: box.dx + p.x * box.s,
        y: box.dy + p.y * box.s
      }));
      const areaOk = liveQuad._conf >= 0.45;
      overlayCtx.save();
      overlayCtx.beginPath();
      overlayCtx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < 4; i++) overlayCtx.lineTo(pts[i].x, pts[i].y);
      overlayCtx.closePath();
      overlayCtx.fillStyle = areaOk ? 'rgba(53, 224, 161, 0.10)' : 'rgba(255,255,255,0.06)';
      overlayCtx.fill();
      overlayCtx.lineWidth = 3;
      overlayCtx.strokeStyle = areaOk ? '#35e0a1' : 'rgba(255,255,255,0.75)';
      overlayCtx.shadowColor = areaOk ? 'rgba(53,224,161,0.9)' : 'transparent';
      overlayCtx.shadowBlur = 12;
      overlayCtx.stroke();
      overlayCtx.restore();
    }

    // ===== Loop deteksi (240px, tiap 380ms) =====
    const detCv = document.createElement('canvas');
    const detCtx = detCv.getContext('2d', { willReadFrequently: true });
    function detectionTick() {
      if (finished || busy || mode !== 'doc' || !video.videoWidth) return;
      if (Date.now() < streamReadyAt) return; // v1.25.1: tunggu auto-exposure settle
      const vw = video.videoWidth, vh = video.videoHeight;
      const scale = 260 / Math.max(vw, vh);
      const dw = Math.max(32, Math.round(vw * scale));
      const dh = Math.max(32, Math.round(vh * scale));
      if (detCv.width !== dw || detCv.height !== dh) { detCv.width = dw; detCv.height = dh; }
      try { detCtx.drawImage(video, 0, 0, dw, dh); } catch (e) { return; }
      let img;
      try { img = detCtx.getImageData(0, 0, dw, dh); } catch (e) { return; }
      // v1.25.1 GUARD GELAP: scene nyaris hitam → deteksi tepi = noise bodong;
      // jangan deteksi/jepret, ajak tambah cahaya / torch
      const gdet = makeGray(img);
      let gsum = 0;
      for (let i = 0; i < gdet.length; i++) gsum += gdet[i];
      const frameMean = gsum / gdet.length;
      if (frameMean < 45) {
        liveQuad = null; stableCount = 0; drawOverlay();
        if (Date.now() - darkHintAt > 3000) {
          darkHintAt = Date.now();
          hintText.textContent = '🌑 Terlalu gelap — tambah cahaya'
            + (torchCapable ? ' atau ketuk ⚡ kanan atas' : '');
          if (!torchHinted && torchCapable) {
            torchHinted = true;
            showToast('⚡ Ketuk ikon kilat untuk menyalakan lampu');
          }
        }
        return;
      }
      const res = detectQuad(img);
      const inv = 1 / scale;
      if (res && res.confidence >= 0.35) {
        const q = res.points.map(p => ({ x: p.x * inv, y: p.y * inv }));
        q._conf = res.confidence;
        // Stabilitas: bandingkan dgn quad sebelumnya (toleransi 2,5% deteksi)
        if (liveQuad && liveQuad.length === 4) {
          const dmax = Math.max(...q.map((p, i) => Math.hypot(p.x - liveQuad[i].x, p.y - liveQuad[i].y))) * scale;
          stableCount = dmax < 0.025 * Math.max(dw, dh) ? stableCount + 1 : 0;
        } else stableCount = 0;
        liveQuad = q;
        // v1.25.1: kertas harus LEBIH TERANG dari sekelilingnya — cegah
        // auto-jepret pada quad bodong di area gelap (hasil warp = gelap gulita)
        const paperBright = quadBboxBrighter(gdet, dw, dh, res.points, frameMean);
        // AUTO-CAPTURE ala CamScanner: stabil ±1,2 detik + yakin + kertas terang → jepret
        if (autoMode === '1' && stableCount >= 3 && res.confidence >= 0.5 && paperBright
            && Date.now() >= streamReadyAt) {
          stableCount = 0;
          liveQuad = null;
          doShutter(true);
          return;
        }
      } else {
        liveQuad = null; stableCount = 0;
      }
      drawOverlay();
    }

    // ===== Ambil frame full-res =====
    function grabFrame() {
      const vw = video.videoWidth, vh = video.videoHeight;
      const cv = document.createElement('canvas');
      cv.width = vw; cv.height = vh;
      cv.getContext('2d').drawImage(video, 0, 0);
      return cv;
    }
    function canvasToUrl(cv, q = 0.95) { return cv.toDataURL('image/jpeg', q); }

    /** v1.25.1: mean luma cepat (canvas 48×27) — guard frame hitam */
    function quickMean(cv) {
      try {
        const c = document.createElement('canvas');
        c.width = 48; c.height = 27;
        const cx = c.getContext('2d', { willReadFrequently: true });
        cx.drawImage(cv, 0, 0, 48, 27);
        const d = cx.getImageData(0, 0, 48, 27).data;
        let s = 0;
        for (let i = 0; i < d.length; i += 4) s += (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
        return s / (d.length / 4);
      } catch (e) { return 255; }
    }
    /** v1.25.1: guard frame hitam — video belum ready/exposure belum jalan/HDR
     *  iOS drawImage gelap → tunggu + retry, terakhir coba createImageBitmap */
    async function grabFrameGuarded() {
      let cv = grabFrame();
      for (let i = 0; i < 4 && quickMean(cv) < 8; i++) {
        await new Promise(r => setTimeout(r, 280));
        cv = grabFrame();
      }
      if (quickMean(cv) < 8) {
        try {
          const bmp = await createImageBitmap(video);
          const c2 = document.createElement('canvas');
          c2.width = bmp.width; c2.height = bmp.height;
          c2.getContext('2d').drawImage(bmp, 0, 0);
          if (bmp.close) bmp.close();
          if (quickMean(c2) >= 6) return c2;
        } catch (e) { /* browser lama */ }
      }
      return cv;
    }
    /** v1.25.1: kertas di dalam quad harus lebih terang dari rata frame
     *  (bbox quad vs frame) — filter murah utk menolak quad bodong di meja gelap */
    function quadBboxBrighter(gray, w, h, pts, frameMean) {
      let x0 = w, y0 = h, x1 = 0, y1 = 0;
      for (const p of pts) {
        x0 = Math.max(0, Math.min(w - 1, Math.min(x0, p.x)));
        y0 = Math.max(0, Math.min(h - 1, Math.min(y0, p.y)));
        x1 = Math.max(0, Math.min(w - 1, Math.max(x1, p.x)));
        y1 = Math.max(0, Math.min(h - 1, Math.max(y1, p.y)));
      }
      let s = 0, n = 0;
      for (let y = Math.floor(y0); y <= y1; y += 2) {
        for (let x = Math.floor(x0); x <= x1; x += 2) { s += gray[y * w + x]; n++; }
      }
      if (!n) return false;
      const inside = s / n;
      return inside >= frameMean + 3 && inside >= 50;
    }

    async function doShutter(auto = false) {
      if (busy || finished || !video.videoWidth) return;
      if (mode === 'pano') {
        // v1.25.1: sweep kontinyu — jepret MULAI rekam, tekan lagi SELESAI
        if (!panoSweep) await startPanoSweep();
        else stopPanoSweep(true);
        return;
      }
      flash();
      const frame = await grabFrameGuarded();
      if (mode === 'photo') {
        finishCleanup();
        resolve({ cancelled: false, dataUrl: canvasToUrl(frame, 0.95), width: frame.width, height: frame.height, location: null });
        return;
      }
      // mode doc → layar sesuaikan (crop 4 sudut)
      await openAdjust(frame, auto);
    }

    // ===== IMPOR GALERI =====
    async function importGallery() {
      if (busy) return;
      const picked = await pickImage('gallery');
      if (!picked) return;
      const img = await loadImg(picked.dataUrl);
      if (!img) return;
      const cv = document.createElement('canvas');
      cv.width = img.naturalWidth; cv.height = img.naturalHeight;
      cv.getContext('2d').drawImage(img, 0, 0);
      if (mode === 'photo') {
        finishCleanup();
        resolve({ cancelled: false, dataUrl: canvasToUrl(cv, 0.95), width: cv.width, height: cv.height, location: null });
      } else if (mode === 'pano') {
        await addPanoFrame(canvasToUrl(cv, 0.92));
      } else {
        await openAdjust(cv, false);
      }
    }

    // ======================================================================
    // LAYAR SESUAIKAN (crop 4 sudut + loupe) — hanya mode doc
    // ======================================================================
    async function openAdjust(frameCanvas, fromAuto) {
      setBusy(true, fromAuto ? 'Menyiapkan potongan…' : 'Memproses…');
      // Deteksi presisi di 640px utk quad awal (live quad = 260px, kurang presisi)
      let quad = null;
      const long = Math.max(frameCanvas.width, frameCanvas.height);
      const detFull = resizeImg(getImageData(frameCanvas),
        Math.round(640 * frameCanvas.width / long),
        Math.round(640 * frameCanvas.height / long));
      const gFull = makeGray(detFull);
      let gsum = 0;
      for (let i = 0; i < gFull.length; i++) gsum += gFull[i];
      const gMean = gsum / gFull.length;
      const r2 = (gMean >= 45) ? detectQuad(detFull) : null; // guard scene gelap
      if (r2 && r2.confidence >= 0.3 && quadBboxBrighter(gFull, detFull.width, detFull.height, r2.points, gMean)) {
        const s = Math.max(frameCanvas.width, frameCanvas.height) / Math.max(detFull.width, detFull.height);
        quad = r2.points.map(p => ({ x: p.x * s, y: p.y * s }));
      } else if (liveQuad) {
        quad = liveQuad.map(p => ({ ...p }));
      } else {
        quad = defaultQuad(frameCanvas.width, frameCanvas.height, 0.05);
        if (gMean < 45) showToast('🌑 Cahaya kurang — geser 4 titik sudut & pertimbangkan ⚡ lampu', true);
      }
      setBusy(false);
      const verdict = await showAdjustScreen(frameCanvas, quad);
      if (verdict === 'next') {
        await warpAndEnhance(frameCanvas, quad);
      }
      // 'retake'/'discard' → balik ke viewfinder (halaman tidak ditambahkan)
    }

    function showAdjustScreen(frameCanvas, quad) {
      return new Promise((resAdjust) => {
        const scr = document.createElement('div');
        scr.className = 'cs-adjust';
        scr.innerHTML = `
          <div class="cs-adjust-top">
            <button class="cs-tbtn" data-act="discard">✕</button>
            <div class="cs-adjust-title">Atur sudut dokumen</div>
            <button class="cs-tbtn" data-act="redetect">🎯</button>
          </div>
          <div class="cs-adjust-stage">
            <canvas class="cs-adjust-img"></canvas>
            <canvas class="cs-adjust-ovl"></canvas>
            <div class="cs-loupe" style="display:none"><canvas width="120" height="120"></canvas><div class="cs-loupe-cross"></div></div>
          </div>
          <div class="cs-adjust-actions">
            <button class="cs-abtn" data-act="retake">↺ Ulangi</button>
            <button class="cs-abtn cs-abtn-primary" data-act="next">Lanjut ✓</button>
          </div>
        `;
        root.appendChild(scr);
        const imgCv = scr.querySelector('.cs-adjust-img');
        const ovlCv = scr.querySelector('.cs-adjust-ovl');
        const ovlCtx = ovlCv.getContext('2d');
        const loupe = scr.querySelector('.cs-loupe');
        const loupeCv = scr.querySelector('.cs-loupe canvas').getContext('2d');

        let scale = 1, dispW = 0, dispH = 0, offX = 0, offY = 0;
        const drag = { idx: -1 };
        function layout() {
          const stage = scr.querySelector('.cs-adjust-stage');
          const maxW = stage.clientWidth - 16, maxH = stage.clientHeight - 16;
          scale = Math.min(maxW / frameCanvas.width, maxH / frameCanvas.height);
          dispW = frameCanvas.width * scale; dispH = frameCanvas.height * scale;
          offX = (stage.clientWidth - dispW) / 2; offY = (stage.clientHeight - dispH) / 2;
          imgCv.width = frameCanvas.width; imgCv.height = frameCanvas.height;
          imgCv.style.width = dispW + 'px'; imgCv.style.height = dispH + 'px';
          imgCv.style.left = offX + 'px'; imgCv.style.top = offY + 'px';
          ovlCv.width = stage.clientWidth; ovlCv.height = stage.clientHeight;
          ovlCv.style.width = stage.clientWidth + 'px'; ovlCv.style.height = stage.clientHeight + 'px';
          draw();
        }
        function draw() {
          const W = ovlCv.width, H = ovlCv.height;
          ovlCtx.clearRect(0, 0, W, H);
          ovlCtx.fillStyle = 'rgba(0,0,0,0.55)';
          ovlCtx.fillRect(0, 0, W, H);
          const pts = quad.map(p => ({ x: offX + p.x * scale, y: offY + p.y * scale }));
          ovlCtx.globalCompositeOperation = 'destination-out';
          ovlCtx.beginPath();
          ovlCtx.moveTo(pts[0].x, pts[0].y);
          for (let i = 1; i < 4; i++) ovlCtx.lineTo(pts[i].x, pts[i].y);
          ovlCtx.closePath();
          ovlCtx.fill();
          ovlCtx.globalCompositeOperation = 'source-over';
          ovlCtx.beginPath();
          ovlCtx.moveTo(pts[0].x, pts[0].y);
          for (let i = 1; i < 4; i++) ovlCtx.lineTo(pts[i].x, pts[i].y);
          ovlCtx.closePath();
          ovlCtx.strokeStyle = '#35e0a1'; ovlCtx.lineWidth = 2.5; ovlCtx.stroke();
          // titik sudut besar (mudah disentuh)
          pts.forEach((p) => {
            ovlCtx.beginPath();
            ovlCtx.arc(p.x, p.y, 14, 0, Math.PI * 2);
            ovlCtx.fillStyle = '#35e0a1'; ovlCtx.fill();
            ovlCtx.lineWidth = 3; ovlCtx.strokeStyle = '#fff'; ovlCtx.stroke();
          });
        }
        function ptFromEvent(e) {
          const r = ovlCv.getBoundingClientRect();
          return { x: e.clientX - r.left, y: e.clientY - r.top };
        }
        function nearest(x, y) {
          let idx = -1, best = 34;
          quad.forEach((p, i) => {
            const d = Math.hypot(offX + p.x * scale - x, offY + p.y * scale - y);
            if (d < best) { best = d; idx = i; }
          });
          return idx;
        }
        function onDown(e) {
          const p = ptFromEvent(e);
          drag.idx = nearest(p.x, p.y);
          if (drag.idx >= 0) { e.preventDefault(); loupe.style.display = 'block'; drawLoupe(p); }
        }
        function onMove(e) {
          if (drag.idx < 0) return;
          e.preventDefault();
          const p = ptFromEvent(e);
          const nx = Math.max(0, Math.min(frameCanvas.width, (p.x - offX) / scale));
          const ny = Math.max(0, Math.min(frameCanvas.height, (p.y - offY) / scale));
          quad[drag.idx] = { x: nx, y: ny };
          draw();
          drawLoupe(p);
        }
        function onUp() { drag.idx = -1; loupe.style.display = 'none'; }
        function drawLoupe(p) {
          const sx = (p.x - offX) / scale, sy = (p.y - offY) / scale;
          const Z = 3, R = 30; // sumber 60×60 → 120×120 tampil
          loupeCv.clearRect(0, 0, 120, 120);
          loupeCv.imageSmoothingEnabled = false;
          loupeCv.drawImage(frameCanvas, sx - R, sy - R, R * 2, R * 2, 0, 0, 120, 120);
          const lr = loupe.getBoundingClientRect();
          loupe.style.left = Math.max(4, Math.min(window.innerWidth - 132, p.x - 60)) + 'px';
          loupe.style.top = Math.max(4, p.y - lr.height - 28) + 'px';
        }
        ovlCv.addEventListener('pointerdown', onDown);
        ovlCv.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp, { once: false });

        scr.addEventListener('click', async (e) => {
          const act = e.target.closest('[data-act]')?.dataset.act;
          if (!act) return;
          if (act === 'discard' || act === 'retake') {
            teardown();
            resAdjust(act === 'retake' ? 'retake' : 'discard');
          } else if (act === 'redetect') {
            setBusy(true, 'Deteksi ulang…');
            const longR = Math.max(frameCanvas.width, frameCanvas.height);
            const big = resizeImg(getImageData(frameCanvas),
              Math.round(640 * frameCanvas.width / longR),
              Math.round(640 * frameCanvas.height / longR));
            const r = detectQuad(big);
            setBusy(false);
            if (r) {
              const s = Math.max(frameCanvas.width, frameCanvas.height) / Math.max(big.width, big.height);
              quad = r.points.map(p => ({ x: p.x * s, y: p.y * s }));
              draw();
            } else showToast('Tepi tidak terdeteksi — geser 4 titik manual');
          } else if (act === 'next') {
            teardown();
            resAdjust('next');
          }
        });
        function teardown() {
          window.removeEventListener('pointerup', onUp);
          scr.remove();
        }
        layout();
      });
    }

    // ======================================================================
    // WARP → LAYAR FILTER (enhance screen) — hanya mode doc
    // ======================================================================
    async function warpAndEnhance(frameCanvas, quad) {
      setBusy(true, 'Merapikan perspektif…');
      await new Promise(r => setTimeout(r, 30)); // beri kesempatan paint
      let warped;
      try {
        const img = getImageData(frameCanvas);
        warped = warpQuad(img, quad, WARP_CAP);
      } catch (e) {
        setBusy(false);
        showToast('Gagal merapikan: ' + e.message, true);
        return;
      }
      // v1.25.1: hasil warp nyaris hitam = quad salah / cahaya kurang —
      // peringatkan SEBELUM layar filter (user bisa ← balik & perbaiki sudut)
      let wsum = 0;
      const wd = warped.data;
      for (let i = 0; i < wd.length; i += 4) wsum += (wd[i] * 77 + wd[i + 1] * 150 + wd[i + 2] * 29) >> 8;
      const wMean = wsum / (wd.length / 4);
      setBusy(false);
      if (wMean < 45) showToast('⚠ Hasil gelap — atur 4 sudut / tambah cahaya lalu ulangi', true);
      const warpedCv = imgToCanvas(warped);
      const filter = 'enhance'; // default ala CamScanner — langsung terbaca
      const adj = { brightness: 0, contrast: 0 };
      await showEnhanceScreen(warpedCv, filter, adj);
    }

    function showEnhanceScreen(warpedCv, filter, adj) {
      return new Promise((resEnhance) => {
        // Base preview (maks 1100px) — filter dihitung di sini (cepat)
        const long = Math.max(warpedCv.width, warpedCv.height);
        const ps = Math.min(1, 1100 / long);
        const base = resizeImg(getImageData(warpedCv), warpedCv.width * ps, warpedCv.height * ps);

        const scr = document.createElement('div');
        scr.className = 'cs-enhance';
        scr.innerHTML = `
          <div class="cs-adjust-top">
            <button class="cs-tbtn" data-act="back">←</button>
            <div class="cs-adjust-title">Perbagus hasil</div>
            <button class="cs-tbtn" data-act="save">✓</button>
          </div>
          <div class="cs-enhance-stage"><canvas class="cs-enhance-img"></canvas></div>
          <div class="cs-enhance-ctrl">
            <div class="cs-chips">
              ${FILTERS.map(f => `<button class="cs-chip ${f.id === filter ? 'active' : ''}" data-filter="${f.id}">${f.icon} ${f.label}</button>`).join('')}
            </div>
            <label class="cs-slider-row">☀️ Kecerahan
              <input type="range" class="cs-slider" data-k="brightness" min="-100" max="100" value="${adj.brightness}">
            </label>
            <label class="cs-slider-row">◐ Kontras
              <input type="range" class="cs-slider" data-k="contrast" min="-100" max="100" value="${adj.contrast}">
            </label>
          </div>
        `;
        root.appendChild(scr);
        const imgCv = scr.querySelector('.cs-enhance-img');
        const stage = scr.querySelector('.cs-enhance-stage');
        let renderT = null;

        function layoutCanvas(baseImg) {
          const maxW = stage.clientWidth - 12, maxH = stage.clientHeight - 12;
          const s = Math.min(maxW / baseImg.width, maxH / baseImg.height, 1);
          imgCv.width = baseImg.width; imgCv.height = baseImg.height;
          imgCv.style.width = Math.round(baseImg.width * s) + 'px';
          imgCv.style.height = Math.round(baseImg.height * s) + 'px';
        }
        function renderPreview() {
          const work = new ImageData(new Uint8ClampedArray(base.data), base.width, base.height);
          applyFilterImg(filter, work);
          applyAdjust(work, adj.brightness, adj.contrast);
          layoutCanvas(base);
          const off = document.createElement('canvas');
          off.width = base.width; off.height = base.height;
          off.getContext('2d').putImageData(work, 0, 0);
          const ctx = imgCv.getContext('2d');
          ctx.clearRect(0, 0, imgCv.width, imgCv.height);
          ctx.drawImage(off, 0, 0);
        }
        function schedule() {
          clearTimeout(renderT);
          renderT = setTimeout(renderPreview, 90);
        }
        scr.addEventListener('click', async (e) => {
          const chip = e.target.closest('.cs-chip');
          if (chip) {
            filter = chip.dataset.filter;
            scr.querySelectorAll('.cs-chip').forEach(c => c.classList.toggle('active', c.dataset.filter === filter));
            setBusy(true, 'Filter…');
            await new Promise(r => setTimeout(r, 20));
            renderPreview();
            setBusy(false);
            return;
          }
          const act = e.target.closest('[data-act]')?.dataset.act;
          if (act === 'back') { scr.remove(); resEnhance('back'); }
          else if (act === 'save') {
            setBusy(true, 'Menyimpan halaman…');
            await new Promise(r => setTimeout(r, 30));
            try {
              const full = new ImageData(new Uint8ClampedArray(getImageData(warpedCv).data), warpedCv.width, warpedCv.height);
              applyFilterImg(filter, full);
              applyAdjust(full, adj.brightness, adj.contrast);
              const outCv = document.createElement('canvas');
              outCv.width = warpedCv.width; outCv.height = warpedCv.height;
              outCv.getContext('2d').putImageData(full, 0, 0);
              const dataUrl = outCv.toDataURL('image/jpeg', 0.92);
              pages.push({ dataUrl, filter, width: warpedCv.width, height: warpedCv.height });
              setBusy(false);
              scr.remove();
              resEnhance('saved');
            } catch (err) {
              setBusy(false);
              showToast('Gagal simpan halaman: ' + err.message, true);
            }
          }
        });
        scr.querySelectorAll('.cs-slider').forEach(sl => {
          sl.addEventListener('input', () => {
            adj[sl.dataset.k] = parseInt(sl.value, 10) || 0;
            schedule();
          });
        });
        renderPreview();
      });
    }

    // ======================================================================
    // PANORAMA v1.25.1 — SWEEP KONTINYU ala kamera native:
    // tekan jepret = mulai rekam (frame otomatis tiap 450ms), geser HP
    // KANAN perlahan, tiap frame langsung disambung (ZSAD), tekan lagi =
    // selesai. Frame yg gagal disambung DI-DIAMKAN (skip) — sweep tetap
    // jalan, jangan galau user dgn error tiap detik.
    // ======================================================================
    async function addPanoFrame(dataUrl, quiet = false) {
      if (stitching) return;
      stitching = true;
      if (!quiet) setBusy(true, panoAcc ? 'Menyambung foto…' : 'Menyiapkan panorama…');
      try {
        const img = await loadImg(dataUrl);
        if (!img) throw new Error('frame gagal dimuat');
        // Skala ke tinggi kerja PANO_H
        const s = PANO_H / img.naturalHeight;
        const fw = Math.max(1, Math.round(img.naturalWidth * s));
        const frameCv = document.createElement('canvas');
        frameCv.width = fw; frameCv.height = PANO_H;
        frameCv.getContext('2d').drawImage(img, 0, 0, fw, PANO_H);
        const frameImg = getImageData(frameCv);

        if (!panoAcc) {
          panoAcc = frameCv;
          panoAccGray = grayAt(panoAcc, 240);
          panoFrames.push(dataUrl);
          if (quiet) hintText.textContent = '🔄 Merekam… geser KANAN PERLAHAN';
          else showToast('✓ Frame 1 — geser KANAN lalu jepret lagi');
        } else {
          if (panoAcc.width + fw - 8 > PANO_MAX_W) {
            if (quiet) { stopPanoSweep(true); return; }
            showToast('Panorama sudah mencapai lebar maksimal', true);
          } else {
            // Cocokkan di skala rendah (cepat & tahan noise)
            const fGray = grayAt(frameCv, 240);
            const m = matchPanorama(panoAccGray, fGray);
            if (!m) {
              // v1.25.1: di mode sweep JANGAN spam error — sekadar skip frame
              if (quiet) {
                if (Date.now() - slowHintAt > 2500) {
                  slowHintAt = Date.now();
                  hintText.textContent = '⏳ Terlewat — geser lebih LAMBAT…';
                }
              } else {
                showToast('Tidak sambung — geser lebih sedikit & jepret lagi', true);
              }
            } else {
              const scaleUp = PANO_H / panoAccGray.height;
              const overlap = Math.max(8, Math.round(m.overlap * scaleUp));
              const dy = Math.max(-Math.round(PANO_H * 0.15), Math.min(Math.round(PANO_H * 0.15), Math.round(m.dy * scaleUp)));
              const newW = panoAcc.width + fw - overlap;
              const acc = document.createElement('canvas');
              acc.width = newW; acc.height = PANO_H;
              const actx = acc.getContext('2d');
              actx.drawImage(panoAcc, 0, 0);
              // gambar frame baru di kanan, koreksi dy, feather di seam
              const FE = 36;
              actx.save();
              actx.beginPath();
              actx.rect(panoAcc.width - overlap + FE, 0, newW, PANO_H);
              actx.clip();
              actx.drawImage(frameCv, panoAcc.width - overlap, dy);
              actx.restore();
              actx.drawImage(frameCv, panoAcc.width - overlap, dy);
              // feather: timpa band seam dgn campuran kolom
              for (let x = 0; x < FE; x++) {
                const a = x / FE;
                const sx = panoAcc.width - overlap + x;
                actx.save();
                actx.globalAlpha = 1 - a;
                actx.drawImage(panoAcc, sx, 0, 1, PANO_H, sx, 0, 1, PANO_H);
                actx.restore();
              }
              panoAcc = acc;
              panoAccGray = grayAt(panoAcc, 240);
              panoFrames.push(dataUrl);
              if (quiet) {
                hintText.textContent = `🌐 ${panoAcc.width}px tersambung — terus geser…`;
              } else {
                showToast(`✓ Tersambung (overlap ${overlap}px)`);
              }
            }
          }
        }
      } catch (e) {
        showToast('Panorama: ' + e.message, true);
      } finally {
        stitching = false;
        if (!quiet) setBusy(false);
        updateFinishUI();
        updateGuideBand();
      }
    }

    /** v1.25.1: MULAI sweep — jepret = mulai, tekan lagi = selesai */
    async function startPanoSweep() {
      if (panoSweep || stitching) return;
      panoSweep = true;
      shutterBtn.classList.add('sweeping');
      shutterBtn.setAttribute('aria-label', 'Selesai panorama');
      flash();
      try {
        const cv = await grabFrameGuarded();
        await addPanoFrame(canvasToUrl(cv, 0.92), true);
      } catch (e) { /* frame pertama gagal → tick berikutnya coba lagi */ }
      panoTimer = setInterval(async () => {
        if (!panoSweep || stitching || busy || finished || !video.videoWidth) return;
        try {
          const cv = await grabFrameGuarded();
          await addPanoFrame(canvasToUrl(cv, 0.92), true);
        } catch (e) { /* skip tick ini */ }
      }, PANO_TICK);
    }

    /** v1.25.1: HENTIkan sweep; finish=true → langsung susun & keluar */
    function stopPanoSweep(finish) {
      if (panoTimer) { clearInterval(panoTimer); panoTimer = null; }
      if (!panoSweep && !finish) return;
      panoSweep = false;
      shutterBtn.classList.remove('sweeping');
      shutterBtn.setAttribute('aria-label', 'Jepret');
      if (finish && panoAcc && !finished) {
        finishPano();
      } else if (mode === 'pano') {
        hintText.textContent = 'Tekan jepret SEKALI lalu geser KANAN perlahan — tekan lagi utk selesai';
      }
    }

    /** pita alignment: strip kanan dari akumulasi, ditampilkan di kanan viewfinder */
    function updateGuideBand() {
      if (mode !== 'pano' || !panoAcc) { guideBand.style.display = 'none'; return; }
      const stage = root.querySelector('.cs-stage');
      const bandW = Math.round(stage.clientWidth * 0.25);
      guideStrip.width = bandW; guideStrip.height = stage.clientHeight;
      const gctx = guideStrip.getContext('2d');
      const srcX = panoAcc.width - Math.round(panoAcc.width * 0.25);
      gctx.clearRect(0, 0, bandW, guideStrip.height);
      gctx.globalAlpha = 0.5;
      gctx.drawImage(panoAcc, srcX, 0, panoAcc.width - srcX, panoAcc.height, 0, 0, bandW, guideStrip.height);
      guideBand.style.display = 'block';
    }

    async function finishPano() {
      if (!panoAcc || finished) return;
      if (panoTimer) { clearInterval(panoTimer); panoTimer = null; }
      panoSweep = false;
      shutterBtn.classList.remove('sweeping');
      setBusy(true, 'Menyusun panorama…');
      await new Promise(r => setTimeout(r, 30));
      try {
        const dataUrl = panoAcc.toDataURL('image/jpeg', 0.92);
        setBusy(false);
        finishCleanup();
        resolve({ cancelled: false, dataUrl, width: panoAcc.width, height: panoAcc.height, location: null });
      } catch (e) {
        setBusy(false);
        showToast('Gagal menyusun: ' + e.message, true);
      }
    }

    // ===== Selesai (doc) — lembar judul + catatan =====
    function finishDoc() {
      if (!pages.length) return;
      const scr = document.createElement('div');
      scr.className = 'cs-sheet-wrap';
      scr.innerHTML = `
        <div class="cs-sheet-backdrop"></div>
        <div class="cs-sheet">
          <h3>Simpan Dokumen (${pages.length} halaman)</h3>
          <input class="cs-input" id="csDocTitle" type="text" placeholder="Judul dokumen…"
            value="Dokumen ${new Date().toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' })}">
          <input class="cs-input" id="csDocNote" type="text" placeholder="📝 Catatan (opsional)…">
          <div class="cs-sheet-thumbs">
            ${pages.map((p, i) => `<div class="cs-sheet-thumb"><img src="${p.dataUrl}" alt=""><span>${i + 1}</span></div>`).join('')}
          </div>
          <div class="cs-sheet-actions">
            <button class="cs-abtn" data-act="back">← Lanjut edit</button>
            <button class="cs-abtn cs-abtn-primary" data-act="save">💾 Simpan</button>
          </div>
        </div>
      `;
      root.appendChild(scr);
      const titleInput = scr.querySelector('#csDocTitle');
      setTimeout(() => { try { titleInput.focus(); titleInput.select(); } catch (e) { /* */ } }, 120);
      scr.addEventListener('click', (e) => {
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (act === 'back') scr.remove();
        else if (act === 'save') {
          const title = titleInput.value.trim() || `Dokumen ${new Date().toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' })}`;
          const note = scr.querySelector('#csDocNote').value.trim();
          finishCleanup();
          resolve({ cancelled: false, pages, title, note });
        }
      });
    }

    // ===== Util =====
    function getImageData(cv) {
      return cv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, cv.width, cv.height);
    }
    function imgToCanvas(img) {
      const cv = document.createElement('canvas');
      cv.width = img.width; cv.height = img.height;
      cv.getContext('2d').putImageData(img, 0, 0);
      return cv;
    }
    function grayAt(cv, targetH) {
      const s = Math.min(1, targetH / cv.height);
      const w = Math.max(16, Math.round(cv.width * s));
      const h = Math.max(16, Math.round(cv.height * s));
      const small = document.createElement('canvas');
      small.width = w; small.height = h;
      small.getContext('2d').drawImage(cv, 0, 0, w, h);
      const id = small.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h);
      return { gray: makeGray(id), width: w, height: h };
    }
    function loadImg(src) {
      return new Promise((res) => {
        const img = new Image();
        img.onload = () => res(img);
        img.onerror = () => res(null);
        img.src = src;
      });
    }
    function showToast(msg, isError = false) {
      const t = document.createElement('div');
      t.className = 'toast cs-toast' + (isError ? ' toast-error' : '');
      t.textContent = msg;
      t.style.zIndex = '1500';
      document.body.appendChild(t);
      setTimeout(() => t.classList.add('show'), 10);
      setTimeout(() => { t.classList.remove('show'); setTimeout(() => { if (t.parentNode) t.remove(); }, 300); }, 2400);
    }

    // ===== Event root =====
    root.addEventListener('click', async (e) => {
      const tab = e.target.closest('.cs-tab');
      if (tab) { setMode(tab.dataset.mode); return; }
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      if (act === 'close') {
        if (panoSweep) stopPanoSweep(false);
        const hasWork = (mode === 'doc' && pages.length) || (mode === 'pano' && panoAcc);
        if (hasWork && !confirm('Buang hasil yang sudah ada?')) return;
        finishCleanup();
        resolve({ cancelled: true });
      } else if (act === 'shutter') {
        await doShutter(false);
      } else if (act === 'torch') {
        await toggleTorch();
      } else if (act === 'switch') {
        facing = facing === 'environment' ? 'user' : 'environment';
        setBusy(true, 'Ganti kamera…');
        try { await startStream(); } catch (err) { showToast('Kamera tidak tersedia: ' + err.message, true); }
        setBusy(false);
      } else if (act === 'gallery') {
        await importGallery();
      } else if (act === 'auto') {
        if (mode !== 'doc') return;
        autoMode = autoMode === '1' ? '0' : '1';
        try { localStorage.setItem(LS_AUTO, autoMode); } catch (err) { /* */ }
        updateAutoPill();
        showToast(autoMode === '1' ? '⚡ Auto-jepret AKTIF' : '✋ Manual — tekan tombol jepret');
      } else if (act === 'finish') {
        if (mode === 'doc') finishDoc();
        else if (mode === 'pano') await finishPano();
      }
    });

    // ===== Cleanup & boot =====
    function finishCleanup() {
      finished = true;
      if (panoTimer) { clearInterval(panoTimer); panoTimer = null; }
      panoSweep = false;
      clearInterval(detTimer);
      stopStream();
      root.remove();
      document.body.style.overflow = '';
    }

    (async () => {
      setBusy(true, 'Menyalakan kamera…');
      try {
        await startStream();
        setBusy(false);
        updateAutoPill();
        updateFinishUI();
        detTimer = setInterval(detectionTick, 380);
        if (startMode === 'doc') {
          hintText.textContent = 'Arahkan ke dokumen — tepi terdeteksi otomatis';
        } else if (startMode === 'pano') {
          hintText.textContent = 'Tekan jepret SEKALI lalu geser KANAN perlahan — tekan lagi utk selesai';
        } else {
          hintText.textContent = 'Jepret seperti biasa — hasil langsung disimpan';
        }
      } catch (e) {
        setBusy(false);
        finishCleanup();
        console.warn('[RecallFox] camscanner getUserMedia gagal:', e);
        resolve({ cancelled: true, fallback: true, reason: e && e.message });
      }
    })();
  });
}
