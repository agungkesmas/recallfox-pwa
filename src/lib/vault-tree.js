// lib/vault-tree.js — v3.18.4: Recursive nested folder support
// v1.9.3 PWA: Tambah helper isPinned/getPinnedAt + sortByMode prioritaskan pinned.
// Storage: parentId/isGroup/order/folderColor/pinned di item.source (JSONB) — no ALTER TABLE needed.
// Folder bisa berisi folder lagi (nested) — seperti file manager.

// ===== Schema helpers =====

export function getParentId(item) {
  return item?.source?.parentId || null;
}

export function setParentId(item, parentId) {
  if (!item.source) item.source = {};
  item.source.parentId = parentId || null;
}

export function isGroupItem(item) {
  return !!(item?.source?.isGroup);
}

export function getGroupType(item) {
  return item?.source?.groupType || item?.type || null;
}

export function getOrder(item) {
  return item?.source?.order || 0;
}

export function setOrder(item, order) {
  if (!item.source) item.source = {};
  item.source.order = order;
}

// v1.9.3 PWA: Pin helpers — pinned item muncul di atas daftar (mode recent/fav).
// Disimpan di source.pinned (boolean) + source.pinnedAt (ISO timestamp) supaya
// bisa sort pinned items by recency.
export function isPinned(item) {
  return !!(item?.source?.pinned);
}

export function getPinnedAt(item) {
  return item?.source?.pinnedAt || null;
}

export function setPinned(item, pinned) {
  if (!item.source) item.source = {};
  if (pinned) {
    item.source.pinned = true;
    if (!item.source.pinnedAt) item.source.pinnedAt = new Date().toISOString();
  } else {
    item.source.pinned = false;
    item.source.pinnedAt = null;
  }
}

// ===== Create group =====

export function createGroup(name, type, userId) {
  const now = new Date().toISOString();
  const id = 'grp_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  return {
    id,
    user_id: userId || null,  // v1.10.6: WAJIB untuk Supabase upsert
    type: type || 'prompt',
    title: name || 'Grup Baru',
    body: '',
    tags: ['group'],
    category: 'group',
    source: {
      isGroup: true,
      groupType: type || 'prompt',
      capturedAt: now,
      device: 'pwa'
    },
    link_url: null,
    link_title: null,
    favorite: false,
    archived: false,
    use_count: 0,           // snake_case untuk Supabase
    last_used_at: null,
    screenshot_mode: null,
    screenshot_width: 0,
    screenshot_height: 0,
    screenshot_format: null,
    screenshot_bytes: 0,
    thumbnail_data_url: null,
    gdrive_file_id: null,
    gdrive_file_url: null,
    toppings: [],
    variables: [],
    created_at: now,         // snake_case untuk Supabase
    updated_at: now,
    deleted_at: null,
    device_id: 'pwa'
  };
}

// ===== Build tree dari flat items — RECURSIVE (nested folders) =====
// v3.18.4: Folder bisa berisi folder lagi. buildTree sekarang recursive.
//
// @param items - flat array of all vault items
// @param expandedIds - array of group IDs yang sedang di-expand
// @param categoryFilter - 'prompt' | 'link' | 'screenshot' | null (null = "Semua")
// @param showGroups - bool (ignored, selalu true sejak v3.18.2)
// @returns array of nodes: { kind: 'group'|'item', item, isExpanded, children: [node...] }

export function buildTree(items, expandedIds, categoryFilter, showGroups, sortMode) {
  // v3.19.0: sortMode — 'recent'|'name'|'oldest'|'uses'|'fav' (default: 'recent')
  const sm = sortMode || 'recent';

  // v1.11.1 FIX (defensive): Dedup by ID di awal buildTree.
  // Root cause bug "folder duplikat render": folder dengan type='prompt' + isGroup=true
  // bisa lolos filter di vault.js + masuk lagi via groupItems → array items punya id sama 2x.
  // buildTree tidak dedup → render 2x.
  // Safety net ini memastikan tidak ada duplikat regardless of input.
  if (items && items.length > 0) {
    const seenIds = new Set();
    const deduped = [];
    for (const it of items) {
      if (!it || !it.id) continue;
      if (seenIds.has(it.id)) {
        console.warn('[RecallFox/buildTree] Dedup: skipping duplicate id', it.id);
        continue;
      }
      seenIds.add(it.id);
      deduped.push(it);
    }
    items = deduped;
  }

  // v1.9.3 PWA: Build index
  const allByParent = new Map();
  const topLevel = [];

  // v1.9.5 FIX: Build set of all item IDs untuk cek orphan children.
  // Item dengan parentId ke folder yang TIDAK ADA di items array = orphan.
  // Orphan children harus tampil sebagai top-level (jangan hilangkan).
  const allIds = new Set(items.map(it => it.id));

  for (const it of items) {
    const pid = getParentId(it);
    if (pid && allIds.has(pid)) {
      // Parent exists — item masuk ke parent map
      if (!allByParent.has(pid)) allByParent.set(pid, []);
      allByParent.get(pid).push(it);
    } else {
      // No parent OR parent doesn't exist (orphan) → top-level
      topLevel.push(it);
    }
  }

  // v3.19.0: Sort function berdasarkan sortMode
  // v1.9.3 PWA: Pinned selalu di atas (kecuali mode 'name' — alfabetis murni).
  // Pattern sama dengan addon notes (pinnedFirst helper).
  function sortByMode(a, b) {
    // Groups always first
    const ag = isGroupItem(a) ? 0 : 1;
    const bg = isGroupItem(b) ? 0 : 1;
    if (ag !== bg) return ag - bg;

    // v1.9.3: Pinned first (kecuali mode 'name' — biar konsisten alfabetis)
    if (sm !== 'name') {
      const pa = isPinned(a) ? 0 : 1;
      const pb = isPinned(b) ? 0 : 1;
      if (pa !== pb) return pa - pb;
    }

    // Both groups or both items — sort by mode
    if (sm === 'name') return (a.title || '').localeCompare(b.title || '');
    if (sm === 'oldest') return new Date(a.createdAt || 0) - new Date(b.createdAt || 0);
    if (sm === 'uses') return (b.useCount || 0) - (a.useCount || 0);
    if (sm === 'fav') {
      // Pinned dulu (sudah di atas), lalu favorit, lalu recent
      const fa = a.favorite ? 0 : 1;
      const fb = b.favorite ? 0 : 1;
      if (fa !== fb) return fa - fb;
      return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
    }
    // default: recent (newest first)
    // Pinned: sort by pinnedAt desc supaya pin terbaru di paling atas
    if (isPinned(a) && isPinned(b)) {
      return new Date(getPinnedAt(b) || 0) - new Date(getPinnedAt(a) || 0);
    }
    return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
  }

  // Filter top-level by category
  const filteredTopLevel = topLevel.filter(it => {
    if (!categoryFilter) return true;
    if (isGroupItem(it)) return getGroupType(it) === categoryFilter;
    return it.type === categoryFilter ||
      (categoryFilter === 'screenshot' && it.type === 'document');
  });

  // Sort by mode
  filteredTopLevel.sort(sortByMode);

  // Recursive build
  function buildNode(it) {
    if (isGroupItem(it)) {
      // Group: cek apakah match categoryFilter
      if (categoryFilter && getGroupType(it) !== categoryFilter) return null;

      // Get all children (items + sub-groups) — sort by mode
      let children = (allByParent.get(it.id) || []).sort(sortByMode);

      // Filter children by category (hanya item biasa, bukan sub-group)
      if (categoryFilter) {
        children = children.filter(c =>
          isGroupItem(c) ||  // sub-groups selalu tampil
          c.type === categoryFilter ||
          (categoryFilter === 'screenshot' && c.type === 'document')
        );
      }

      // v3.18.2: Jangan skip empty groups di "Semua" (categoryFilter=null)
      if (categoryFilter && children.length === 0) return null;

      return {
        kind: 'group',
        item: it,
        isExpanded: expandedIds.includes(it.id),
        children: children.map(buildNode).filter(Boolean)
      };
    } else {
      // Regular item
      if (categoryFilter &&
          it.type !== categoryFilter &&
          !(categoryFilter === 'screenshot' && it.type === 'document')) return null;
      return { kind: 'item', item: it };
    }
  }

  return filteredTopLevel.map(buildNode).filter(Boolean);
}

// ===== AI Auto Group =====

export async function aiAutoGroup(items, chatFn) {
  if (!items || items.length < 2) return { ok: false, error: 'too_few_items' };
  if (!chatFn) return { ok: false, error: 'no_chat_fn' };

  const candidates = items.filter(it => !isGroupItem(it));
  if (candidates.length < 2) return { ok: false, error: 'too_few_items' };

  const prompt = `You are an assistant that groups items into folders.
Given these items (title + type), create 2-5 logical groups.
Return ONLY valid JSON: [{"name":"Group Name","itemIds":["id1","id2"]}]

Items:
${candidates.map(it => `- ${it.id} | ${it.title || 'Untitled'} | ${it.type}`).join('\n')}`;

  try {
    const result = await chatFn(prompt, { maxTokens: 800 });
    const text = typeof result === 'string' ? result : (result.text || result.content || '');
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return { ok: false, error: 'no_json_in_response' };
    const groups = JSON.parse(jsonMatch[0]);
    return { ok: true, groups };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
