// src/cam-ops.js — Pure image operations untuk kamera ala CamScanner (v1.25.0)
//
// SEMUA fungsi di sini PURE (tanpa DOM/canvas) → bisa diuji di Node.
// Format gambar: { data: Uint8ClampedArray (RGBA), width, height }.
//
// Kenapa dibuat sendiri (bukan OpenCV)?
//   - OpenCV.js = 8MB download pertama → lambat & butir putus di jaringan lemah.
//   - Algoritma yang dipakai CamScanner-class cukup dgn: Sobel + RANSAC line-fit
//     (deteksi tepi), homography DLT (warp), box-blur adaptive threshold (B&W),
//     background division (whitening), SAD template match (stitch panorama).
//   - Semua O(w*h) atau lebih murah → jalan realtime di HP kelas bawah.
//
// Sumber acuan perilaku CamScanner (dipelajari user minta):
//   1. Viewfinder live + polygon tepi kertas realtime + auto-capture saat stabil.
//   2. Crop 4 sudut draggable + koreksi perspektif.
//   3. Filter: Enhance (teks tajam, warna asli), Magic Color (bg putih cerah,
//      warna hidup), Gray, B&W (hitam-putih teks murni).
//   4. Teks SELALU mudah dibaca — tidak ada elemen hilang.

// ============================================================================
// UTIL DASAR
// ============================================================================

/** RGBA → grayscale Uint8Array (0..255). */
export function makeGray(img) {
  const { data, width, height } = img;
  const out = new Uint8Array(width * height);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    out[j] = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8; // 0.299/0.587/0.114
  }
  return out;
}

/** Box blur separable radius r utk array grayscale — sliding window O(w*h). */
export function boxBlurGray(src, w, h, r) {
  if (r < 1) return src.slice();
  const tmp = new Float32Array(w * h);
  const dst = new Uint8ClampedArray(w * h);
  const norm = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += src[row + Math.max(0, Math.min(w - 1, k))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum / norm;
      const xOut = Math.max(0, Math.min(w - 1, x - r));
      const xIn = Math.max(0, Math.min(w - 1, x + r + 1));
      sum += src[row + xIn] - src[row + xOut];
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += tmp[Math.max(0, Math.min(h - 1, k)) * w + x];
    for (let y = 0; y < h; y++) {
      dst[y * w + x] = sum / norm;
      const yOut = Math.max(0, Math.min(h - 1, y - r));
      const yIn = Math.max(0, Math.min(h - 1, y + r + 1));
      sum += tmp[yIn * w + x] - tmp[yOut * w + x];
    }
  }
  return dst;
}

/** Sobel magnitude Uint8Array dari grayscale. */
export function sobelMag(gray, w, h) {
  const out = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx =
        -gray[i - w - 1] - 2 * gray[i - 1] - gray[i + w - 1] +
        gray[i - w + 1] + 2 * gray[i + 1] + gray[i + w + 1];
      const gy =
        -gray[i - w - 1] - 2 * gray[i - w] - gray[i - w + 1] +
        gray[i + w - 1] + 2 * gray[i + w] + gray[i + w + 1];
      const m = Math.abs(gx) + Math.abs(gy); // L1 — cukup utk edge map
      out[i] = m > 255 ? 255 : m;
    }
  }
  return out;
}

/** Bilinear resize RGBA. */
export function resizeImg(img, nw, nh) {
  const { data, width, height } = img;
  nw = Math.max(1, Math.round(nw));
  nh = Math.max(1, Math.round(nh));
  const out = new Uint8ClampedArray(nw * nh * 4);
  const rx = width / nw, ry = height / nh;
  for (let y = 0; y < nh; y++) {
    const sy = Math.min(height - 1, (y + 0.5) * ry - 0.5);
    const y0 = Math.max(0, Math.floor(sy));
    const y1 = Math.min(height - 1, y0 + 1);
    const fy = Math.max(0, Math.min(1, sy - y0));
    for (let x = 0; x < nw; x++) {
      const sx = Math.min(width - 1, (x + 0.5) * rx - 0.5);
      const x0 = Math.max(0, Math.floor(sx));
      const x1 = Math.min(width - 1, x0 + 1);
      const fx = Math.max(0, Math.min(1, sx - x0));
      const o = (y * nw + x) * 4;
      for (let c = 0; c < 3; c++) {
        const p00 = data[(y0 * width + x0) * 4 + c];
        const p10 = data[(y0 * width + x1) * 4 + c];
        const p01 = data[(y1 * width + x0) * 4 + c];
        const p11 = data[(y1 * width + x1) * 4 + c];
        out[o + c] = (p00 * (1 - fx) + p10 * fx) * (1 - fy) +
                     (p01 * (1 - fx) + p11 * fx) * fy;
      }
      out[o + 3] = 255;
    }
  }
  return { data: out, width: nw, height: nh };
}

// ============================================================================
// DETEKSI TEPI DOKUMEN (quad 4 sudut) — ala viewfinder CamScanner
// ============================================================================

/** Sudut default (margin m) TL,TR,BR,BL. */
export function defaultQuad(w, h, m = 0.04) {
  return [
    { x: w * m, y: h * m },
    { x: w * (1 - m), y: h * m },
    { x: w * (1 - m), y: h * (1 - m) },
    { x: w * m, y: h * (1 - m) }
  ];
}

function orderQuad(pts) {
  const s = [...pts].sort((a, b) => (a.x + a.y) - (b.x + b.y));
  const tl = s[0], br = s[3];
  // Dari 2 sisanya: y-x MIN = TR (y kecil, x besar), y-x MAX = BL
  const rest = [s[1], s[2]].sort((a, b) => (a.y - a.x) - (b.y - b.x));
  return [tl, rest[0], br, rest[1]]; // TL, TR, BR, BL
}

function shoelaceArea(q) {
  let a = 0;
  for (let i = 0; i < 4; i++) {
    const p = q[i], n = q[(i + 1) % 4];
    a += p.x * n.y - n.x * p.y;
  }
  return Math.abs(a) / 2;
}

function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

function isConvex(q) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const o = q[i], a = q[(i + 1) % 4], b = q[(i + 2) % 4];
    const cross = (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    if (Math.abs(cross) < 1e-9) return false;
    const s = Math.sign(cross);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/** RANSAC line fit. Mode 'x=a*y+b' (border kiri/kanan) atau 'y=a*x+b' (atas/bawah). */
function ransacLine(cands, mode, tol = 2, iters = 30) {
  const n = cands.length;
  if (n < 8) return null;
  let best = null, bestIn = 0;
  for (let it = 0; it < iters; it++) {
    const i = (Math.random() * n) | 0;
    let j = (Math.random() * n) | 0;
    if (j === i) j = (j + 1) % n;
    const p = cands[i], q = cands[j];
    // kandidat: {pos, v} — pos = y (mode 'x') / x (mode 'y'); v = nilai sumbu lawan
    const pPos = mode === 'x' ? p.y : p.x;
    const qPos = mode === 'x' ? q.y : q.x;
    let a, b;
    if (Math.abs(qPos - pPos) < 3) continue;
    a = (q.v - p.v) / (qPos - pPos);
    b = p.v - a * pPos;
    if (Math.abs(a) > 1.2) continue; // kemiringan > 50° → bukan border
    let nIn = 0;
    for (const c of cands) {
      const cPos = mode === 'x' ? c.y : c.x;
      const pred = a * cPos + b;
      if (Math.abs(c.v - pred) <= tol) nIn++;
    }
    if (nIn > bestIn) { bestIn = nIn; best = { a, b }; }
  }
  if (!best) return null;
  return { a: best.a, b: best.b, inlierRatio: bestIn / n };
}

/**
 * Deteksi quad dokumen dari gambar RGBA.
 * @param {{data,width,height}} img — SARAN: downscale ~240px sisi panjang (cepat).
 * @returns {{points:[{x,y}x4], confidence:number} | null}
 *   points ter-urut TL,TR,BR,BL dalam koordinat img. null = gagal → caller
 *   pakai defaultQuad() (ala CamScanner: tetap bisa crop manual).
 */
export function detectQuad(img) {
  const { width: W, height: H } = img;
  const gray0 = makeGray(img);
  const gray = boxBlurGray(gray0, W, H, 1); // redam noise
  const mag = sobelMag(gray, W, H);

  // Threshold adaptif: mean + 2.2 * std
  let sum = 0, sum2 = 0;
  for (let i = 0; i < mag.length; i++) { sum += mag[i]; sum2 += mag[i] * mag[i]; }
  const mean = sum / mag.length;
  const std = Math.sqrt(Math.max(0, sum2 / mag.length - mean * mean));
  const thr = Math.min(255, mean + 2.2 * std);

  // Kandidat border: baris → tepi paling kiri/kanan; kolom → paling atas/bawah
  const left = [], right = [], top = [], bottom = [];
  const minRowHits = Math.floor(W * 0.18);
  for (let y = 2; y < H - 2; y++) {
    let lx = -1, rx = -1;
    for (let x = 1; x < W - 1; x++) if (mag[y * W + x] > thr) { lx = x; break; }
    for (let x = W - 2; x > 0; x--) if (mag[y * W + x] > thr) { rx = x; break; }
    if (lx >= 0) left.push({ y, v: lx });
    if (rx >= 0) right.push({ y, v: rx });
    void minRowHits;
  }
  for (let x = 2; x < W - 2; x++) {
    let ty = -1, by = -1;
    for (let y = 1; y < H - 1; y++) if (mag[y * W + x] > thr) { ty = y; break; }
    for (let y = H - 2; y > 0; y--) if (mag[y * W + x] > thr) { by = y; break; }
    if (ty >= 0) top.push({ x, v: ty });
    if (by >= 0) bottom.push({ x, v: by });
  }

  const L = ransacLine(left, 'x');
  const R = ransacLine(right, 'x');
  const T = ransacLine(top, 'y');
  const B = ransacLine(bottom, 'y');
  const sides = [L, R, T, B];
  const okSides = sides.filter(Boolean).length;
  if (okSides < 3) return null;

  // Sisi gagal → pakai border frame (margin 2%) supaya quad tetap tertutup
  const fallbackX = { a: 0, b: 2, inlierRatio: 0.5 };
  const fallbackX2 = { a: 0, b: W - 3, inlierRatio: 0.5 };
  const fallbackY = { a: 0, b: 2, inlierRatio: 0.5 };
  const fallbackY2 = { a: 0, b: H - 3, inlierRatio: 0.5 };
  const l = L || fallbackX, r = R || fallbackX2, t = T || fallbackY, b = B || fallbackY2;

  // Interseksi: garis vertikal x = av*y + bv ; horizontal y = ah*x + bh
  function crossVH(v, hh) {
    const den = 1 - v.a * hh.a;
    if (Math.abs(den) < 0.05) return null;
    const y = (hh.a * v.b + hh.b) / den;
    const x = v.a * y + v.b;
    return { x, y };
  }
  const tl = crossVH(l, t), tr = crossVH(r, t), br = crossVH(r, b), bl = crossVH(l, b);
  if (!tl || !tr || !br || !bl) return null;

  const quad = orderQuad([tl, tr, br, bl]);
  // Validasi: dalam frame (toleransi 12%), convex, area masuk akal, sisi cukup panjang
  const mX = W * 0.12, mY = H * 0.12;
  for (const p of quad) {
    if (!isFinite(p.x) || !isFinite(p.y)) return null;
    if (p.x < -mX || p.x > W + mX || p.y < -mY || p.y > H + mY) return null;
  }
  if (!isConvex(quad)) return null;
  const area = shoelaceArea(quad);
  const areaRatio = area / (W * H);
  if (areaRatio < 0.10 || areaRatio > 0.995) return null;
  const minSide = Math.min(W, H);
  const sidesLen = [dist(quad[0], quad[1]), dist(quad[1], quad[2]), dist(quad[2], quad[3]), dist(quad[3], quad[0])];
  if (Math.min(...sidesLen) < minSide * 0.15) return null;

  const inlier = Math.min(
    (L || { inlierRatio: 0.5 }).inlierRatio, (R || { inlierRatio: 0.5 }).inlierRatio,
    (T || { inlierRatio: 0.5 }).inlierRatio, (B || { inlierRatio: 0.5 }).inlierRatio
  );
  if (inlier < 0.30) return null;
  const confidence = Math.min(1, inlier * (0.6 + 0.4 * Math.min(1, areaRatio * 2.2)));
  return { points: quad, confidence, areaRatio };
}

// ============================================================================
// KOREKSI PERSPEKTIF (homography DLT 4 titik → rectangle)
// ============================================================================

/** Selesaikan homography dst→src (8 params, h22=1) via eliminasi Gauss. */
export function solveHomography(src, dst) {
  // src/dst: [{x,y}×4]. Cari H: srcX = (h0*dx + h1*dy + h2)/(h6*dx + h7*dy + 1)
  const A = [];
  for (let i = 0; i < 4; i++) {
    const { x: dx, y: dy } = dst[i];
    const { x: sx, y: sy } = src[i];
    A.push([dx, dy, 1, 0, 0, 0, -dx * sx, -dy * sx, sx]);
    A.push([0, 0, 0, dx, dy, 1, -dx * sy, -dy * sy, sy]);
  }
  // Eliminasi Gauss + pivoting
  const n = 8;
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    }
    [A[col], A[piv]] = [A[piv], A[col]];
    const pv = A[col][col];
    if (Math.abs(pv) < 1e-10) return null;
    for (let r = col + 1; r < n; r++) {
      const f = A[r][col] / pv;
      for (let c = col; c <= n; c++) A[r][c] -= f * A[col][c];
    }
  }
  const h = new Float64Array(8);
  for (let row = n - 1; row >= 0; row--) {
    let s = A[row][n];
    for (let c = row + 1; c < n; c++) s -= A[row][c] * h[c];
    h[row] = s / A[row][row];
  }
  return h;
}

/**
 * Warp quad → rectangle (pemetaan invers + sampling bilinear).
 * @returns {{data,width,height}} RGBA
 */
export function warpQuad(img, quad, capLong = 3200) {
  const { data, width: W, height: H } = img;
  const q = quad.map(p => ({ x: Math.max(0, Math.min(W - 1, p.x)), y: Math.max(0, Math.min(H - 1, p.y)) }));
  const wTop = dist(q[0], q[1]), wBot = dist(q[3], q[2]);
  const hL = dist(q[0], q[3]), hR = dist(q[1], q[2]);
  let outW = Math.max(1, Math.round(Math.max(wTop, wBot)));
  let outH = Math.max(1, Math.round(Math.max(hL, hR)));
  const long = Math.max(outW, outH);
  if (long > capLong) {
    const s = capLong / long;
    outW = Math.max(1, Math.round(outW * s));
    outH = Math.max(1, Math.round(outH * s));
  }
  const dst = [
    { x: 0, y: 0 }, { x: outW, y: 0 }, { x: outW, y: outH }, { x: 0, y: outH }
  ];
  const h = solveHomography(q, dst);
  if (!h) {
    // fallback super-langka: crop bounding box
    const xs = q.map(p => p.x), ys = q.map(p => p.y);
    const x0 = Math.max(0, Math.floor(Math.min(...xs)));
    const x1 = Math.min(W, Math.ceil(Math.max(...xs)));
    const y0 = Math.max(0, Math.floor(Math.min(...ys)));
    const y1 = Math.min(H, Math.ceil(Math.max(...ys)));
    const cw = Math.max(1, x1 - x0), ch = Math.max(1, y1 - y0);
    const out = new Uint8ClampedArray(cw * ch * 4);
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      const si = ((y0 + y) * W + (x0 + x)) * 4, di = (y * cw + x) * 4;
      out[di] = data[si]; out[di + 1] = data[si + 1]; out[di + 2] = data[si + 2]; out[di + 3] = 255;
    }
    return { data: out, width: cw, height: ch };
  }
  const out = new Uint8ClampedArray(outW * outH * 4);
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const den = h[6] * x + h[7] * y + 1;
      const sx = (h[0] * x + h[1] * y + h[2]) / den;
      const sy = (h[3] * x + h[4] * y + h[5]) / den;
      // Clamp (edge-extend — hindari tepi hitam)
      const cx = Math.max(0, Math.min(W - 1, sx));
      const cy = Math.max(0, Math.min(H - 1, sy));
      const x0 = Math.floor(cx), y0 = Math.floor(cy);
      const x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1);
      const fx = cx - x0, fy = cy - y0;
      const o = (y * outW + x) * 4;
      for (let c = 0; c < 3; c++) {
        const p00 = data[(y0 * W + x0) * 4 + c];
        const p10 = data[(y0 * W + x1) * 4 + c];
        const p01 = data[(y1 * W + x0) * 4 + c];
        const p11 = data[(y1 * W + x1) * 4 + c];
        out[o + c] = (p00 * (1 - fx) + p10 * fx) * (1 - fy) +
                     (p01 * (1 - fx) + p11 * fx) * fy;
      }
      out[o + 3] = 255;
    }
  }
  return { data: out, width: outW, height: outH };
}

// ============================================================================
// FILTER ALA CAMSCANNER — teks tajam, elemen TIDAK hilang
// ============================================================================

/** Estimasi background per-channel: downscale (avg) → upscale bilinear. */
function estimateBg(img, div = 16) {
  const sw = Math.max(2, Math.round(img.width / div));
  const sh = Math.max(2, Math.round(img.height / div));
  const small = resizeImg(img, sw, sh);
  return resizeImg(small, img.width, img.height);
}

/** Median luminance dari sampling teratur (cepat). */
function medianLuma(img, brightOnly = 0) {
  const s = [];
  const step = Math.max(4, Math.round(Math.sqrt(img.width * img.height) / 96)) * 4;
  const d = img.data;
  for (let i = 0; i < d.length; i += step) {
    const l = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
    if (!brightOnly || l > brightOnly) s.push(l);
  }
  if (s.length === 0) return 128;
  s.sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function applyLut(img, lut) {
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = lut[d[i]]; d[i + 1] = lut[d[i + 1]]; d[i + 2] = lut[d[i + 2]];
  }
}

function saturate(img, k) {
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const avg = (d[i] + d[i + 1] + d[i + 2]) / 3;
    d[i] = Math.max(0, Math.min(255, avg + (d[i] - avg) * k));
    d[i + 1] = Math.max(0, Math.min(255, avg + (d[i + 1] - avg) * k));
    d[i + 2] = Math.max(0, Math.min(255, avg + (d[i + 2] - avg) * k));
  }
}

/** Unsharp mask ringan — teks crisp tanpa halo (radius 1, amount kecil). */
function unsharp(img, amount) {
  const { width: w, height: h } = img;
  const g = makeGray(img);
  const blur = boxBlurGray(g, w, h, 1);
  const d = img.data;
  for (let j = 0, i = 0; j < g.length; j++, i += 4) {
    const delta = g[j] - blur[j];
    for (let c = 0; c < 3; c++) {
      d[i + c] = Math.max(0, Math.min(255, d[i + c] + delta * amount));
    }
  }
}

/**
 * ENHANCE — default ala CamScanner "Enhance": kertas putih lembut, teks & warna
 * asli tajam. Aman utk foto gelap/bayangan TANPA menghapus elemen halus.
 *   1. Bg division adaptif (target dari median bg terang, bukan statis).
 *   2. Gamma auto (foto gelap diangkat, foto terang tidak over).
 *   3. Saturasi ringan 1.06 + unsharp 0.55.
 */
export function filterEnhance(img) {
  const bg = estimateBg(img, 16);
  // target adaptif: median bg terang → 0.96, clamp 215..240
  const bgMedian = medianLuma({ data: bg.data, width: bg.width, height: bg.height }, 100);
  const target = Math.min(240, Math.max(215, bgMedian * 0.96));
  const d = img.data, b = bg.data;
  for (let i = 0; i < d.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const bgc = Math.max(40, b[i + c]);
      d[i + c] = Math.min(255, (d[i + c] * target) / bgc);
    }
  }
  // Gamma auto: HANYA angkat foto gelap (median < 200) — jangan pernah
  // menggelapkan kertas yang sudah terang (kertas harus tetap ≥ 200).
  const med = medianLuma(img);
  let gamma = 1;
  if (med > 8 && med < 200) {
    gamma = Math.log(0.62) / Math.log(med / 255);
    gamma = Math.max(0.7, Math.min(1.0, gamma)); // 0.7..1.0 → hanya mencerahkan
  }
  if (Math.abs(gamma - 1) > 0.03) {
    const lut = new Uint8ClampedArray(256);
    for (let v = 0; v < 256; v++) lut[v] = 255 * Math.pow(v / 255, gamma);
    applyLut(img, lut);
  }
  saturate(img, 1.06);
  unsharp(img, 0.55);
  return img;
}

/**
 * MAGIC COLOR — kertas benar2 putih cerah, warna tinta/stamp hidup
 * (per-channel bg division × 225 — warna ASLI dipertahankan, beda dgn versi
 * lama yang jadi abu2).
 */
export function filterMagic(img) {
  const bg = estimateBg(img, 16);
  const d = img.data, b = bg.data;
  for (let i = 0; i < d.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const bgc = Math.max(40, b[i + c]);
      d[i + c] = Math.min(255, (d[i + c] * 225) / bgc);
    }
  }
  saturate(img, 1.22);
  // S-curve kontras ringan di sekitar 128
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) lut[v] = Math.max(0, Math.min(255, (v - 128) * 1.08 + 128));
  applyLut(img, lut);
  unsharp(img, 0.5);
  return img;
}

/** GRAY — grayscale + percentile stretch (1%..99%) → kontras maksimal. */
export function filterGray(img) {
  const g = makeGray(img);
  const hist = new Uint32Array(256);
  for (let j = 0; j < g.length; j++) hist[g[j]]++;
  const total = g.length;
  let acc = 0, lo = 0, hi = 255;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= total * 0.01) { lo = v; break; } }
  acc = 0;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= total * 0.01) { hi = v; break; } }
  if (hi - lo < 16) { lo = 0; hi = 255; }
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) lut[v] = Math.max(0, Math.min(255, ((v - lo) * 255) / (hi - lo)));
  applyLut(img, lut);
  return img;
}

/**
 * B&W (teks murni) — adaptive threshold box-blur.
 * PERBAIKAN dari versi lama (window 15px bikin teks hilang):
 *   - window = max(21, min(w,h)/20) → mean lokal mencakup ±belasan tebal stroke
 *   - soft ramp 24 level → anti-alias terjaga, teks TIDAK patah2
 *   - C = 10 (offset terhadap mean lokal)
 */
export function filterBW(img) {
  const { width: w, height: h } = img;
  const g = makeGray(img);
  let win = Math.max(21, Math.round(Math.min(w, h) / 20));
  if (win % 2 === 0) win += 1;
  const mean = boxBlurGray(g, w, h, (win - 1) >> 1);
  const d = img.data;
  const C = 10, RAMP = 24;
  for (let j = 0, i = 0; j < g.length; j++, i += 4) {
    const t = g[j] - (mean[j] - C);
    let v;
    if (t <= -RAMP / 2) v = 0;
    else if (t >= RAMP / 2) v = 255;
    else v = 255 * (t / RAMP + 0.5);
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  return img;
}

/** Kecerahan/Kontras: brightness -100..100, contrast -100..100 (LUT). */
export function applyAdjust(img, brightness, contrast) {
  if (!brightness && !contrast) return img;
  const b = (brightness || 0) * 0.7;
  const f = 1 + (contrast || 0) / 100 * 0.6;
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) lut[v] = Math.max(0, Math.min(255, (v - 128) * f + 128 + b));
  applyLut(img, lut);
  return img;
}

export const FILTERS = [
  { id: 'enhance', icon: '✨', label: 'Enhance' },
  { id: 'magic', icon: '🎨', label: 'Magic' },
  { id: 'original', icon: '🖼️', label: 'Asli' },
  { id: 'gray', icon: '🌗', label: 'Gray' },
  { id: 'bw', icon: '⚫', label: 'B&W' }
];

export function applyFilterImg(filterId, img) {
  if (filterId === 'enhance') return filterEnhance(img);
  if (filterId === 'magic') return filterMagic(img);
  if (filterId === 'gray') return filterGray(img);
  if (filterId === 'bw') return filterBW(img);
  return img; // original
}

// ============================================================================
// PANORAMA — template match SAD utk cari overlap antar frame
// ============================================================================

/**
 * Cari posisi overlap frame `next` terhadap akumulasi `prev`.
 * prev/next = { gray: Uint8Array, width, height } SKALA SAMA (caller resize).
 * Template = kolom kanan prev (lebar DI-CAP); dicari di sisi kiri next.
 *
 * v1.25.1 — 3 perbaikan atas laporan user "panorama gagal, cuma 1 foto":
 *   1. ZSAD (zero-mean SAD): skor |(p-mp)-(n-mn)| — KEBAL PERUBAHAN EXPOSURE
 *      (auto-exposure HP menggeser gain/offset antar frame; SAD mentah v1.25.0
 *      gagal total bahkan pada shift +8%).
 *   2. Lebar template DI-CAP: min(25% prev, 45% next, 150px) — dulu 25% × lebar
 *      akumulasi yang MEMBESAR TERUS → melampaui lebar frame baru → match mati
 *      permanen setelah beberapa frame.
 *   3. Rentang cari ox sampai 88% lebar frame (dulu 70% → overlap <30% tak
 *      pernah ketemu, malah terpilih posisi SALAH).
 *   + Guard: template terlalu polos (std < 14, dinding kosong) → null.
 * @returns {{overlap:number, dy:number, score:number} | null} overlap & dy
 *   dalam satuan piksel skala tersebut. null = tidak yakin cocok.
 */
export function matchPanorama(prev, next) {
  const pw = prev.width, ph = prev.height, nw = next.width, nh = next.height;
  const T = Math.max(36, Math.min(Math.round(pw * 0.25), Math.round(nw * 0.45), 150));
  if (T >= nw - 8 || ph < 40) return null;
  const maxOx = Math.min(nw - T, Math.round(nw * 0.88) - T);
  if (maxOx < 4) return null;
  const maxDy = Math.round(Math.min(ph, nh) * 0.15);
  const pg = prev.gray, ng = next.gray;

  // Mean template (dihitung sekali) + guard tekstur polos
  let tSum = 0, tCnt = 0;
  for (let ty = 0; ty < ph; ty += 2) {
    for (let tx = 0; tx < T; tx += 2) { tSum += pg[ty * pw + (pw - T + tx)]; tCnt++; }
  }
  const mp = tSum / Math.max(1, tCnt);
  let tVar = 0;
  for (let ty = 0; ty < ph; ty += 2) {
    for (let tx = 0; tx < T; tx += 2) { const d = pg[ty * pw + (pw - T + tx)] - mp; tVar += d * d; }
  }
  if (Math.sqrt(tVar / Math.max(1, tCnt)) < 14) return null; // dinding kosong

  function zsad(ox, oy) {
    // pass 1: mean frame kandidat (zero-mean buang gain/offset exposure)
    let sp = 0, sn = 0, cnt = 0;
    for (let ty = 0; ty < ph; ty += 2) {
      const ny = oy + ty;
      if (ny < 0 || ny >= nh) continue;
      for (let tx = 0; tx < T; tx += 2) {
        sp += pg[ty * pw + (pw - T + tx)];
        sn += ng[ny * nw + ox + tx];
        cnt++;
      }
    }
    if (cnt < tCnt * 0.6) return 999; // mayoritas template keluar frame
    const mn = sn / cnt;
    let sad = 0;
    for (let ty = 0; ty < ph; ty += 2) {
      const ny = oy + ty;
      if (ny < 0 || ny >= nh) continue;
      for (let tx = 0; tx < T; tx += 2) {
        const p = pg[ty * pw + (pw - T + tx)];
        const n = ng[ny * nw + ox + tx];
        sad += Math.abs((p - mp) - (n - mn));
      }
    }
    return sad / cnt;
  }

  const coarse = 2, fine = 1;
  let best = null;
  function scan(ox0, ox1, oy0, oy1, step, cur) {
    for (let ox = ox0; ox <= ox1; ox += step) {
      for (let oy = Math.max(-maxDy, oy0); oy <= Math.min(maxDy, oy1); oy += step) {
        const score = zsad(ox, oy);
        if (!cur || score < cur.score) cur = { ox, oy, score };
      }
    }
    return cur;
  }
  best = scan(0, maxOx, -maxDy, maxDy, coarse, null);
  if (!best || best.score >= 999) return null;
  best = scan(Math.max(0, best.ox - 3), Math.min(maxOx, best.ox + 3),
    best.oy - 3, best.oy + 3, fine, best);
  const overlap = Math.round(best.ox + T);
  const dy = Math.round(best.oy);
  if (Math.abs(dy) > maxDy) return null;
  if (best.score > 13) return null; // ZSAD: cocok ≈ 0-6; acak/beda scene ≈ >18
  return { overlap, dy, score: Math.round(best.score * 10) / 10 };
}

/** Area quad (shoelace) — diekspor utk uji. */
export { shoelaceArea as quadArea, isConvex as quadConvex, orderQuad as orderQuadPoints };
