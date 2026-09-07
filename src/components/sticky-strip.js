// src/components/sticky-strip.js — Strip sticky Waktu Shalat & Puasa (v1.17.0)
//
// Model sticky ala popup addon (strip-bar stripPrayer/stripFast yang selalu
// terlihat di SEMUA halaman, bisa di-expand jadi detail): di PWA strip ini
// fixed di TOP layar, berada DI LUAR #appMain sehingga tidak ikut ter-replace
// saat navigasi antar view (renderNotes/renderVault/... menimpa innerHTML
// app-main, bukan shell).
//
// State strip:
//   1. dismissed / fitur tak diaktifkan & sudah ditutup  → strip hidden
//   2. belum aktif (chip setup)   → [🕌 Aktifkan Waktu Shalat & Puasa] [✕]
//                                    tap → view Pengaturan (kartu Waktu Shalat)
//   3. aktif, belum ada jadwal    → [🕌 Memuat jadwal…]
//   4. aktif, gagal fetch         → [🕌 Gagal muat — tap untuk coba lagi]
//   5. aktif + jadwal             → [🕌 <Shalat> <HH:MM> −<countdown>]
//                                    | [🌙 <puasa berikutnya> · <hari>] [chev]
//                                    expand → grid 6 waktu + hijri + lokasi +
//                                    daftar puasa 14 hari + tombol pengaturan.
//
// Refresh: ticker 30 detik (countdown) + visibilitychange + event
// 'rf-prayer-updated' (dipicu savePrayerSettings dari kartu pengaturan).

import { loadPrayerSettings, ensurePrayerTimes, buildStripModel, dayAheadLabel, isStripDismissed, dismissStrip } from '../lib/prayer.js';
import { formatCountdown, to12Hour } from '../lib/salahtime.js';

let _ticker = null;
let _lastTimes = null;   // cache module-level supaya tick 30s tidak refetch
let _lastModel = null;

const PRAY_ROWS = [
  ['Subuh', 'Fajr'],
  ['Terbit', 'Sunrise'],
  ['Dzuhur', 'Dhuhr'],
  ['Ashar', 'Asr'],
  ['Magrib', 'Maghrib'],
  ['Isya', 'Isha']
];

export function mountStickyStrip() {
  const shell = document.querySelector('.app-shell');
  if (!shell) return;
  if (!document.getElementById('rfStickyStrip')) {
    const el = document.createElement('div');
    el.className = 'rf-sticky';
    el.id = 'rfStickyStrip';
    el.innerHTML = `
      <button class="rf-sticky-bar" id="rfStickyBar" aria-expanded="false"></button>
      <div class="rf-sticky-detail" id="rfStickyDetail"></div>
    `;
    shell.insertBefore(el, shell.firstChild);
    el.querySelector('#rfStickyBar').addEventListener('click', onBarClick);
    // Event dari kartu pengaturan / savePrayerSettings
    window.addEventListener('rf-prayer-updated', refreshStickyStrip);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') refreshStickyStrip();
    });
  }
  if (!_ticker) {
    _ticker = setInterval(() => { refreshStickyStrip().catch(() => {}); }, 30000);
  }
  refreshStickyStrip().catch(() => {});
}

function onBarClick() {
  const el = document.getElementById('rfStickyStrip');
  const bar = document.getElementById('rfStickyBar');
  if (!el || !bar) return;
  const s = loadPrayerSettings();
  if (!s.enabled) {
    // chip setup → buka kartu pengaturan shalat di view Pengaturan
    try {
      sessionStorage.setItem('rf_scroll_to_prayer_card', '1');
      window.__rfNavigate('settings');
    } catch (e) {
      window.__rfNavigate('settings');
    }
    return;
  }
  if (!_lastTimes && !_lastModel) {
    // state gagal muat → tap = coba fetch ulang
    refreshStickyStrip(true).catch(() => {});
    return;
  }
  const open = el.classList.toggle('open');
  bar.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open) renderDetail();
}

export async function refreshStickyStrip(force = false) {
  const el = document.getElementById('rfStickyStrip');
  const bar = document.getElementById('rfStickyBar');
  if (!el || !bar) return;  // shell belum dirender / sudah logout
  const shell = el.closest('.app-shell');
  const s = loadPrayerSettings();

  // Belum diaktifkan: chip setup tampil (discoverability) KECUALI user
  // sudah pernah menutupnya (dismiss) → sembunyikan total.
  if (!s.enabled) {
    if (isStripDismissed()) {
      el.style.display = 'none';
      if (shell) shell.classList.remove('has-sticky');
    } else {
      el.style.display = '';
      if (shell) shell.classList.add('has-sticky');
      el.classList.remove('open');
      bar.innerHTML = setupBarHtml();
      wireDismiss();
    }
    return;
  }

  el.style.display = '';
  if (shell) shell.classList.add('has-sticky');

  // Aktif — pastikan jadwal hari ini tersedia
  let times = _lastTimes;
  try {
    times = await ensurePrayerTimes(!!force);
    _lastTimes = times;
  } catch (e) {
    times = null;
  }
  // Baca ulang settings SETELAH fetch (bisa relama ~8 detik) — user bisa
  // mengubah lokasi/format lewat kartu pengaturan di tengah jalan.
  const sNow = loadPrayerSettings();
  if (!times || !times.timings) {
    bar.innerHTML = '<span class="rf-sticky-cell">🕌 <b>Gagal muat jadwal</b>&nbsp;— tap untuk coba lagi</span>';
    el.classList.remove('open');
    return;
  }

  const model = buildStripModel(times);
  _lastModel = model;
  bar.innerHTML = activeBarHtml(model, sNow);
  if (!el.classList.contains('open')) {
    // detail dirender saat dibuka pertama kali (onBarClick → renderDetail)
  } else {
    renderDetail();
  }
}

// ---------- HTML builders ----------

function setupBarHtml() {
  return '<span class="rf-sticky-cell">🕌 <b>Aktifkan Waktu Shalat &amp; Puasa</b>'
    + '<span class="rf-setup-sub">— jadwal shalat &amp; puasa sunnah di semua halaman</span></span>'
    + '<button type="button" class="rf-sticky-dismiss" id="rfStickyDismiss" title="Sembunyikan" aria-label="Sembunyikan">✕</button>';
}

function wireDismiss() {
  const btn = document.getElementById('rfStickyDismiss');
  if (!btn) return;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    dismissStrip();  // event 'rf-prayer-updated' otomatis refresh strip
  });
}

function cdClass(min) {
  if (min <= 2) return 'now';
  if (min < 10) return 'soon';
  return 'ok';
}

function activeBarHtml(model, s) {
  if (!model || !model.next) {
    return '<span class="rf-sticky-cell">🕌 <b>—</b></span>';
  }
  const fmt = s.timeFormat === '12h' ? to12Hour : (t) => t;
  const n = model.next;
  const cd = formatCountdown(n.minutesUntil);
  const dayLbl = n.isToday ? '' : ' (besok)';
  const sunnah = n.isSunnah ? '🌟 ' : '';
  let fastCell = '';
  if (model.fast) {
    const f = model.fast;
    fastCell = '<span class="rf-sticky-sep"></span>'
      + '<span class="rf-sticky-cell fast">🌙 <b>' + esc(f.name) + '</b> <span>' + dayAheadLabel(f.daysAhead) + '</span></span>';
  }
  return '<span class="rf-sticky-cell">🕌 <b>' + sunnah + esc(n.name) + ' ' + fmt(n.time) + '</b>'
    + ' <span class="rf-cd ' + cdClass(n.minutesUntil) + '">−' + cd + dayLbl + '</span></span>'
    + fastCell
    + '<svg class="rf-sticky-chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';
}

function renderDetail() {
  const detail = document.getElementById('rfStickyDetail');
  if (!detail || !_lastTimes || !_lastModel) return;
  const s = loadPrayerSettings();
  const fmt = s.timeFormat === '12h' ? to12Hour : (t) => t;
  const t = _lastTimes.timings;
  const m = _lastModel;

  const grid = PRAY_ROWS.map(([label, key]) => {
    const isNext = m.next && m.next.key === key;
    return '<div class="rf-pray-cell' + (isNext ? ' next' : '') + '">'
      + '<div class="n">' + label + '</div><div class="t">' + fmt(t[key] || '--:--') + '</div></div>';
  }).join('');

  const head = '<div class="rf-detail-head">'
    + '<span class="rf-detail-loc">🕌 ' + esc(s.location || 'Waktu Shalat') + '</span>'
    + '<span class="rf-detail-hijri">' + esc(m.hijriRaw || '') + '</span></div>';

  let fastHtml = '';
  if (m.fasts && m.fasts.length > 0) {
    const f0 = m.fasts[0];
    fastHtml += '<div class="rf-fast-line">🌙 <b>' + esc(f0.name) + '</b> — ' + dayAheadLabel(f0.daysAhead)
      + (f0.hijriDate ? ' · ' + esc(f0.hijriDate) : '')
      + (f0.desc ? '<br><span style="font-size:10.5px">' + esc(f0.desc) + '</span>' : '') + '</div>';
    const chips = m.fasts.slice(1, 4).map((f) => {
      const cls = f.daysAhead <= 2 ? ' rf-fast-chip soon' : '';
      return '<span class="rf-fast-chip' + cls + '">' + esc(f.name) + ' · ' + dayAheadLabel(f.daysAhead) + '</span>';
    }).join('');
    if (chips) fastHtml += '<div class="rf-fast-chips">' + chips + '</div>';
  } else {
    fastHtml += '<div class="rf-fast-line">🌙 Tidak ada puasa sunnah dalam 14 hari ke depan.</div>';
  }

  detail.innerHTML = '<div class="rf-sticky-detail-in">' + head
    + '<div class="rf-pray-grid">' + grid + '</div>'
    + fastHtml
    + '<button type="button" class="rf-detail-settings" id="rfStickySettings">⚙️ Atur lokasi &amp; pengaturan</button>'
    + '</div>';
  const setBtn = document.getElementById('rfStickySettings');
  if (setBtn) {
    setBtn.addEventListener('click', () => {
      try {
        sessionStorage.setItem('rf_scroll_to_prayer_card', '1');
        window.__rfNavigate('settings');
      } catch (e) {
        window.__rfNavigate('settings');
      }
    });
  }
}

function esc(str) {
  if (str == null) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
