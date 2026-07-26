// src/lib/location.js — GPS capture + Nominatim reverse geocoding
// v1.8.0: Capture GPS saat ambil foto, simpan ke item.source.location.
// Reverse geocoding via OpenStreetMap Nominatim API (gratis, no API key).
//
// Schema disimpan di item.source.location:
//   {
//     lat: number,
//     lng: number,
//     accuracy: number (meters),
//     address: string (reverse geocoded),
//     capturedAt: ISO string
//   }
//
// Kompatibel dengan addon: addon baca source.location → tampilkan "📍 alamat" di item card.

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/reverse';
const NOMINATIM_TIMEOUT_MS = 8000;

/**
 * Get current GPS position via navigator.geolocation.
 * Returns null if geolocation unavailable or user denies permission.
 */
export function getCurrentPosition(timeout = 10000, enableHighAccuracy = true) {
  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      console.warn('[RecallFox] Geolocation not available');
      resolve(null);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        resolve({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy || 0
        });
      },
      (err) => {
        console.warn('[RecallFox] Geolocation error:', err.message, '(code:', err.code + ')');
        resolve(null);
      },
      { enableHighAccuracy, timeout, maximumAge: 60000 }
    );
  });
}

/**
 * Reverse geocode lat/lng → human-readable address via Nominatim.
 * Returns null if request fails or address not found.
 */
export async function reverseGeocode(lat, lng) {
  if (lat == null || lng == null) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NOMINATIM_TIMEOUT_MS);
  try {
    const url = `${NOMINATIM_URL}?format=json&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`;
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'Accept-Language': 'id,en' }
    });
    clearTimeout(timer);
    if (!res.ok) {
      console.warn('[RecallFox] Nominatim HTTP', res.status);
      return null;
    }
    const data = await res.json();
    if (!data) return null;
    const a = data.address || {};
    const parts = [];
    if (a.road) parts.push(a.road);
    if (a.neighbourhood) parts.push(a.neighbourhood);
    if (a.suburb) parts.push(a.suburb);
    if (a.village) parts.push(a.village);
    if (a.town) parts.push(a.town);
    if (a.city) parts.push(a.city);
    if (a.state) parts.push(a.state);
    if (parts.length === 0 && data.display_name) {
      return data.display_name;
    }
    return parts.join(', ');
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') {
      console.warn('[RecallFox] Nominatim timeout');
    } else {
      console.warn('[RecallFox] Nominatim error:', e.message);
    }
    return null;
  }
}

/**
 * Capture location: get GPS position + reverse geocode.
 * Returns location object ready for item.source.location, or null if both fail.
 */
export async function captureLocation() {
  const pos = await getCurrentPosition();
  if (!pos) return null;
  const capturedAt = new Date().toISOString();
  const address = await reverseGeocode(pos.lat, pos.lng);
  return {
    lat: pos.lat,
    lng: pos.lng,
    accuracy: pos.accuracy,
    address: address || '',
    capturedAt
  };
}

/**
 * Format location untuk display di item card.
 * Returns "📍 alamat" atau "📍 lat, lng" atau "" jika no location.
 */
export function formatLocation(location) {
  if (!location) return '';
  if (location.address) {
    return '📍 ' + location.address;
  }
  if (location.lat != null && location.lng != null) {
    return `📍 ${location.lat.toFixed(6)}, ${location.lng.toFixed(6)}`;
  }
  return '';
}

/**
 * Format location dengan timestamp untuk display.
 */
export function formatLocationWithTime(location) {
  if (!location) return '';
  const loc = formatLocation(location);
  if (!loc) return '';
  let time = '';
  if (location.capturedAt) {
    try {
      time = ' · Waktu: ' + new Date(location.capturedAt).toLocaleString('id-ID', {
        dateStyle: 'medium',
        timeStyle: 'short'
      });
    } catch (e) {}
  }
  return loc + time;
}
