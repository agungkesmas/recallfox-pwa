// src/lib/habits.js — Ngaji & Olahraga tracker untuk PWA (v1.19.0)
//
// Port ringkas fitur addon (vault.settings quranShortcuts/exerciseShortcuts +
// habits strip): di PWA tidak ada vault.settings → simpan di localStorage
// (pola konsisten PWA: key `rf_*` per-device, lihat prayer.js/focus.js).
//
// Storage shape (localStorage `rf_habits_v1`):
//   {
//     quranShortcuts: [{ name, url, emoji }],
//     exerciseShortcuts: [{ name, url, emoji }],
//     quranLog: { 'YYYY-MM-DD': pages },
//     exerciseLog: { 'YYYY-MM-DD': count },
//     quranTarget: number (halaman/hari, default 1)
//   }
//
// Default situs disamakan addon (vault.settings DEFAULT_SETTINGS):
//   Ngaji: Quran.com, Tafsir Web, Quran Kemenag
//   Olahraga: YouTube Yoga, YouTube Cardio
// Maksimal 6 per kategori (sama seperti addon renderShortcuts slice(0,6)).

const HABITS_KEY = 'rf_habits_v1';

export function defaultHabits() {
  return {
    quranShortcuts: [
      { name: 'Quran.com', url: 'https://quran.com/', emoji: '📖' },
      { name: 'Tafsir Web', url: 'https://tafsirweb.com/', emoji: '📚' },
      { name: 'Quran Kemenag', url: 'https://quran.kemenag.go.id/', emoji: '🕌' }
    ],
    exerciseShortcuts: [
      { name: 'YouTube Yoga', url: 'https://www.youtube.com/results?search_query=yoga+pemula', emoji: '🧘' },
      { name: 'YouTube Cardio', url: 'https://www.youtube.com/results?search_query=cardio+15+menit', emoji: '🏃' }
    ],
    quranLog: {},
    exerciseLog: {},
    quranTarget: 1
  };
}

export function loadHabits() {
  try {
    const raw = localStorage.getItem(HABITS_KEY);
    if (!raw) return defaultHabits();
    const parsed = JSON.parse(raw);
    const d = defaultHabits();
    return {
      quranShortcuts: Array.isArray(parsed.quranShortcuts) ? parsed.quranShortcuts : d.quranShortcuts,
      exerciseShortcuts: Array.isArray(parsed.exerciseShortcuts) ? parsed.exerciseShortcuts : d.exerciseShortcuts,
      quranLog: parsed.quranLog && typeof parsed.quranLog === 'object' ? parsed.quranLog : {},
      exerciseLog: parsed.exerciseLog && typeof parsed.exerciseLog === 'object' ? parsed.exerciseLog : {},
      quranTarget: Number.isFinite(parsed.quranTarget) ? parsed.quranTarget : 1
    };
  } catch (e) {
    return defaultHabits();
  }
}

export function saveHabits(h) {
  try { localStorage.setItem(HABITS_KEY, JSON.stringify(h)); } catch (e) {}
  try { window.dispatchEvent(new CustomEvent('rf-habits-updated')); } catch (e) {}
}

export function todayKey(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

export function getTodayCounts(h) {
  const k = todayKey();
  return {
    quranPages: (h.quranLog && h.quranLog[k]) || 0,
    exerciseCount: (h.exerciseLog && h.exerciseLog[k]) || 0
  };
}

export function logQuranPages(delta) {
  const h = loadHabits();
  const k = todayKey();
  const cur = (h.quranLog[k] || 0) + delta;
  h.quranLog[k] = Math.max(0, cur);
  saveHabits(h);
  return h.quranLog[k];
}

export function logExercise(delta = 1) {
  const h = loadHabits();
  const k = todayKey();
  const cur = (h.exerciseLog[k] || 0) + delta;
  h.exerciseLog[k] = Math.max(0, cur);
  saveHabits(h);
  return h.exerciseLog[k];
}

export function addShortcut(kind, entry) {
  // kind: 'quran' | 'exercise'
  const h = loadHabits();
  const list = kind === 'quran' ? h.quranShortcuts : h.exerciseShortcuts;
  if (list.length >= 6) return { ok: false, error: 'Maksimal 6 situs per kategori' };
  list.push({ name: entry.name || 'Web', url: entry.url || '', emoji: entry.emoji || '🌐' });
  saveHabits(h);
  return { ok: true };
}

export function removeShortcut(kind, idx) {
  const h = loadHabits();
  const list = kind === 'quran' ? h.quranShortcuts : h.exerciseShortcuts;
  if (idx < 0 || idx >= list.length) return { ok: false };
  list.splice(idx, 1);
  saveHabits(h);
  return { ok: true };
}

export function resetShortcuts() {
  const h = loadHabits();
  const d = defaultHabits();
  h.quranShortcuts = d.quranShortcuts;
  h.exerciseShortcuts = d.exerciseShortcuts;
  saveHabits(h);
}
