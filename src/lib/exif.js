// src/lib/exif.js — EXIF reader untuk GPS + timestamp dari foto galeri
// v1.8.0: Baca EXIF metadata saat upload dari galeri. Extract GPS lat/lng + DateTimeOriginal.
//
// Implementasi: manual parser untuk EXIF (Exchangeable Image File Format).
// Tidak pakai npm package (exifr 3KB) — implementasi sendiri lebih kecil (~6KB)
// dan cukup untuk kebutuhan kita (GPS + timestamp saja).
//
// Supported formats:
//   - JPEG (99% foto HP)
//   - TIFF (rare)
//   - HEIF/HEIC (Apple) — TIDAK didukung (butuh library terpisah)
//
// Output: { lat, lng, capturedAt } atau null jika tidak ada EXIF GPS.
// Kompatibel dengan location.js — bisa langsung dipakai sebagai source.location.

/**
 * Read EXIF GPS + timestamp dari File/Blob (gambar).
 * Returns { lat, lng, accuracy: 0, address: '', capturedAt } atau null.
 *
 * @param {File|Blob} file
 * @returns {Promise<{lat, lng, accuracy, address, capturedAt}|null>}
 */
export async function readExifLocation(file) {
  if (!file) return null;
  try {
    const buffer = await file.arrayBuffer();
    const view = new DataView(buffer);
    const exifData = parseExif(view);
    if (!exifData) return null;

    const lat = exifData.GPSLatitude;
    const lng = exifData.GPSLongitude;
    const capturedAt = exifData.DateTimeOriginal || exifData.DateTime;

    if (lat == null || lng == null) {
      // No GPS in EXIF — caller can fallback to live GPS
      if (capturedAt) {
        return { lat: null, lng: null, accuracy: 0, address: '', capturedAt };
      }
      return null;
    }

    return {
      lat,
      lng,
      accuracy: exifData.GPSAltitude != null ? 0 : 0,  // EXIF doesn't have accuracy
      address: '',  // Will be filled by reverseGeocode later (caller responsibility)
      capturedAt: capturedAt || new Date().toISOString()
    };
  } catch (e) {
    console.warn('[RecallFox] EXIF read error:', e.message);
    return null;
  }
}

// ===== Internal EXIF parser =====

function parseExif(view) {
  // Check JPEG SOI marker (0xFFD8)
  if (view.byteLength < 4) return null;
  if (view.getUint16(0, false) !== 0xFFD8) {
    // Not JPEG — try TIFF header
    return parseTiff(view, 0);
  }

  // JPEG: scan for APP1 marker (0xFFE1) which contains EXIF
  let offset = 2;
  while (offset < view.byteLength) {
    if (view.getUint8(offset) !== 0xFF) break;
    const marker = view.getUint8(offset + 1);
    const size = view.getUint16(offset + 2, false);

    if (marker === 0xE1) {  // APP1
      // Check "Exif\0\0" header (6 bytes after marker+size)
      const exifHeader = view.getUint32(offset + 4, false);
      if (exifHeader === 0x45786966) {  // "Exif"
        const tiffOffset = offset + 10;
        return parseTiff(view, tiffOffset);
      }
    }

    offset += 2 + size;
    if (offset >= view.byteLength) break;
  }
  return null;
}

function parseTiff(view, tiffOffset) {
  if (tiffOffset + 8 > view.byteLength) return null;

  // Read TIFF byte order
  const byteOrder = view.getUint16(tiffOffset, false);
  let littleEndian;
  if (byteOrder === 0x4949) {
    littleEndian = true;  // II (Intel) — little endian
  } else if (byteOrder === 0x4D4D) {
    littleEndian = false;  // MM (Motorola) — big endian
  } else {
    return null;
  }

  // Verify TIFF magic number (42)
  const magic = view.getUint16(tiffOffset + 2, littleEndian);
  if (magic !== 42) return null;

  // Read IFD0 offset
  const ifd0Offset = view.getUint32(tiffOffset + 4, littleEndian) + tiffOffset;
  const result = {};

  // Parse IFD0
  parseIfd(view, ifd0Offset, littleEndian, tiffOffset, result, new Set());

  return result;
}

function parseIfd(view, ifdOffset, littleEndian, tiffOffset, result, visited) {
  if (visited.has(ifdOffset)) return;  // anti-loop
  visited.add(ifdOffset);
  if (ifdOffset + 2 > view.byteLength) return;

  const entryCount = view.getUint16(ifdOffset, littleEndian);
  let entryOffset = ifdOffset + 2;

  for (let i = 0; i < entryCount; i++) {
    if (entryOffset + 12 > view.byteLength) break;

    const tag = view.getUint16(entryOffset, littleEndian);
    const type = view.getUint16(entryOffset + 2, littleEndian);
    const count = view.getUint32(entryOffset + 4, littleEndian);
    const valueOffset = entryOffset + 8;

    // Read value (or pointer if value > 4 bytes)
    const value = readValue(view, type, count, valueOffset, littleEndian, tiffOffset);

    // Tags we care about
    switch (tag) {
      case 0x8769:  // ExifIFDPointer
        if (typeof value === 'number') {
          parseIfd(view, value + tiffOffset, littleEndian, tiffOffset, result, visited);
        }
        break;
      case 0x9003:  // DateTimeOriginal
        if (typeof value === 'string') result.DateTimeOriginal = parseExifDate(value);
        break;
      case 0x0132:  // DateTime
        if (typeof value === 'string') result.DateTime = parseExifDate(value);
        break;
      case 0xA002:  // PixelXDimension
        if (typeof value === 'number') result.ImageWidth = value;
        break;
      case 0xA003:  // PixelYDimension
        if (typeof value === 'number') result.ImageHeight = value;
        break;
      case 0x8825:  // GPSInfoIFDPointer
        if (typeof value === 'number') {
          parseGpsIfd(view, value + tiffOffset, littleEndian, tiffOffset, result, visited);
        }
        break;
    }

    entryOffset += 12;
  }
}

function parseGpsIfd(view, ifdOffset, littleEndian, tiffOffset, result, visited) {
  if (visited.has(ifdOffset)) return;
  visited.add(ifdOffset);
  if (ifdOffset + 2 > view.byteLength) return;

  const entryCount = view.getUint16(ifdOffset, littleEndian);
  let entryOffset = ifdOffset + 2;
  const gpsData = {};

  for (let i = 0; i < entryCount; i++) {
    if (entryOffset + 12 > view.byteLength) break;
    const tag = view.getUint16(entryOffset, littleEndian);
    const type = view.getUint16(entryOffset + 2, littleEndian);
    const count = view.getUint32(entryOffset + 4, littleEndian);
    const valueOffset = entryOffset + 8;
    const value = readValue(view, type, count, valueOffset, littleEndian, tiffOffset);

    switch (tag) {
      case 1:  // GPSLatitudeRef (N/S)
        gpsData.latRef = typeof value === 'string' ? value : '';
        break;
      case 2:  // GPSLatitude (rational[3])
        if (Array.isArray(value) && value.length === 3) {
          gpsData.lat = convertGpsCoord(value);
        }
        break;
      case 3:  // GPSLongitudeRef (E/W)
        gpsData.lngRef = typeof value === 'string' ? value : '';
        break;
      case 4:  // GPSLongitude (rational[3])
        if (Array.isArray(value) && value.length === 3) {
          gpsData.lng = convertGpsCoord(value);
        }
        break;
      case 5:  // GPSAltitudeRef
        gpsData.altRef = value;
        break;
      case 6:  // GPSAltitude
        gpsData.alt = value;
        break;
    }
    entryOffset += 12;
  }

  if (gpsData.lat != null) {
    result.GPSLatitude = gpsData.latRef === 'S' ? -gpsData.lat : gpsData.lat;
  }
  if (gpsData.lng != null) {
    result.GPSLongitude = gpsData.lngRef === 'W' ? -gpsData.lng : gpsData.lng;
  }
  if (gpsData.alt != null) {
    result.GPSAltitude = gpsData.alt;
  }
}

function readValue(view, type, count, valueOffset, littleEndian, tiffOffset) {
  const typeSizes = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
  const typeSize = typeSizes[type] || 1;
  const totalBytes = typeSize * count;

  let dataOffset;
  if (totalBytes <= 4) {
    dataOffset = valueOffset;
  } else {
    dataOffset = view.getUint32(valueOffset, littleEndian) + tiffOffset;
  }

  if (dataOffset + totalBytes > view.byteLength) return null;

  switch (type) {
    case 1:  // BYTE
    case 7:  // UNDEFINED
      if (count === 1) return view.getUint8(dataOffset);
      return Array.from(new Uint8Array(view.buffer, dataOffset, count));
    case 2:  // ASCII
      let str = '';
      for (let i = 0; i < count; i++) {
        const c = view.getUint8(dataOffset + i);
        if (c === 0) break;
        str += String.fromCharCode(c);
      }
      return str;
    case 3:  // SHORT
      if (count === 1) return view.getUint16(dataOffset, littleEndian);
      const shorts = [];
      for (let i = 0; i < count; i++) shorts.push(view.getUint16(dataOffset + i * 2, littleEndian));
      return shorts;
    case 4:  // LONG
      if (count === 1) return view.getUint32(dataOffset, littleEndian);
      const longs = [];
      for (let i = 0; i < count; i++) longs.push(view.getUint32(dataOffset + i * 4, littleEndian));
      return longs;
    case 5:  // RATIONAL (2x LONG: numerator/denominator)
      const rationals = [];
      for (let i = 0; i < count; i++) {
        const num = view.getUint32(dataOffset + i * 8, littleEndian);
        const den = view.getUint32(dataOffset + i * 8 + 4, littleEndian);
        rationals.push(den === 0 ? 0 : num / den);
      }
      return count === 1 ? rationals[0] : rationals;
    case 9:  // SLONG
      if (count === 1) return view.getInt32(dataOffset, littleEndian);
      return null;
    case 10:  // SRATIONAL
      const srationals = [];
      for (let i = 0; i < count; i++) {
        const num = view.getInt32(dataOffset + i * 8, littleEndian);
        const den = view.getInt32(dataOffset + i * 8 + 4, littleEndian);
        srationals.push(den === 0 ? 0 : num / den);
      }
      return count === 1 ? srationals[0] : srationals;
  }
  return null;
}

function convertGpsCoord(rational) {
  // rational = [degrees, minutes, seconds]
  if (!Array.isArray(rational) || rational.length !== 3) return 0;
  return rational[0] + (rational[1] / 60) + (rational[2] / 3600);
}

function parseExifDate(dateStr) {
  // EXIF date format: "YYYY:MM:DD HH:MM:SS"
  if (!dateStr || typeof dateStr !== 'string') return null;
  const m = dateStr.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}
