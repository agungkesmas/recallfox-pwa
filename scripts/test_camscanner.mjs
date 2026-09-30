// scripts/test_camscanner.mjs — Uji unit cam-ops.js (v1.25.0)
// Jalankan: node scripts/test_camscanner.mjs
// Semua fungsi pure → tanpa DOM/browser.

import {
  makeGray, boxBlurGray, sobelMag, resizeImg,
  detectQuad, defaultQuad, solveHomography, warpQuad,
  filterEnhance, filterMagic, filterGray, filterBW, applyAdjust,
  matchPanorama, quadArea, quadConvex
} from '../src/cam-ops.js';

let pass = 0, fail = 0;
function ok(cond, name, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name} ${extra}`); }
}
function section(s) { console.log(`\n== ${s} ==`); }

// ---------- helper: gambar sintetis ----------
function newImg(w, h, fill) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const v = typeof fill === 'function' ? fill(i % w, Math.floor(i / w)) : fill;
    const t = Array.isArray(v) ? v : [v, v, v];
    data[i * 4] = t[0]; data[i * 4 + 1] = t[1]; data[i * 4 + 2] = t[2]; data[i * 4 + 3] = 255;
  }
  return { data, width: w, height: h };
}
let rngState = 42;
function rnd() { rngState = (rngState * 1103515245 + 12345) & 0x7fffffff; return rngState / 0x7fffffff; }

function inQuad(q, x, y) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4];
    const cr = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
    if (i === 0) sign = Math.sign(cr);
    else if (Math.sign(cr) !== sign) return false;
  }
  return true;
}
function distToQuadEdge(q, x, y) {
  let best = Infinity;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4];
    const dx = b.x - a.x, dy = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy)));
    best = Math.min(best, Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy)));
  }
  return best;
}

// ---------- 1. util dasar ----------
section('UTIL DASAR');
{
  const img = newImg(4, 4, [255, 0, 0]);
  const g = makeGray(img);
  ok(g[0] === 76 && g[15] === 76, 'makeGray: merah murni ≈ 76');
  const flat = newImg(50, 40, [120, 120, 120]);
  const gb = boxBlurGray(makeGray(flat), 50, 40, 3);
  ok(gb.every(v => v === 120), 'boxBlurGray: gambar rata tetap rata');
  const mag = sobelMag(makeGray(flat), 50, 40);
  ok(mag.every(v => v === 0), 'sobelMag: gambar rata → 0');
  const rs = resizeImg(flat, 25, 20);
  ok(rs.width === 25 && rs.height === 20 && rs.data[0] === 120, 'resizeImg: dimensi + nilai rata');
}

// ---------- 2. deteksi quad ----------
section('DETEKSI QUAD DOKUMEN');
{
  const W = 240, H = 180;
  const TRUE = [
    { x: 40, y: 35 }, { x: 200, y: 30 }, { x: 205, y: 150 }, { x: 35, y: 155 }
  ];
  const img = newImg(W, H, (x, y) => {
    const n = (rnd() - 0.5) * 14;
    if (distToQuadEdge(TRUE, x, y) < 1.6) {
      const v = 28 + n; return [v, v, v]; // garis tepi gelap (bayangan kertas)
    }
    if (inQuad(TRUE, x, y)) {
      const shade = 205 + ((x + y) % 7) * 2 + n; // kertas dgn pencahayaan tak rata
      // "teks" gelap acak di dalam kertas
      const text = ((x * 7 + y * 13) % 53 === 0 && x % 3 !== 0) ? -120 : 0;
      const v = Math.max(0, shade + text);
      return [v, v, v];
    }
    const v = 45 + n + ((x * 3 + y * 5) % 23); // latar meja bertekstur
    return [v, v * 0.95, v * 0.9];
  });
  const res = detectQuad(img);
  ok(!!res, 'detectQuad: quad terdeteksi pada foto sintetis', JSON.stringify(res));
  if (res) {
    const pts = res.points;
    // cocokkan ke TRUE dgn nearest (urutan bisa beda label tapi orderQuad konsisten TL,TR,BR,BL)
    let maxErr = 0;
    for (const p of pts) {
      const d = Math.min(...TRUE.map(t => Math.hypot(p.x - t.x, p.y - t.y)));
      maxErr = Math.max(maxErr, d);
    }
    ok(maxErr <= 9, `detectQuad: sudut dekat kebenaran (maxErr=${maxErr.toFixed(1)}px ≤ 9)`);
    ok(res.confidence > 0.4, `detectQuad: confidence cukup (${res.confidence.toFixed(2)})`);
    // warp pakai hasil deteksi → hasil harus hampir semua terang (kertas)
    const wq = warpQuad(img, pts, 800);
    let bright = 0, tot = wq.width * wq.height;
    for (let i = 0; i < tot; i++) {
      const l = (wq.data[i * 4] + wq.data[i * 4 + 1] + wq.data[i * 4 + 2]) / 3;
      if (l > 150) bright++;
    }
    const ratio = bright / tot;
    ok(ratio > 0.85, `warpQuad(dari deteksi): ≥85% piksel kertas terang (${(ratio * 100).toFixed(1)}%)`);
    ok(Math.max(wq.width, wq.height) <= 800, 'warpQuad: cap sisi panjang dihormati');
  }
  // gagal → null pada gambar polos tanpa dokumen
  const plain = newImg(200, 150, (x, y) => {
    const v = 90 + ((x * 5 + y * 9) % 17) + (rnd() - 0.5) * 10;
    return [v, v, v];
  });
  const r2 = detectQuad(plain);
  ok(r2 === null || r2.areaRatio > 0.98, 'detectQuad: tanpa dokumen → null / fullframe');
  ok(defaultQuad(100, 80).length === 4, 'defaultQuad: 4 titik');
}

// ---------- 3. homography ----------
section('HOMOGRAPHY & WARP');
{
  const dst = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 80 }, { x: 0, y: 80 }];
  const src = [{ x: 10, y: 5 }, { x: 110, y: 5 }, { x: 110, y: 85 }, { x: 10, y: 85 }];
  const h = solveHomography(src, dst);
  ok(!!h, 'solveHomography: terpecahkan');
  if (h) {
    const proj = (x, y) => {
      const den = h[6] * x + h[7] * y + 1;
      return [(h[0] * x + h[1] * y + h[2]) / den, (h[3] * x + h[4] * y + h[5]) / den];
    };
    const [px, py] = proj(0, 0);
    ok(Math.abs(px - 10) < 1e-6 && Math.abs(py - 5) < 1e-6, `solveHomography: (0,0)→(10,5) [${px.toFixed(4)},${py.toFixed(4)}]`);
    const [px2, py2] = proj(100, 80);
    ok(Math.abs(px2 - 110) < 1e-6 && Math.abs(py2 - 85) < 1e-6, 'solveHomography: (100,80)→(110,85)');
  }
  // warp: potret miring → tegak
  const W = 300, H = 240;
  const quad = [{ x: 60, y: 30 }, { x: 250, y: 45 }, { x: 235, y: 210 }, { x: 45, y: 195 }];
  const img = newImg(W, H, (x, y) => inQuad(quad, x, y) ? [220, 220, 220] : [40, 40, 40]);
  const out = warpQuad(img, quad, 2000);
  ok(out.width > 150 && out.height > 120, `warpQuad: output ukuran wajar (${out.width}×${out.height})`);
  let bright = 0;
  for (let i = 0; i < out.width * out.height; i++) {
    const l = (out.data[i * 4] + out.data[i * 4 + 1] + out.data[i * 4 + 2]) / 3;
    if (l > 150) bright++;
  }
  ok(bright / (out.width * out.height) > 0.97, `warpQuad: kertas penuh frame (${(bright / (out.width * out.height) * 100).toFixed(1)}%)`);
  const capped = warpQuad(img, quad, 100);
  ok(Math.max(capped.width, capped.height) <= 100, 'warpQuad: cap 100px dihormati');
}

// ---------- 4. filter ----------
section('FILTER CAMSCANNER (teks terbaca, elemen tidak hilang)');
{
  // dokumen sintetis: kertas abu (170) + bayangan kiri (120) + teks hitam tipis (30)
  const W = 400, H = 300;
  const img = newImg(W, H, (x, y) => {
    if ((x * 3 + y * 11) % 41 === 0) return [30, 30, 30];             // stroke teks
    const shade = x < W * 0.3 ? 120 : 170;                            // bayangan kiri
    const v = shade + (rnd() - 0.5) * 6;
    return [v, v, v];
  });
  const before = makeGray(img);
  let textBefore = 0, bgBefore = 0;
  for (let j = 0; j < before.length; j++) { if (before[j] < 60) textBefore++; else bgBefore++; }

  const e = newImg(W, H, (x, y) => img.data[(y * W + x) * 4]);
  filterEnhance(e);
  const ge = makeGray(e);
  let textSurv = 0, bgBright = 0, bgCnt = 0;
  for (let j = 0; j < ge.length; j++) {
    if (before[j] < 60) { if (ge[j] < 150) textSurv++; }
    else { bgCnt++; if (ge[j] > 200) bgBright++; }
  }
  ok(textSurv / Math.max(1, textBefore) > 0.97, `filterEnhance: stroke teks selamat ${(textSurv / textBefore * 100).toFixed(1)}% (tidak hilang)`);
  ok(bgBright / bgCnt > 0.7, `filterEnhance: kertas jadi terang (${(bgBright / bgCnt * 100).toFixed(1)}% > 200)`);

  // B&W
  const b = newImg(W, H, (x, y) => img.data[(y * W + x) * 4]);
  filterBW(b);
  const gb = makeGray(b);
  let bText = 0, bBg = 0, bMid = 0;
  for (let j = 0; j < gb.length; j++) {
    if (before[j] < 60) { if (gb[j] < 64) bText++; }
    else { if (gb[j] > 191) bBg++; else if (gb[j] >= 64) bMid++; }
  }
  ok(bText / Math.max(1, textBefore) > 0.95, `filterBW: teks jadi hitam (${(bText / textBefore * 100).toFixed(1)}%)`);
  ok(bBg / bgCnt > 0.9, `filterBW: kertas jadi putih (${(bBg / bgCnt * 100).toFixed(1)}%)`);

  // Gray: kontras naik
  const g2 = newImg(W, H, (x, y) => img.data[(y * W + x) * 4]);
  filterGray(g2);
  const gg = makeGray(g2);
  let mn = 255, mx = 0;
  for (let j = 0; j < gg.length; j++) { mn = Math.min(mn, gg[j]); mx = Math.max(mx, gg[j]); }
  ok(mx - mn > 180, `filterGray: range stretch (${mn}..${mx})`);

  // Magic: warna asli dipertahankan (teks merah tetap merah, bukan jadi abu)
  const MW = 200, MH = 160;
  const isRed = (x, y) => (x * 5 + y * 7) % 37 === 0;
  const cm = newImg(MW, MH, (x, y) => isRed(x, y) ? [180, 40, 40] : [150 + (rnd() - 0.5) * 8, 150, 150]);
  filterMagic(cm);
  let redOk = 0, redCnt = 0;
  for (let y = 0; y < MH; y++) for (let x = 0; x < MW; x++) {
    if (!isRed(x, y)) continue;
    redCnt++;
    const i = (y * MW + x) * 4;
    const r = cm.data[i], g = cm.data[i + 1], b2 = cm.data[i + 2];
    if (r > g + 20 && r > b2 + 20) redOk++;
  }
  ok(redCnt > 50 && redOk / redCnt > 0.8, `filterMagic: tinta merah tetap dominan merah (${redOk}/${redCnt})`);

  // applyAdjust
  const a1 = newImg(50, 50, [100, 100, 100]);
  applyAdjust(a1, 50, 0);
  ok(a1.data[0] > 120, `applyAdjust: brightness +50 menaikkan (${a1.data[0]})`);
  const a2 = newImg(50, 50, [100, 100, 100]);
  applyAdjust(a2, 0, 0);
  ok(a2.data[0] === 100, 'applyAdjust: 0/0 tidak mengubah');
}

// ---------- 5. panorama match ----------
section('PANORAMA TEMPLATE MATCH');
{
  const PW = 220, PH = 120, NW = 200, NH = 120;
  const T = Math.round(PW * 0.25); // 55
  const OX = 60, DY = 4;
  const prevArr = new Uint8Array(PW * PH);
  for (let i = 0; i < prevArr.length; i++) prevArr[i] = (i * 37) % 256; // tekstur
  const nextArr = new Uint8Array(NW * NH);
  for (let y = 0; y < NH; y++) {
    for (let x = 0; x < NW; x++) {
      // area template: kolom [OX .. OX+T) = kolom kanan prev, digeser DY
      const srcX = x - OX + (PW - T);
      const srcY = y - DY;
      if (x >= OX && x < OX + T && srcY >= 0 && srcY < PH) {
        nextArr[y * NW + x] = prevArr[srcY * PW + srcX];
      } else {
        nextArr[y * NW + x] = (x * 91 + y * 13) % 256; // pemandangan baru
      }
    }
  }
  const m = matchPanorama(
    { gray: prevArr, width: PW, height: PH },
    { gray: nextArr, width: NW, height: NH }
  );
  ok(!!m, 'matchPanorama: match ditemukan', JSON.stringify(m));
  if (m) {
    ok(Math.abs(m.overlap - (OX + T)) <= 4, `matchPanorama: overlap benar (dapat ${m.overlap}, harap ${OX + T}, tol 4)`);
    ok(Math.abs(m.dy - DY) <= 3, `matchPanorama: dy benar (dapat ${m.dy}, harap ${DY}, tol 3)`);
    ok(m.score < 12, `matchPanorama: score kecil (${m.score})`);
  }
  // tidak cocok → null
  const junk = new Uint8Array(NW * NH);
  for (let i = 0; i < junk.length; i++) junk[i] = (i * 71 + 11) % 256;
  const m2 = matchPanorama(
    { gray: prevArr, width: PW, height: PH },
    { gray: junk, width: NW, height: NH }
  );
  ok(m2 === null || m2.score > 22, 'matchPanorama: tekstur acak → null / score buruk');
}

// ---------- 6. util quad ----------
section('UTIL QUAD');
{
  const sq = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
  ok(quadArea(sq) === 100, 'quadArea: persegi 10×10 = 100');
  ok(quadConvex(sq) === true, 'quadConvex: persegi convex');
  const bow = [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 10, y: 0 }, { x: 0, y: 10 }];
  ok(quadConvex(bow) === false, 'quadConvex: bowtie terdeteksi tak convex');
}

console.log(`\n========================================`);
console.log(`TOTAL: ${pass} PASS, ${fail} FAIL dari ${pass + fail}`);
process.exit(fail > 0 ? 1 : 0);
