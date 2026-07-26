// src/edge-detect.js — Auto-detect 4 sudut kertas + perspective warp
// RecallFox PWA v1.4.0 — Fase 4: CamScanner-like auto-crop
//
// Algoritma:
//   1. Load image ke cv.Mat
//   2. Convert ke grayscale + blur (hilangkan noise)
//   3. Canny edge detection
//   4. findContours — cari kontur terbesar yang approxPolyDP jadi 4 sudut
//   5. Order 4 sudut: top-left, top-right, bottom-right, bottom-left
//   6. getPerspectiveTransform + warpPerspective → rectangle sempurna
//
// Fallback kalau auto-detect gagal: return null, caller pakai 4 sudut default
// (full image) supaya user bisa adjust manual.

import { loadOpenCV } from './opencv-loader.js';

/**
 * Auto-detect 4 sudut kertas dari foto.
 * @param {string} dataUrl - input image data URL
 * @returns {Promise<{points: [{x,y},{x,y},{x,y},{x,y}], width: number, height: number} | null>}
 *   points[0] = top-left, points[1] = top-right, points[2] = bottom-right, points[3] = bottom-left
 *   null = auto-detect gagal, caller pakai default (full image)
 */
export async function autoDetectEdges(dataUrl) {
  try {
    const cv = await loadOpenCV();

    // Load image ke cv.Mat via HTMLImageElement
    const img = await loadImage(dataUrl);
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext('2d').drawImage(img, 0, 0);
    const mat = cv.imread(canvas);

    // Downscale untuk faster processing (max 800px on longest side)
    const maxDim = 800;
    const scale = Math.min(maxDim / mat.cols, maxDim / mat.rows, 1);
    let workingMat = mat;
    if (scale < 1) {
      const small = new cv.Mat();
      const dsize = new cv.Size(Math.round(mat.cols * scale), Math.round(mat.rows * scale));
      cv.resize(mat, small, dsize, 0, 0, cv.INTER_AREA);
      workingMat = small;
    }

    // Convert ke grayscale
    const gray = new cv.Mat();
    cv.cvtColor(workingMat, gray, cv.COLOR_RGBA2GRAY);

    // Gaussian blur (5x5)
    const blurred = new cv.Mat();
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);

    // Canny edge detection
    const edges = new cv.Mat();
    cv.Canny(blurred, edges, 75, 200);

    // Dilate supaya edges connected
    const kernel = cv.Mat.ones(3, 3, cv.CV_8U);
    const dilated = new cv.Mat();
    cv.dilate(edges, dilated, kernel, new cv.Point(-1, -1), 1);

    // findContours
    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    cv.findContours(dilated, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

    // Cari kontur terbesar yang approxPolyDP jadi 4 sudut
    let bestQuad = null;
    let maxArea = 0;
    for (let i = 0; i < contours.size(); i++) {
      const cnt = contours.get(i);
      const area = cv.contourArea(cnt);
      if (area < 5000) continue; // skip kontur kecil (noise)
      if (area < maxArea) continue;

      const peri = cv.arcLength(cnt, true);
      const approx = new cv.Mat();
      cv.approxPolyDP(cnt, approx, 0.02 * peri, true);

      if (approx.rows === 4) {
        maxArea = area;
        bestQuad = [];
        for (let j = 0; j < 4; j++) {
          bestQuad.push({
            x: approx.data32S[j * 2],
            y: approx.data32S[j * 2 + 1]
          });
        }
      }
      approx.delete();
      cnt.delete();
    }

    // Cleanup mats
    mat.delete();
    if (workingMat !== mat) workingMat.delete();
    gray.delete();
    blurred.delete();
    edges.delete();
    kernel.delete();
    dilated.delete();
    contours.delete();
    hierarchy.delete();

    if (!bestQuad) {
      console.log('[RecallFox] autoDetectEdges: no quad contour found');
      return null;
    }

    // Order points: TL, TR, BR, BL
    const ordered = orderPoints(bestQuad);

    // Scale balik ke original coords
    const invScale = 1 / scale;
    const points = ordered.map(p => ({
      x: Math.round(p.x * invScale),
      y: Math.round(p.y * invScale)
    }));

    // Compute target width/height (max of opposite sides)
    const wTop = dist(points[0], points[1]);
    const wBot = dist(points[3], points[2]);
    const hLeft = dist(points[0], points[3]);
    const hRight = dist(points[1], points[2]);
    const width = Math.max(wTop, wBot);
    const height = Math.max(hLeft, hRight);

    console.log('[RecallFox] autoDetectEdges: OK', { width, height, points });
    return { points, width, height };
  } catch (e) {
    console.error('[RecallFox] autoDetectEdges failed:', e.message);
    return null;
  }
}

/**
 * Perspective warp: crop segiempat dengan 4 sudut → rectangle sempurna.
 * @param {string} dataUrl - input image data URL
 * @param {Array<{x,y}>} points - 4 sudut [TL, TR, BR, BL]
 * @param {number} targetWidth
 * @param {number} targetHeight
 * @returns {Promise<string>} warped image data URL (PNG)
 */
export async function warpPerspective(dataUrl, points, targetWidth, targetHeight) {
  try {
    const cv = await loadOpenCV();
    const img = await loadImage(dataUrl);
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext('2d').drawImage(img, 0, 0);
    const src = cv.imread(canvas);

    // Source points (4 sudut asli)
    const srcPoints = [];
    points.forEach(p => srcPoints.push(p.x, p.y));
    const srcMat = cv.matFromArray(4, 1, cv.CV_32FC2, srcPoints);

    // Destination points (rectangle 0,0 → w,h)
    const dstMat = cv.matFromArray(4, 1, cv.CV_32FC2, [
      0, 0,
      targetWidth, 0,
      targetWidth, targetHeight,
      0, targetHeight
    ]);

    // Get perspective transform matrix
    const M = cv.getPerspectiveTransform(srcMat, dstMat);

    // Warp
    const dst = new cv.Mat();
    const dsize = new cv.Size(targetWidth, targetHeight);
    cv.warpPerspective(src, dst, M, dsize, cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar());

    // Output ke canvas → dataUrl
    const outCanvas = document.createElement('canvas');
    outCanvas.width = targetWidth;
    outCanvas.height = targetHeight;
    cv.imshow(outCanvas, dst);
    const outDataUrl = outCanvas.toDataURL('image/png');

    // Cleanup
    src.delete();
    srcMat.delete();
    dstMat.delete();
    M.delete();
    dst.delete();

    return outDataUrl;
  } catch (e) {
    console.error('[RecallFox] warpPerspective failed:', e.message);
    // Fallback: pakai axis-aligned crop dari bounding box
    return await axisAlignedCrop(dataUrl, points);
  }
}

/**
 * Fallback: axis-aligned crop (kalau warpPerspective gagal).
 */
async function axisAlignedCrop(dataUrl, points) {
  const img = await loadImage(dataUrl);
  const xs = points.map(p => p.x);
  const ys = points.map(p => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const w = maxX - minX;
  const h = maxY - minY;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(img, minX, minY, w, h, 0, 0, w, h);
  return canvas.toDataURL('image/png');
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

function dist(a, b) {
  return Math.round(Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2));
}

/**
 * Order 4 points: TL, TR, BR, BL.
 * Algorithm: sum(x+y) min = TL, max = BR; diff(y-x) min = BL, max = TR.
 */
function orderPoints(pts) {
  const sorted = [...pts];
  sorted.sort((a, b) => (a.x + a.y) - (b.x + b.y));
  const tl = sorted[0];
  const br = sorted[3];
  // Dari 2 sisanya, diff (y - x) min = BL, max = TR
  const rest = [sorted[1], sorted[2]];
  rest.sort((a, b) => (a.y - a.x) - (b.y - b.x));
  const bl = rest[0];
  const tr = rest[1];
  return [tl, tr, br, bl];
}
