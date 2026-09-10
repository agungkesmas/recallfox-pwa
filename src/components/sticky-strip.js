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
import { loadHabits, getTodayCounts, logQuranPages, logExercise, addShortcut, removeShortcut, resetShortcuts } from '../lib/habits.js';
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
    // v1.19.0: refresh bar saat Ngaji/Olahraga berubah (counter / situs)
    window.addEventListener('rf-habits-updated', () => { refreshStickyStrip().catch(() => {}); });
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
    // v1.19.0: shalat belum aktif → tetap expand detail (ada section Ngaji/Olahraga).
    // Tombol dismiss di bar tetap untuk sembunyikan total; link "Aktifkan" ada di detail.
    // Kecuali klik tepat di tombol ✕ (sudah stopPropagation di wireDismiss) — toggle detail.
    const open = el.classList.toggle('open');
    bar.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) renderDetail();
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

  // Belum diaktifkan: habits tetap tampil (v1.19.0). Chip setup shalat
  // digabung di bar yang sama; detail berisi habits + tombol aktifkan.
  // KECUALI user sudah dismiss → sembunyikan total.
  if (!s.enabled) {
    if (isStripDismissed()) {
      el.style.display = 'none';
      if (shell) shell.classList.remove('has-sticky');
    } else {
      el.style.display = '';
      if (shell) shell.classList.add('has-sticky');
      bar.innerHTML = setupBarHtml();
      wireDismiss();
      if (el.classList.contains('open')) renderDetail();
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
    // v1.19.0: walau jadwal gagal, habits tetap tampil + detail tetap bisa dibuka.
    bar.innerHTML = habitsBarHtml() + '<span class="rf-sticky-sep"></span>'
      + '<span class="rf-sticky-cell">🕌 <b>Gagal muat</b></span>'
      + '<svg class="rf-sticky-chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';
    if (el.classList.contains('open')) renderDetail();
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

function habitsBarHtml() {
  // v1.19.0: sel ringkas Ngaji & Olahraga — selalu tampil (mirror strip addon).
  // Format: "📖 Ngaji 0 hal" + "🏃 Olahraga" (✓ kalau sudah tercatat hari ini).
  let q = 0, e = 0, target = 1;
  try {
    const h = loadHabits();
    const t = getTodayCounts(h);
    q = t.quranPages; e = t.exerciseCount; target = h.quranTarget || 1;
  } catch (err) {}
  const qDone = q >= target && target > 0;
  const eDone = e > 0;
  return '<span class="rf-sticky-cell habit">📖 <b>Ngaji ' + q + ' hal' + (qDone ? ' ✓' : '') + '</b></span>'
    + '<span class="rf-sticky-sep"></span>'
    + '<span class="rf-sticky-cell habit">🏃 <b>Olahraga' + (eDone ? ' ✓' : '') + '</b></span>';
}

function setupBarHtml() {
  // v1.19.0: habits tetap tampil walau shalat belum diaktifkan — tap bar = expand detail habits.
  return habitsBarHtml()
    + '<span class="rf-sticky-sep"></span>'
    + '<span class="rf-sticky-cell">🕌 <b>Aktifkan Shalat</b></span>'
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
  // v1.19.0: habits selalu di depan (mirror strip addon: Ngaji + Olahraga).
  const habits = habitsBarHtml() + '<span class="rf-sticky-sep"></span>';
  if (!model || !model.next) {
    return habits + '<span class="rf-sticky-cell">🕌 <b>—</b></span>'
      + '<svg class="rf-sticky-chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';
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
  return habits + '<span class="rf-sticky-cell">🕌 <b>' + sunnah + esc(n.name) + ' ' + fmt(n.time) + '</b>'
    + ' <span class="rf-cd ' + cdClass(n.minutesUntil) + '">−' + cd + dayLbl + '</span></span>'
    + fastCell
    + '<svg class="rf-sticky-chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';
}

function renderDetail() {
  const detail = document.getElementById('rfStickyDetail');
  if (!detail) return;
  const s = loadPrayerSettings();
  const prayerOn = !!s.enabled && !!(_lastTimes && _lastTimes.timings && _lastModel);

  let prayerHtml = '';
  if (prayerOn) {
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
    prayerHtml = head + '<div class="rf-pray-grid">' + grid + '</div>' + fastHtml
      + '<button type="button" class="rf-detail-settings" id="rfStickySettings">⚙️ Atur lokasi &amp; pengaturan</button>';
  } else {
    prayerHtml = '<button type="button" class="rf-detail-settings" id="rfStickySetup">🕌 Aktifkan Waktu Shalat &amp; Puasa</button>';
  }

  // v1.19.0: Ngaji & Olahraga — collapsible ala addon (<details>), situs bisa disesuaikan.
  detail.innerHTML = '<div class="rf-sticky-detail-in">' + prayerHtml + habitsDetailHtml() + '</div>';
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
  const setupBtn = document.getElementById('rfStickySetup');
  if (setupBtn) {
    setupBtn.addEventListener('click', () => {
      try {
        sessionStorage.setItem('rf_scroll_to_prayer_card', '1');
        window.__rfNavigate('settings');
      } catch (e) {
        window.__rfNavigate('settings');
      }
    });
  }
  wireHabitsDetail();
}

// v1.19.0: HTML section Ngaji & Olahraga — dua <details> (collapse ala addon).
function habitsDetailHtml() {
  const h = loadHabits();
  const t = getTodayCounts(h);
  const target = h.quranTarget || 1;
  const qDone = t.quranPages >= target;

  const qLinks = (h.quranShortcuts || []).slice(0, 6).map((sc, i) => {
    return '<a class="rf-habit-link" href="' + esc(sc.url) + '" target="_blank" rel="noopener">'
      + '<span>' + esc(sc.emoji || '📖') + ' ' + esc(sc.name || 'Web') + '</span>'
      + '<button type="button" class="rf-habit-del" data-kind="quran" data-idx="' + i + '" title="Hapus situs">✕</button></a>';
  }).join('') || '<div class="rf-habit-empty">Belum ada situs — tambah di bawah.</div>';

  const eLinks = (h.exerciseShortcuts || []).slice(0, 6).map((sc, i) => {
    return '<a class="rf-habit-link" href="' + esc(sc.url) + '" target="_blank" rel="noopener">'
      + '<span>' + esc(sc.emoji || '🏃') + ' ' + esc(sc.name || 'Web') + '</span>'
      + '<button type="button" class="rf-habit-del" data-kind="exercise" data-idx="' + i + '" title="Hapus situs">✕</button></a>';
  }).join('') || '<div class="rf-habit-empty">Belum ada situs — tambah di bawah.</div>';

  return '<div class="rf-habit-sec">'
    + '<details class="rf-habit-details" open><summary>📖 Ngaji — <b>' + t.quranPages + ' / ' + target + ' hal</b>' + (qDone ? ' ✓' : '') + '</summary>'
    + '<div class="rf-habit-body">'
    + '<div class="rf-habit-counter"><button type="button" class="rf-habit-btn" id="rfQuranMinus">− 1 hal</button>'
    + '<button type="button" class="rf-habit-btn primary" id="rfQuranPlus">+ 1 halaman</button></div>'
    + '<div class="rf-habit-links">' + qLinks + '</div>'
    + '<button type="button" class="rf-habit-add" data-kind="quran">+ Tambah situs ngaji</button>'
    + '</div></details>'
    + '<details class="rf-habit-details" open><summary>🏃 Olahraga — <b>' + (t.exerciseCount > 0 ? '✓ tercatat' : 'belum') + '</b></summary>'
    + '<div class="rf-habit-body">'
    + '<div class="rf-habit-counter"><button type="button" class="rf-habit-btn" id="rfExMinus">− 1 sesi</button>'
    + '<button type="button" class="rf-habit-btn primary" id="rfExPlus">+ 1 sesi</button></div>'
    + '<div class="rf-habit-links">' + eLinks + '</div>'
    + '<button type="button" class="rf-habit-add" data-kind="exercise">+ Tambah situs olahraga</button>'
    + '</div></details>'
    + '<button type="button" class="rf-habit-reset" id="rfHabitReset">↺ Kembalikan situs bawaan</button>'
    + '</div>';
}

function wireHabitsDetail() {
  const qPlus = document.getElementById('rfQuranPlus');
  if (qPlus) qPlus.addEventListener('click', () => { logQuranPages(1); refreshStickyStrip().catch(() => {}); });
  const qMinus = document.getElementById('rfQuranMinus');
  if (qMinus) qMinus.addEventListener('click', () => { logQuranPages(-1); refreshStickyStrip().catch(() => {}); });
  const ePlus = document.getElementById('rfExPlus');
  if (ePlus) ePlus.addEventListener('click', () => { logExercise(1); refreshStickyStrip().catch(() => {}); });
  const eMinus = document.getElementById('rfExMinus');
  if (eMinus) eMinus.addEventListener('click', () => { logExercise(-1); refreshStickyStrip().catch(() => {}); });
  document.querySelectorAll('.rf-habit-del').forEach(btn => {
    btn.addEventListener('click', (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      if (!confirm('Hapus situs ini?')) return;
      removeShortcut(btn.dataset.kind, parseInt(btn.dataset.idx, 10));
      refreshStickyStrip().catch(() => {});
    });
  });
  document.querySelectorAll('.rf-habit-add').forEach(btn => {
    btn.addEventListener('click', () => {
      const kind = btn.dataset.kind;
      const name = (prompt('Nama situs (mis. Quran.com):') || '').trim();
      if (!name) return;
      const url = (prompt('URL situs (mis. https://quran.com/):') || '').trim();
      if (!url) return;
      if (!/^https?:\/\//i.test(url)) { alert('URL harus diawali http:// atau https://'); return; }
      const emoji = (prompt('Emoji (opsional, Enter = default):') || '').trim() || '🌐';
      const r = addShortcut(kind, { name, url, emoji });
      if (!r.ok) alert(r.error || 'Gagal tambah');
      refreshStickyStrip().catch(() => {});
    });
  });
  const resetBtn = document.getElementById('rfHabitReset');
  if (resetBtn) resetBtn.addEventListener('click', () => {
    if (!confirm('Kembalikan ke situs bawaan (Quran.com, Tafsir, Kemenag + YT Yoga/Cardio)?')) return;
    resetShortcuts();
    refreshStickyStrip().catch(() => {});
  });
}

function esc(str) {
  if (str == null) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
