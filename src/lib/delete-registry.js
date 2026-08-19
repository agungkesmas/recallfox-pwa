// src/lib/delete-registry.js — Delete registry untuk PWA
// v1.11.0: Port konsep delete registry dari addon (lib/supabase-sync.js).
//
// Problem: user hapus item di PWA → hard-delete dari cloud. Tapi device lain
// (addon / PWA lain) yang belum sync masih punya item di lokal. Saat device
// itu push → item di-INSERT ulang ke cloud → PWA pull → item muncul kembali.
// Loop terus menerus (bug yang user report: "item terhapus tapi muncul kembali
// beberapa detik kemudian secara berulang").
//
// Solution: maintain "delete registry" — Set of item IDs yang sudah dihapus.
// Saat pullFromCloud menemukan item di cloud yang ada di registry → SKIP re-add.
// Saat processSyncQueue proses upsert_vault → cek registry, skip kalau ada.
// Registry disimpan di localStorage (simple, no IndexedDB overhead).
// Cleanup otomatis: entry >30 hari dihapus.

const REGISTRY_KEY = 'recallfox_pwa_delete_registry';
const MAX_AGE_DAYS = 30;

/**
 * Load delete registry dari localStorage.
 * Format: { items: { id: deletedAtIso }, notes: { id: deletedAtIso } }
 */
function _loadRegistry() {
  try {
    const raw = localStorage.getItem(REGISTRY_KEY);
    if (!raw) return { items: {}, notes: {} };
    const reg = JSON.parse(raw);
    if (!reg.items) reg.items = {};
    if (!reg.notes) reg.notes = {};
    return reg;
  } catch (e) {
    console.warn('[RecallFox/delete-registry] Load failed:', e.message);
    return { items: {}, notes: {} };
  }
}

function _saveRegistry(reg) {
  try {
    localStorage.setItem(REGISTRY_KEY, JSON.stringify(reg));
  } catch (e) {
    console.warn('[RecallFox/delete-registry] Save failed:', e.message);
  }
}

/**
 * Tambah item ID ke delete registry.
 * Dipanggil saat user hapus item di device ini, ATAU saat pull menemukan
 * item cloud dengan deleted_at (dihapus di device lain).
 */
export function addToDeleteRegistry(itemId, deletedAtIso) {
  const reg = _loadRegistry();
  reg.items[itemId] = deletedAtIso || new Date().toISOString();
  _saveRegistry(reg);
}

/**
 * Tambah note ID ke delete registry.
 */
export function addNoteToDeleteRegistry(noteId, deletedAtIso) {
  const reg = _loadRegistry();
  reg.notes[noteId] = deletedAtIso || new Date().toISOString();
  _saveRegistry(reg);
}

/**
 * Cek apakah item ID ada di delete registry (sudah dihapus).
 */
export function isInDeleteRegistry(itemId) {
  const reg = _loadRegistry();
  return Object.prototype.hasOwnProperty.call(reg.items, itemId);
}

/**
 * Cek apakah note ID ada di delete registry.
 */
export function isNoteInDeleteRegistry(noteId) {
  const reg = _loadRegistry();
  return Object.prototype.hasOwnProperty.call(reg.notes, noteId);
}

/**
 * Hapus item dari registry (kalau user unarchive atau re-create item dengan ID sama).
 */
export function removeFromDeleteRegistry(itemId) {
  const reg = _loadRegistry();
  if (reg.items[itemId]) {
    delete reg.items[itemId];
    _saveRegistry(reg);
  }
}

export function removeNoteFromDeleteRegistry(noteId) {
  const reg = _loadRegistry();
  if (reg.notes[noteId]) {
    delete reg.notes[noteId];
    _saveRegistry(reg);
  }
}

/**
 * Cleanup entry >30 hari. Dipanggil sebelum pull/processSyncQueue.
 */
export function cleanupDeleteRegistry() {
  const reg = _loadRegistry();
  const cutoff = Date.now() - (MAX_AGE_DAYS * 24 * 60 * 60 * 1000);
  let cleaned = 0;
  for (const [id, ts] of Object.entries(reg.items)) {
    if (new Date(ts).getTime() < cutoff) {
      delete reg.items[id];
      cleaned++;
    }
  }
  for (const [id, ts] of Object.entries(reg.notes)) {
    if (new Date(ts).getTime() < cutoff) {
      delete reg.notes[id];
      cleaned++;
    }
  }
  if (cleaned > 0) {
    _saveRegistry(reg);
    console.log('[RecallFox/delete-registry] Cleaned', cleaned, 'entries >30 days');
  }
}

/**
 * Get semua deleted item IDs (untuk debugging).
 */
export function getDeletedItemIds() {
  const reg = _loadRegistry();
  return Object.keys(reg.items);
}

export function getDeletedNoteIds() {
  const reg = _loadRegistry();
  return Object.keys(reg.notes);
}
