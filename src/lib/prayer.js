// src/lib/prayer.js — Waktu Shalat & puasa sunnah untuk PWA (v1.17.0)
//
// Port fitur addon (Waktu Shalat + Puasa Sunnah) ke PWA dengan model strip
// STICKY ala popup addon: bar ringkas selalu terlihat di semua halaman.
//
// Perbedaan dengan addon:
//   - Addon menyimpan settings di vault.settings + cache jadwal di
//     storage.local; PWA tidak punya vault.settings → settings disimpan di
//     localStorage (pola konsisten PWA: key `rf_*` per-device, lihat
//     focus.js/notes.js).
//   - Addon fetch lewat background script (anti CORS halaman); PWA fetch
//     langsung — api.aladhan.com & nominatim.openstreetmap.org keduanya
//     mengirim header CORS `*`.
//
// Storage shape (localStorage `rf_prayer_settings_v1`):
//   {
//     enabled:      boolean,
//     lat, lng:     number|null,
//     location:     string (nama kota hasil reverse-geocode / pencarian),
//     timeFormat:   '24h' | '12h',
//     cachedTimes:  { date, hijri, timings{Fajr..Imsak,Firstthird,...},
//                     timezone, method } — bentuk sama dengan addon,
//     cachedAt:     ISO string
//   }

import { fetchPrayerTimes, getNextPrayerIncludingSunnah } from './salahtime.js';
import { getUpcomingFasts, parseHijriString } from './islamicCalendar.js';

const SETTINGS_KEY = 'rf_prayer_settings_v1';
const DISMISS_KEY = 'rf_prayer_strip_dismissed_v1';

export function defaultPrayerSettings() {
  return {
    enabled: false,
    lat: null,
    lng: null,
    location: '',
    timeFormat: '24h',       // '24h' | '12h'
    cachedTimes: null,
    cachedAt: null
  };
}

export function loadPrayerSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return defaultPrayerSettings();
    return { ...defaultPrayerSettings(), ...JSON.parse(raw) };
  } catch (e) {
    return defaultPrayerSettings();
  }
}

export function savePrayerSettings(s) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (e) {}
  // Beri tahu strip sticky (dan view lain) bahwa settings/cache berubah
  try { window.dispatchEvent(new CustomEvent('rf-prayer-updated')); } catch (e) {}
}

// User bisa menutup chip "Aktifkan Waktu Shalat" di strip (kalau memang
// tidak berminat) — jangan dipaksa tampil terus.
export function isStripDismissed() {
  try { return localStorage.getItem(DISMISS_KEY) === '1'; } catch (e) { return false; }
}
export function dismissStrip() {
  try { localStorage.setItem(DISMISS_KEY, '1'); } catch (e) {}
  try { window.dispatchEvent(new CustomEvent('rf-prayer-updated')); } catch (e) {}
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

let _inflight = null;  // dedup fetch bersamaan (anti stampede + anti lost-update)

// Ambil jadwal hari ini: cache kalau masih tanggal yang sama, fetch ulang
// kalau tanggal berganti / force. Melempar error kalau fetch gagal —
// pemanggil yang menampilkan UI error.
export async function ensurePrayerTimes(force = false) {
  const s = loadPrayerSettings();
  if (!s.enabled || typeof s.lat !== 'number' || typeof s.lng !== 'number') return null;
  const today = todayStr();
  if (!force && s.cachedTimes && s.cachedTimes.date === today) return s.cachedTimes;
  if (_inflight) return _inflight;
  _inflight = (async () => {
    const times = await fetchPrayerTimes(s.lat, s.lng);
    // Re-read TERKINI sebelum save: fetch bisa relama ~8 detik — user bisa
    // saja mengubah setting (format/lokasi) di tengah jalan; JANGAN timpa
    // dengan snapshot lama (lost-update).
    const cur = loadPrayerSettings();
    cur.cachedTimes = times;
    cur.cachedAt = new Date().toISOString();
    savePrayerSettings(cur);
    return times;
  })().finally(() => { _inflight = null; });
  return _inflight;
}

// Model data untuk strip sticky & kartu pengaturan.
// return null kalau jadwal belum ada; { next, fast, fasts, hijriToday, hijriRaw }
export function buildStripModel(times) {
  if (!times || !times.timings) return null;
  const now = new Date();
  const next = getNextPrayerIncludingSunnah(times.timings, now);
  const hijriToday = times.hijri ? parseHijriString(times.hijri) : null;
  let fasts = [];
  if (hijriToday) {
    try { fasts = getUpcomingFasts(hijriToday, now, 14); } catch (e) { fasts = []; }
  }
  return {
    next,
    fast: fasts.length > 0 ? fasts[0] : null,
    fasts,
    hijriToday,
    hijriRaw: times.hijri || ''
  };
}

// "hari ini" / "besok" / "n hari lagi"
export function dayAheadLabel(daysAhead) {
  if (daysAhead === 0) return 'hari ini';
  if (daysAhead === 1) return 'besok';
  return daysAhead + ' hari lagi';
}
