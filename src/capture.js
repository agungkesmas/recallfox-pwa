// src/capture.js — Camera / Gallery / Paste handlers
// v1.8.0: Capture GPS saat ambil foto + baca EXIF dari galeri.
//
// Strategy:
//   - Camera capture: ambil GPS live via navigator.geolocation, reverse geocode via Nominatim.
//   - Gallery upload: baca EXIF GPS + DateTimeOriginal dari file.
//   - Paste from clipboard: tidak ada GPS (clipboard tidak punya metadata).
//
// Output: tetap { dataUrl, width, height } (backward compat) +
//         tambah { location } untuk disimpan ke item.source.location.

import { captureLocation } from './lib/location.js';
import { readExifLocation } from './lib/exif.js';
import { reverseGeocode } from './lib/location.js';

/**
 * Pick image from camera or gallery.
 * v1.8.0: Sekaligus capture GPS (camera) atau baca EXIF (gallery).
 *
 * @param {'camera'|'gallery'} source
 * @returns {Promise<{dataUrl: string, width: number, height: number, location: Object|null, file: File|null}|null>}
 */
export function pickImage(source) {
  return new Promise(async (resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    if (source === 'camera') {
      input.capture = 'environment';
    }
    input.multiple = false;
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) { resolve(null); return; }

      // v1.8.0: Baca EXIF GPS + timestamp (untuk gallery upload)
      let exifLocation = null;
      if (source === 'gallery') {
        exifLocation = await readExifLocation(file);
        if (exifLocation) {
          console.log('[RecallFox] EXIF location:', exifLocation.lat, exifLocation.lng);
        }
      }

      // v1.8.0: Untuk camera capture, ambil GPS live (parallel dengan image load)
      let liveLocationPromise = null;
      if (source === 'camera') {
        liveLocationPromise = captureLocation();
      }

      const reader = new FileReader();
      reader.onload = async () => {
        const dataUrl = reader.result;
        const img = new Image();
        img.onload = async () => {
          // Tunggu GPS live (kalau ada)
          let liveLocation = null;
          if (liveLocationPromise) {
            liveLocation = await liveLocationPromise;
          }

          // Pilih location: prioritas EXIF (kalau ada), fallback live GPS
          let location = exifLocation;
          if (!location && liveLocation) {
            location = liveLocation;
          } else if (location && location.lat != null && location.lng != null && !location.address) {
            // EXIF punya GPS tapi tidak ada address → reverse geocode
            const address = await reverseGeocode(location.lat, location.lng);
            if (address) location.address = address;
          }

          resolve({
            dataUrl,
            width: img.naturalWidth,
            height: img.naturalHeight,
            location,
            file
          });
        };
        img.onerror = () => resolve({
          dataUrl,
          width: 0,
          height: 0,
          location: exifLocation || null,
          file
        });
        img.src = dataUrl;
      };
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    };
    input.click();
  });
}

/**
 * Paste image from clipboard.
 * v1.8.0: Tidak ada GPS metadata di clipboard, return location=null.
 *
 * @returns {Promise<{dataUrl: string, width: number, height: number, location: null, file: null}|null>}
 */
export async function pasteFromClipboard() {
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      for (const type of item.types) {
        if (type.startsWith('image/')) {
          const blob = await item.getType(type);
          const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error('read_failed'));
            reader.readAsDataURL(blob);
          });
          const img = new Image();
          return new Promise((resolve2) => {
            img.onload = () => resolve2({
              dataUrl,
              width: img.naturalWidth,
              height: img.naturalHeight,
              location: null,  // clipboard tidak punya metadata
              file: null
            });
            img.onerror = () => resolve2({
              dataUrl,
              width: 0,
              height: 0,
              location: null,
              file: null
            });
            img.src = dataUrl;
          });
        }
      }
    }
    return null;
  } catch (e) {
    return null;
  }
}
