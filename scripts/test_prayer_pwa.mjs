// scripts/test_prayer_pwa.mjs — Smoke test modul shalat/puasa PWA (pure module)
// Jalankan: node scripts/test_prayer_pwa.mjs (dari root recallfox-pwa)
import {
  fetchPrayerTimes, getNextPrayer, getNextPrayerIncludingSunnah,
  getLastPassedPrayer, getSunnahPrayers, formatCountdown, to12Hour
} from '../src/lib/salahtime.js';
import {
  parseHijriString, getUpcomingFasts, getSunnahFastToday, formatHijriDate, HIJRI_MONTHS
} from '../src/lib/islamicCalendar.js';
import { buildStripModel, dayAheadLabel, defaultPrayerSettings, loadPrayerSettings, savePrayerSettings } from '../src/lib/prayer.js';

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log('  ✔', label); }
  else { failed++; console.error('  ✘ GAGAL:', label); }
}

// Jadwal sintetis (2026-09-08) — tidak perlu network
const T = {
  date: '2026-09-08',
  hijri: '15 Rabiʿ al-Awwal 1448 AH',
  timings: {
    Fajr: '04:32', Sunrise: '05:47', Dhuhr: '11:59', Asr: '15:17',
    Maghrib: '18:03', Isha: '19:13', Imsak: '04:22',
    Firstthird: '22:10', Lastthird: '01:50', Midnight: '00:00'
  },
  timezone: 'Asia/Jakarta', method: 'Muhammadiyah (Fajr 18°, Isha 18°)'
};

console.log('== salahtime.js (port addon → PWA) ==');
const now = new Date(2026, 8, 8, 9, 0, 0); // 2026-09-08 09:00 (Selasa)
// Dhuha = Sunrise 05:47 + 1/4(11:59−05:47) = 07:20 → pukul 09:00 sudah lewat
const nextAt610 = getNextPrayerIncludingSunnah(T.timings, new Date(2026, 8, 8, 6, 10, 0));
assert(nextAt610 && nextAt610.name === 'Dhuha' && nextAt610.isSunnah === true, 'next 06:10 → Dhuha (sunnah)');
const next = getNextPrayerIncludingSunnah(T.timings, now);
assert(next && next.name === 'Dzuhur', 'next 09:00 → Dzuhur (Dhuha 07:20 sudah lewat)');
const next2 = getNextPrayerIncludingSunnah(T.timings, new Date(2026, 8, 8, 20, 0, 0));
assert(next2 && next2.name === 'Subuh' && next2.isToday === false, 'next 20:00 → semua lewat → Subuh besok');
const next3 = getNextPrayerIncludingSunnah(T.timings, new Date(2026, 8, 8, 23, 59, 0));
assert(next3 && next3.name === 'Subuh' && next3.isToday === false, 'next 23:59 → Subuh besok');
const last = getLastPassedPrayer(T.timings, now);
assert(last && last.name === 'Fajr', 'last passed 09:00 → Fajr');
assert(getSunnahPrayers(T.timings).length === 5, 'sunnah list = 5 (Ishraq, Dhuha, Awwabin, Tahajud, Witir)');
assert(formatCountdown(75) === '1j 15m', 'formatCountdown 75 → 1j 15m');
assert(to12Hour('18:03') === '06:03 PM', 'to12Hour 18:03 → 06:03 PM');
assert(getNextPrayer(T.timings, now).name === 'Dhuhr', 'wajib saja 09:00 → Dhuhr');

console.log('== islamicCalendar.js (port addon → PWA) ==');
const hijri = parseHijriString('15 Rabiʿ al-Awwal 1448 AH');
assert(hijri && hijri.month.number === '3', 'parse hijri berdiakritik → Rabiul Awwal (bulan 3)');
const hijri2 = parseHijriString('10 Ramadhan 1447 AH');
assert(hijri2 && hijri2.month.number === '9', 'parse Ramadhan → bulan 9');
assert(formatHijriDate(hijri).includes('Rabiul Awwal'), 'formatHijriDate pakai nama Indonesia');
// 2026-09-08 = Selasa & hijri 15 Rabiul Awwal → Ayyamul Bidh (13-14-15)
const fasts = getUpcomingFasts(hijri, new Date(2026, 8, 8), 14);
assert(fasts.length > 0, 'getUpcomingFasts 14 hari ≥ 1');
assert(fasts[0].daysAhead === 0 && fasts[0].name === 'Puasa Ayyamul Bidh', 'fasts[0] hari ini = Ayyamul Bidh (hijri 15)');
// 2026-09-14 = Senin (hijri 21, bukan hari khusus) → Puasa Senin-Kamis
const hijriSenin = parseHijriString('21 Rabiʿ al-Awwal 1448 AH');
const fastsSenin = getUpcomingFasts(hijriSenin, new Date(2026, 8, 14), 7);
assert(fastsSenin[0] && fastsSenin[0].name === 'Puasa Senin-Kamis' && fastsSenin[0].daysAhead === 0, 'Senin 14 Sep → Senin-Kamis');
assert(getSunnahFastToday(hijriSenin, new Date(2026, 8, 14))?.name === 'Puasa Senin-Kamis', 'getSunnahFastToday Senin → Senin-Kamis');
assert(HIJRI_MONTHS.length === 12, 'HIJRI_MONTHS 12 bulan');

console.log('== prayer.js (store PWA) ==');
assert(dayAheadLabel(0) === 'hari ini' && dayAheadLabel(1) === 'besok' && dayAheadLabel(5) === '5 hari lagi', 'dayAheadLabel');
const model = buildStripModel(T);
assert(model && model.next && model.fast, 'buildStripModel → next + fast');
assert(model.hijriToday && model.hijriToday.month.number === '3', 'buildStripModel hijri terparse');
// localStorage shim untuk Node
globalThis.localStorage = {
  _s: {},
  getItem(k) { return this._s[k] ?? null; },
  setItem(k, v) { this._s[k] = String(v); },
  removeItem(k) { delete this._s[k]; }
};
globalThis.window = { dispatchEvent() {} };
assert(loadPrayerSettings().enabled === false, 'default settings → disabled');
const s = defaultPrayerSettings(); s.enabled = true; s.lat = -7.8; s.lng = 110.4; s.location = 'Yogyakarta';
savePrayerSettings(s);
assert(loadPrayerSettings().location === 'Yogyakarta', 'save/load settings persist');

console.log('== fetchPrayerTimes (network, opsional) ==');
try {
  const times = await fetchPrayerTimes(-7.7956, 110.3695); // Yogyakarta
  assert(times && times.timings && times.timings.Maghrib, 'Aladhan fetch OK (Maghrib ' + times.timings.Maghrib + ', ' + (times.hijri || '?') + ')');
} catch (e) {
  console.log('  ⚠ SKIP network fetch:', e.message);
}

console.log('\nHasil: ' + passed + ' lolos, ' + failed + ' gagal');
process.exit(failed > 0 ? 1 : 0);
