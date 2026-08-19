// src/opencv-loader.js — Lazy load OpenCV.js (~8MB) untuk auto-detect tepi
// RecallFox PWA v1.4.0 — Fase 4: Auto-detect tepi kertas
//
// OpenCV.js hanya di-download saat user pertama kali buka mode Dokumen.
// Setelah loaded, di-cache di browser (cached by service worker).
//
// Sumber: jsdelivr CDN (https://cdn.jsdelivr.net/npm/opencv.js@1.2.1/opencv.js)
// docs.opencv.org return 403 di beberapa region, jsdelivr lebih reliable.

const OPENCV_URL = 'https://cdn.jsdelivr.net/npm/opencv.js@1.2.1/opencv.js';
let _loadPromise = null;
let _loaded = false;

/**
 * Load OpenCV.js. Idempotent — multiple calls return same promise.
 * @returns {Promise<typeof cv>} OpenCV.js module
 */
export function loadOpenCV() {
  if (_loaded && window.cv && window.cv.Mat) {
    return Promise.resolve(window.cv);
  }
  if (_loadPromise) return _loadPromise;

  _loadPromise = new Promise((resolve, reject) => {
    // Cek kalau script tag sudah ada
    const existing = document.getElementById('rf-opencv-script');
    if (existing && window.cv && window.cv.Mat) {
      _loaded = true;
      resolve(window.cv);
      return;
    }

    console.log('[RecallFox] Loading OpenCV.js (~8MB, first time only)...');
    const script = document.createElement('script');
    script.id = 'rf-opencv-script';
    script.src = OPENCV_URL;
    script.async = true;
    script.onload = () => {
      // OpenCV.js perlu inisialisasi — pakai callback 'onRuntimeInitialized'
      if (window.cv && typeof window.cv.then === 'function') {
        // v4.x: cv adalah Promise
        window.cv.then((cv) => {
          window.cv = cv;
          _loaded = true;
          console.log('[RecallFox] OpenCV.js loaded & initialized');
          resolve(cv);
        }).catch(reject);
      } else if (window.cv && window.cv.Mat) {
        _loaded = true;
        console.log('[RecallFox] OpenCV.js loaded (sync)');
        resolve(window.cv);
      } else if (window.cv && typeof window.cv.onRuntimeInitialized !== 'undefined') {
        // v3.x: pakai callback
        window.cv.onRuntimeInitialized = () => {
          _loaded = true;
          console.log('[RecallFox] OpenCV.js runtime initialized');
          resolve(window.cv);
        };
      } else {
        // Poll for Mat availability
        const checkReady = () => {
          if (window.cv && window.cv.Mat) {
            _loaded = true;
            console.log('[RecallFox] OpenCV.js ready (polled)');
            resolve(window.cv);
          } else {
            setTimeout(checkReady, 100);
          }
        };
        setTimeout(checkReady, 100);
      }
    };
    script.onerror = (e) => {
      console.error('[RecallFox] OpenCV.js load failed:', e);
      _loadPromise = null;
      reject(new Error('Failed to load OpenCV.js. Cek koneksi internet.'));
    };
    document.head.appendChild(script);
  });

  return _loadPromise;
}

/**
 * Cek apakah OpenCV sudah loaded.
 */
export function isOpenCVLoaded() {
  return _loaded && window.cv && !!window.cv.Mat;
}
