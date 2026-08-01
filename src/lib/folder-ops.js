// src/lib/folder-ops.js — Operasi folder yang AMAN (anti-crash) untuk PWA
// v1.10.0: Tambah rename/archive/delete folder dengan guards.
//
// Spec user: "fitur edit apapun bisa rename, hapus, arsip dsb. folder yang
// kelebihan, seperti bug nampil. kamu hapus aja itu folder nya ngotorin.
// yg berbahaya fitur folder jgn dilakukan, misal berpotensi membuat crash"
//
// Strategy:
//   - Semua operasi return {ok, error} instead of throw — caller tidak perlu try-catch
//   - Validasi folderId exist + benar-benar isGroup sebelum operasi
//   - Limit recursive depth (max 5 level) anti infinite loop
//   - Batch updates dengan Promise.allSettled (satu gagal tidak crash semua)
//   - Untuk delete: 2 mode — 'keep-children' (aman) dan 'delete-all' (perlu confirm)
//
// Kompatibel dengan addon: schema storage sama (source.parentId, source.isGroup, archived flag).
// Folder yang di-rename/archive/delete di PWA → sync ke addon via Supabase polling.

import { dbGetAllVaultItems, dbPutVaultItem } from '../db.js';
import { updateVaultItem, deleteVaultItem } from '../sync.js';
import { isGroupItem, getParentId, setParentId } from './vault-tree.js';

const MAX_DEPTH = 5;  // anti infinite loop

/**
 * Validasi folder ID — pastikan ada di IndexedDB dan benar-benar isGroup.
 * Return folder item atau null kalau invalid.
 */
async function getValidFolder(folderId) {
  if (!folderId || typeof folderId !== 'string') return null;
  try {
    const allItems = await dbGetAllVaultItems();
    const folder = allItems.find(i => i.id === folderId && isGroupItem(i));
    return folder || null;
  } catch (e) {
    console.warn('[RecallFox/folder-ops] getValidFolder error:', e.message);
    return null;
  }
}

/**
 * Kumpulkan semua children (recursive) dari folder tertentu.
 * Return array of items (termasuk sub-folder dan item biasa).
 * Anti-loop: batasi MAX_DEPTH.
 */
async function collectDescendants(folderId, depth = 0) {
  if (depth >= MAX_DEPTH) {
    console.warn('[RecallFox/folder-ops] Max depth reached at', folderId);
    return [];
  }
  try {
    const allItems = await dbGetAllVaultItems();
    const directChildren = allItems.filter(i => getParentId(i) === folderId);
    let all = [...directChildren];
    for (const child of directChildren) {
      if (isGroupItem(child)) {
        const sub = await collectDescendants(child.id, depth + 1);
        all = all.concat(sub);
      }
    }
    return all;
  } catch (e) {
    console.warn('[RecallFox/folder-ops] collectDescendants error:', e.message);
    return [];
  }
}

/**
 * Rename folder — operasi paling aman, hanya update title.
 * Tidak sentuh children, tidak recursive.
 *
 * @param {Object} user - supabase user
 * @param {string} folderId - folder id (must be isGroup=true)
 * @param {string} newName - nama baru (will be trimmed)
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function renameFolder(user, folderId, newName) {
  const name = (newName || '').trim();
  if (!name) return { ok: false, error: 'Nama tidak boleh kosong' };
  if (name.length > 100) return { ok: false, error: 'Nama terlalu panjang (max 100 chars)' };

  const folder = await getValidFolder(folderId);
  if (!folder) return { ok: false, error: 'Folder tidak ditemukan atau bukan folder' };

  try {
    const result = await updateVaultItem(user, folderId, { title: name });
    console.log('[RecallFox/folder-ops] Renamed folder:', folderId, '→', name);
    return { ok: true };
  } catch (e) {
    console.error('[RecallFox/folder-ops] renameFolder error:', e.message);
    return { ok: false, error: e.message };
  }
}

/**
 * Archive folder — set archived=true untuk folder + semua children (recursive).
 * Aman karena hanya flip flag, tidak delete data.
 * User bisa unarchive nanti di addon (chip "Arsip").
 *
 * @param {Object} user
 * @param {string} folderId
 * @returns {Promise<{ok: boolean, archivedCount?: number, error?: string}>}
 */
export async function archiveFolder(user, folderId) {
  const folder = await getValidFolder(folderId);
  if (!folder) return { ok: false, error: 'Folder tidak ditemukan' };

  try {
    const descendants = await collectDescendants(folderId);
    const allIds = [folderId, ...descendants.map(d => d.id)];
    console.log('[RecallFox/folder-ops] Archiving', allIds.length, 'items (folder + descendants)');

    // Batch update — pakai Promise.allSettled supaya satu gagal tidak crash semua
    const results = await Promise.allSettled(
      allIds.map(id => updateVaultItem(user, id, { archived: true }))
    );
    const successCount = results.filter(r => r.status === 'fulfilled').length;
    const failCount = results.length - successCount;

    if (failCount > 0) {
      console.warn('[RecallFox/folder-ops] Archive partial fail:', failCount, 'of', results.length);
    }
    console.log('[RecallFox/folder-ops] Archived folder:', folderId, '— items:', successCount);
    return { ok: true, archivedCount: successCount };
  } catch (e) {
    console.error('[RecallFox/folder-ops] archiveFolder error:', e.message);
    return { ok: false, error: e.message };
  }
}

/**
 * Delete folder — 2 mode:
 *   - 'keep-children' (DEFAULT, AMAN): unparent semua children (set parentId=null),
 *     lalu hapus folder saja. Children jadi top-level items.
 *   - 'delete-all' (BERBAHAYA, perlu confirm): hapus folder + semua children recursive.
 *     Data hilang permanen.
 *
 * @param {Object} user
 * @param {string} folderId
 * @param {'keep-children'|'delete-all'} mode
 * @returns {Promise<{ok: boolean, deletedCount?: number, unparentedCount?: number, error?: string}>}
 */
export async function deleteFolder(user, folderId, mode = 'keep-children') {
  const folder = await getValidFolder(folderId);
  if (!folder) return { ok: false, error: 'Folder tidak ditemukan' };

  if (mode !== 'keep-children' && mode !== 'delete-all') {
    return { ok: false, error: 'Mode tidak valid (harus keep-children atau delete-all)' };
  }

  try {
    const descendants = await collectDescendants(folderId);
    console.log('[RecallFox/folder-ops] Delete folder:', folderId, 'mode:', mode,
      '— descendants:', descendants.length);

    if (mode === 'keep-children') {
      // Unparent semua children langsung (depth=1) — set parentId=null
      // Sub-folder children juga di-unparent, jadi mereka jadi top-level folder.
      const directChildren = descendants.filter(d => getParentId(d) === folderId);
      const results = await Promise.allSettled(
        directChildren.map(child => {
          // Update via supabase + IndexedDB
          const newSource = { ...(child.source || {}), parentId: null };
          return updateVaultItem(user, child.id, { source: newSource });
        })
      );
      const unparentedCount = results.filter(r => r.status === 'fulfilled').length;

      // Hapus folder itu sendiri
      const delRes = await deleteVaultItem(user, folderId);
      if (!delRes.ok) {
        console.warn('[RecallFox/folder-ops] Folder delete failed, but children unparented');
      }
      console.log('[RecallFox/folder-ops] Deleted folder:', folderId,
        '— unparented:', unparentedCount);
      return { ok: true, unparentedCount };
    } else {
      // mode === 'delete-all' — hapus folder + semua descendants
      const allIds = [folderId, ...descendants.map(d => d.id)];
      const results = await Promise.allSettled(
        allIds.map(id => deleteVaultItem(user, id))
      );
      const deletedCount = results.filter(r => r.status === 'fulfilled').length;
      console.log('[RecallFox/folder-ops] Deleted folder + all:', folderId,
        '— total deleted:', deletedCount);
      return { ok: true, deletedCount };
    }
  } catch (e) {
    console.error('[RecallFox/folder-ops] deleteFolder error:', e.message);
    return { ok: false, error: e.message };
  }
}

/**
 * Move folder ke parent lain (atau ke root kalau newParentId=null).
 * Aman karena hanya update source.parentId.
 * Anti-loop: cek newParentId bukan diri sendiri atau descendant folder ini.
 *
 * @param {Object} user
 * @param {string} folderId - folder yang akan dipindah
 * @param {string|null} newParentId - parent baru (null = root)
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function moveFolder(user, folderId, newParentId) {
  const folder = await getValidFolder(folderId);
  if (!folder) return { ok: false, error: 'Folder tidak ditemukan' };

  // Anti-loop: cek newParentId bukan diri sendiri
  if (newParentId === folderId) {
    return { ok: false, error: 'Tidak bisa pindah folder ke dirinya sendiri' };
  }

  // Anti-loop: cek newParentId bukan descendant folder ini
  if (newParentId) {
    const descendants = await collectDescendants(folderId);
    if (descendants.some(d => d.id === newParentId)) {
      return { ok: false, error: 'Tidak bisa pindah folder ke sub-folder-nya sendiri (akan bikin loop)' };
    }
  }

  try {
    const newSource = { ...(folder.source || {}), parentId: newParentId };
    await updateVaultItem(user, folderId, { source: newSource });
    console.log('[RecallFox/folder-ops] Moved folder:', folderId, '→ parent:', newParentId || '(root)');
    return { ok: true };
  } catch (e) {
    console.error('[RecallFox/folder-ops] moveFolder error:', e.message);
    return { ok: false, error: e.message };
  }
}

/**
 * Deteksi folder orphan — folder yang parentId-nya menunjuk ke folder
 * yang tidak exist (sudah dihapus) atau menunjuk ke non-group item.
 * Folder orphan sering jadi "bug tampil" — muncul tapi tidak bisa dibuka.
 *
 * @returns {Promise<Array<{id, title, orphanParentId}>>}
 */
export async function findOrphanFolders() {
  try {
    const allItems = await dbGetAllVaultItems();
    const groupIds = new Set(allItems.filter(i => isGroupItem(i)).map(i => i.id));
    const orphans = [];
    for (const item of allItems) {
      if (!isGroupItem(item)) continue;
      const pid = getParentId(item);
      if (pid && !groupIds.has(pid)) {
        // parentId menunjuk ke yang bukan group (atau sudah dihapus)
        orphans.push({ id: item.id, title: item.title, orphanParentId: pid });
      }
    }
    return orphans;
  } catch (e) {
    console.warn('[RecallFox/folder-ops] findOrphanFolders error:', e.message);
    return [];
  }
}

/**
 * Cleanup folder orphan — unparent semua folder yang parentId-nya invalid.
 * Aman: hanya set parentId=null, tidak hapus data.
 * Operasi ini yang akan "bersihkan folder ngotorin" yang user maksud.
 *
 * @param {Object} user
 * @returns {Promise<{ok: boolean, cleanedCount?: number, error?: string}>}
 */
export async function cleanupOrphanFolders(user) {
  try {
    const orphans = await findOrphanFolders();
    if (orphans.length === 0) {
      return { ok: true, cleanedCount: 0 };
    }
    console.log('[RecallFox/folder-ops] Cleaning', orphans.length, 'orphan folders');

    const allItems = await dbGetAllVaultItems();
    const results = await Promise.allSettled(
      orphans.map(o => {
        const item = allItems.find(i => i.id === o.id);
        if (!item) return Promise.resolve();
        const newSource = { ...(item.source || {}), parentId: null };
        return updateVaultItem(user, o.id, { source: newSource });
      })
    );
    const cleanedCount = results.filter(r => r.status === 'fulfilled').length;
    console.log('[RecallFox/folder-ops] Cleaned', cleanedCount, 'orphan folders');
    return { ok: true, cleanedCount };
  } catch (e) {
    console.error('[RecallFox/folder-ops] cleanupOrphanFolders error:', e.message);
    return { ok: false, error: e.message };
  }
}
