// src/views/vault.js — Vault tab: render text-based items (prompt, context, snapshot, link, bundle)
// v1.7.0: Janji cross-device terpenuhi — semua tipe item tampil di PWA, bukan hanya screenshot/document/notes.
// v1.8.0: Folder tree support — folder yang dibuat di addon tampil di PWA (read-only + collapse).
//         Pakai buildTree dari lib/vault-tree.js (port dari addon).
//         Tampilan: indent saja, tanpa connector ├──/└── (mobile-friendly).
// v1.9.3: UX/UI overhaul:
//   1. Menu titik-tiga (⋯) per item → bottom sheet: Pin, Pindahkan ke Folder, Salin, Hapus
//   2. Pin/Sematkan — pinned item muncul di atas daftar (source.pinned + pinnedAt)
//   3. DnD dengan auto-scroll saat drag ke tepi atas/bawah
//   4. State update instan: dbPutVaultItem langsung + updateVaultItem cloud, renderList() (bukan reload)

import { dbGetAllVaultItems, dbPutVaultItem, dbDeleteVaultItem } from '../db.js';
import { deleteVaultItem, updateVaultItem, createNote } from '../sync.js';
// v1.10.0: Folder ops — rename/archive/delete/move dengan guards anti-crash.
import { renameFolder, archiveFolder, deleteFolder, moveFolder, cleanupOrphanFolders, findOrphanFolders } from '../lib/folder-ops.js';
import {
  buildTree, isGroupItem, getParentId, setParentId,
  isPinned, setPinned, createGroup
} from '../lib/vault-tree.js';

let _batchMode = false;
let _batchSelected = new Set();
let _onRefresh = null;
let _searchQuery = '';
let _filterType = 'all';
let _sortBy = 'recent';
let _expandedFolderIds = new Set();  // v1.8.0: folder yang di-expand
let _currentFolderId = null;  // v1.8.0: null = root, atau folder id untuk breadcrumb navigation
let _lastRenderToken = null;  // v1.9.2: token untuk detect renderList race condition
let _dndAutoScrollTimer = null;  // v1.9.3: timer untuk auto-scroll saat DnD
let _lastUserToggleAt = 0;  // v1.9.6: timestamp toggle folder terakhir (anti race dengan polling)
const USER_TOGGLE_GRACE_MS = 2000;  // polling skip re-render kalau < 2s setelah user toggle
let _firstRenderDone = false;  // v1.9.6: flag untuk auto-expand folder di first render

const TYPE_LABELS = {
  prompt: { label: 'Prompt', icon: '💬', color: '#10a37f' },
  context: { label: 'Konteks', icon: '📋', color: '#3b82f6' },
  snapshot: { label: 'Snapshot', icon: '📸', color: '#8b5cf6' },
  link: { label: 'Link', icon: '🔗', color: '#f59e0b' },
  bundle: { label: 'Bundle', icon: '📦', color: '#ec4899' }
};

const TEXT_TYPES = ['prompt', 'context', 'snapshot', 'link', 'bundle'];

export function renderVault(user, onRefresh) {
  _onRefresh = onRefresh;
  const main = document.getElementById('appMain');
  if (!main) return;
  main.innerHTML = `
    <div class="view-header">
      <h2>🗂️ Vault</h2>
      <div class="header-actions">
        <button class="icon-btn" id="vaultExpandAll" title="Buka semua folder">📂</button>
        <button class="icon-btn" id="vaultCollapseAll" title="Tutup semua folder">📁</button>
        <button class="icon-btn" id="vaultCleanupBtn" title="Bersihkan folder orphan (bug tampil)">🧹</button>
        <button class="icon-btn" id="vaultBatchToggle" title="Mode batch">☑️</button>
        <button class="icon-btn" id="vaultRefreshBtn" title="Refresh">↻</button>
      </div>
    </div>
    <div class="vault-toolbar">
      <input type="search" id="vaultSearch" placeholder="Cari prompt, konteks, snapshot..." enterkeyhint="search" autocomplete="off">
      <select id="vaultFilterType" title="Filter tipe">
        <option value="all">Semua</option>
        <option value="prompt">💬 Prompt</option>
        <option value="context">📋 Konteks</option>
        <option value="snapshot">📸 Snapshot</option>
        <option value="link">🔗 Link</option>
        <option value="bundle">📦 Bundle</option>
      </select>
      <select id="vaultSortBy" title="Urutkan">
        <option value="recent">Terbaru</option>
        <option value="favorite">Favorit</option>
        <option value="title">Judul A-Z</option>
      </select>
    </div>
    <div class="batch-bar" id="vaultBatchBar" style="display:none">
      <span id="vaultBatchCount">0 dipilih</span>
      <div class="batch-actions">
        <button class="btn btn-secondary" id="vaultBatchCopy">📋 Salin Teks</button>
        <button class="btn btn-danger" id="vaultBatchDelete">🗑️ Hapus</button>
        <button class="btn btn-ghost" id="vaultBatchCancel">✕</button>
      </div>
    </div>
    <div class="vault-list" id="vaultList"><div class="loading">Memuat...</div></div>
  `;

  document.getElementById('vaultRefreshBtn').addEventListener('click', () => onRefresh());
  document.getElementById('vaultBatchToggle').addEventListener('click', toggleBatchMode);
  document.getElementById('vaultBatchCancel').addEventListener('click', () => exitBatchMode());
  document.getElementById('vaultBatchCopy').addEventListener('click', () => doBatchCopy());
  document.getElementById('vaultBatchDelete').addEventListener('click', () => doBatchDelete());
  // v1.9.6: Expand/Collapse all folders
  document.getElementById('vaultExpandAll').addEventListener('click', expandAllFolders);
  document.getElementById('vaultCollapseAll').addEventListener('click', collapseAllFolders);
  // v1.10.0: Cleanup orphan folders — bersihkan folder yang parentId-nya invalid.
  document.getElementById('vaultCleanupBtn').addEventListener('click', doCleanupOrphanFolders);

  const searchInput = document.getElementById('vaultSearch');
  searchInput.addEventListener('input', (e) => {
    _searchQuery = e.target.value.toLowerCase();
    renderList();
  });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); renderList(); }
  });

  document.getElementById('vaultFilterType').addEventListener('change', (e) => {
    _filterType = e.target.value;
    renderList();
  });
  document.getElementById('vaultSortBy').addEventListener('change', (e) => {
    _sortBy = e.target.value;
    renderList();
  });

  renderList();
}

async function renderList() {
  const list = document.getElementById('vaultList');
  if (!list) return;

  // v1.9.2: Defensive — timeout 10s. Kalau renderList lebih dari 10s, tampilkan
  // error fallback "Gagal memuat" supaya tidak stuck "Memuat..." selamanya.
  // Sebelumnya: kalau ada exception atau IndexedDB lambat, list stuck "Memuat...".
  const renderToken = Symbol('renderList');
  _lastRenderToken = renderToken;
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    if (_lastRenderToken !== renderToken) return;  // sudah di-render oleh call lain
    if (list.innerHTML.includes('Memuat')) {
      timedOut = true;
      list.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">⚠️</div>
          <div class="empty-title">Memuat terlalu lama</div>
          <div class="empty-desc">Koneksi lambat atau IndexedDB sibuk. Ketuk refresh untuk coba lagi.</div>
        </div>`;
    }
  }, 10000);

  try {
    const allItems = await dbGetAllVaultItems();
    // v1.8.0: Filter TEXT_TYPES + folder groups (isGroup). Folder groups punya source.isGroup=true.
    let items = allItems.filter(i => TEXT_TYPES.includes(i.type) && !i.archived);
    // Include group items untuk tree rendering
    let groupItems = allItems.filter(i => isGroupItem(i) && !i.archived);

    // v1.10.1: Hapus folder "Builder" yang ngotori PWA (user request).
    // Cloud punya 0 isGroup items. "Builder" folder hanya ada di IndexedDB PWA
    // (artifact dari bug lama). Hapus dari IndexedDB — bukan dari cloud.
    const builderFolders = groupItems.filter(g =>
      (g.title || '').toLowerCase().trim() === 'builder'
    );
    if (builderFolders.length > 0) {
      console.warn('[RecallFox] Cleaning up "Builder" folder(s) from IndexedDB:', builderFolders.map(g => g.id));
      for (const g of builderFolders) {
        await dbDeleteVaultItem(g.id);
      }
      groupItems = groupItems.filter(g => (g.title || '').toLowerCase().trim() !== 'builder');
      console.log('[RecallFox] Cleaned', builderFolders.length, 'Builder folder(s)');
    }

    // v1.9.6 FIX BUG "2 folder Builder duplikat":
    // Cloud hanya 1 folder "Builder" (verified), tapi IndexedDB PWA bisa punya duplikat
    // karena bug sync_queue retry atau cache lama. Dedup by (user_id + title lowercase).
    // Keep folder dengan createdAt terbaru (paling baru dibuat), hapus yang lain dari IndexedDB.
    if (groupItems.length > 0) {
      const seen = new Map();  // key: user_id + '|' + title_lowercase → item
      const duplicates = [];
      for (const g of groupItems) {
        const key = (g.user_id || '') + '|' + (g.title || '').toLowerCase().trim();
        const existing = seen.get(key);
        if (!existing) {
          seen.set(key, g);
        } else {
          // Bandingkan createdAt — keep yang terbaru
          const existingDate = new Date(existing.created_at || existing.createdAt || 0);
          const newDate = new Date(g.created_at || g.createdAt || 0);
          if (newDate > existingDate) {
            duplicates.push(existing);
            seen.set(key, g);
          } else {
            duplicates.push(g);
          }
        }
      }
      if (duplicates.length > 0) {
        console.warn('[RecallFox] Found ' + duplicates.length + ' duplicate folder(s), cleaning up:', duplicates.map(d => ({ id: d.id, title: d.title })));
        // Cleanup IndexedDB: hapus duplikat (JANGAN hapus dari cloud — bisa jadi cloud-nya OK)
        for (const dup of duplicates) {
          try { await dbDeleteVaultItem(dup.id); } catch (e) {}
        }
        // Re-filter groupItems tanpa duplikat
        const dupIds = new Set(duplicates.map(d => d.id));
        groupItems = groupItems.filter(g => !dupIds.has(g.id));
      }
    }

    items = [...items, ...groupItems];

    // v1.9.6 FIX BUG "folder tidak bisa dibuka":
    // Auto-expand folder yang punya children di first render — supaya user
    // langsung lihat isinya tanpa perlu klik. Mencegah kondisi "folder kosong"
    // padahal sebenarnya punya children tapi collapse.
    if (!_firstRenderDone && groupItems.length > 0) {
      // Build map parentId → count children
      const childCountByParent = new Map();
      for (const it of items) {
        const pid = getParentId(it);
        if (pid) childCountByParent.set(pid, (childCountByParent.get(pid) || 0) + 1);
      }
      // Auto-expand folder yang punya children
      for (const g of groupItems) {
        if ((childCountByParent.get(g.id) || 0) > 0) {
          _expandedFolderIds.add(g.id);
        }
      }
      _firstRenderDone = true;
      console.log('[RecallFox] Auto-expanded folders with children:', Array.from(_expandedFolderIds));
    }

    // Filter by type (hanya untuk non-group items)
    if (_filterType !== 'all') {
      items = items.filter(i => isGroupItem(i) || i.type === _filterType);
    }

    // Search
    if (_searchQuery) {
      items = items.filter(i => {
        if (isGroupItem(i)) return (i.title || '').toLowerCase().includes(_searchQuery);
        const title = (i.title || '').toLowerCase();
        const body = (i.body || '').toLowerCase();
        const note = (i.note || '').toLowerCase();
        return title.includes(_searchQuery) || body.includes(_searchQuery) || note.includes(_searchQuery);
      });
    }

    // v1.8.0: Build tree dari items
    const expandedIds = Array.from(_expandedFolderIds);
    const categoryFilter = _filterType === 'all' ? null : _filterType;
    const sortMode = _sortBy === 'recent' ? 'recent'
                   : _sortBy === 'favorite' ? 'fav'
                   : _sortBy === 'title' ? 'name'
                   : 'recent';
    const tree = buildTree(items, expandedIds, categoryFilter, true, sortMode);

    if (tree.length === 0) {
      list.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">🗂️</div>
          <div class="empty-title">Belum ada item teks</div>
          <div class="empty-desc">Prompt, konteks, snapshot, link, dan bundle dari addon akan muncul di sini.</div>
        </div>`;
      return;
    }

    // v1.8.0: Render tree recursively dengan indent (no connector)
    let html = '';
    for (const node of tree) {
      html += renderTreeNode(node, 0);
    }
    list.innerHTML = html;

    // Wire event listeners
    // v1.8.6 FIX: Exclude folder divs from .vault-item click handler.
    // Folder divs have class "vault-item vault-folder" — they should only
    // respond to .folder-toggle click (expand/collapse), NOT openItemDetail.
    // Before: clicking folder triggered openItemDetail → copyItem → weird behavior.
    list.querySelectorAll('.vault-item:not(.vault-folder)').forEach(card => {
      const id = card.dataset.id;
      card.addEventListener('click', (e) => {
        if (_batchMode) {
          e.stopPropagation();
          toggleSelect(id, card);
        } else {
          openItemDetail(id);
        }
      });
    });

    // v1.8.0: Folder toggle (expand/collapse)
    list.querySelectorAll('.folder-toggle').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleFolder(btn.dataset.id);
      });
    });

    list.querySelectorAll('.item-fav').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleFavorite(btn.dataset.id);
      });
    });

    list.querySelectorAll('.item-copy').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        copyItem(btn.dataset.id);
      });
    });

    list.querySelectorAll('.item-delete').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        confirmDelete(btn.dataset.id);
      });
    });

    // v1.9.3: Item menu (⋯) → bottom sheet dengan opsi Pin/Move/Copy/Delete
    list.querySelectorAll('.item-menu').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openItemMenuSheet(btn.dataset.id);
      });
    });

    // v1.10.0: Folder menu (⋯) → bottom sheet dengan opsi Rename/Archive/Delete/Move
    list.querySelectorAll('.folder-menu').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openFolderMenuSheet(btn.dataset.id);
      });
    });

    // v1.9.3: Folder as drop target (move item into folder via DnD)
    list.querySelectorAll('.vault-folder').forEach(folder => {
      folder.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        folder.classList.add('drag-over');
      });
      folder.addEventListener('dragleave', () => folder.classList.remove('drag-over'));
      folder.addEventListener('drop', (e) => {
        e.preventDefault();
        folder.classList.remove('drag-over');
        const itemId = e.dataTransfer.getData('text/plain');
        if (itemId && itemId !== folder.dataset.id) {
          moveItemToFolder(itemId, folder.dataset.id);
        }
      });
    });

    // v1.9.3: Drop to top-level (vault-list itu sendiri) = unparent
    list.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    });
    list.addEventListener('drop', (e) => {
      // Hanya trigger kalau drop target = list itu sendiri (bukan item/folder)
      if (e.target === list) {
        e.preventDefault();
        const itemId = e.dataTransfer.getData('text/plain');
        if (itemId) {
          // Drop ke area kosong = keluarkan dari folder (parentId = null)
          moveItemToFolder(itemId, null);
        }
      }
    });

    // v1.9.3: Make items draggable (anti long-distance scroll issue)
    list.querySelectorAll('.vault-item:not(.vault-folder)').forEach(card => {
      card.setAttribute('draggable', 'true');
      card.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', card.dataset.id);
        e.dataTransfer.effectAllowed = 'move';
        card.classList.add('dragging');
      });
      card.addEventListener('dragend', () => {
        card.classList.remove('dragging');
        stopDndAutoScroll();
      });
      // Auto-scroll saat drag mendekati tepi atas/bawah
      card.addEventListener('drag', (e) => handleDndAutoScroll(e));
    });
  } catch (e) {
    console.error('[RecallFox] renderVaultList error:', e);
    list.innerHTML = `<div class="error-state">Gagal memuat: ${escapeHtml(e.message)}</div>`;
  } finally {
    // v1.9.2: Clear timeout + invalidate token supaya race-condition tidak trigger fallback
    clearTimeout(timeoutId);
    if (_lastRenderToken === renderToken) _lastRenderToken = null;
  }
}

// v1.8.0: Render tree node — group (folder) atau item biasa.
// Indent dengan padding-left, no connector lines (mobile-friendly).
// v1.10.0: Tambah tombol menu (⋯) di folder card untuk rename/hapus/arsip/pindah.
function renderTreeNode(node, depth) {
  const indent = depth * 16;  // 16px per level
  if (node.kind === 'group') {
    const folder = node.item;
    const isExpanded = node.isExpanded;
    const folderColor = folder.source?.folderColor || '#6b7280';
    const childCount = node.children?.length || 0;
    let html = `
      <div class="vault-item vault-folder" data-id="${folder.id}" style="margin-left:${indent}px;border-left:3px solid ${folderColor}">
        <div class="folder-toggle" data-id="${folder.id}" title="${isExpanded ? 'Lipat' : 'Buka'}">
          ${isExpanded ? '📂' : '📁'} ${escapeHtml(folder.title || 'Folder')}
          <span class="folder-count">${childCount}</span>
        </div>
        <button class="folder-menu" data-id="${folder.id}" title="Edit folder" aria-label="Edit folder">⋯</button>
      </div>
    `;
    if (isExpanded && node.children) {
      for (const child of node.children) {
        html += renderTreeNode(child, depth + 1);
      }
    }
    return html;
  } else {
    // Regular item — pakai renderItemCard dengan indent
    const item = node.item;
    return renderItemCard(item, indent);
  }
}

// v1.8.0: Toggle folder expand/collapse
// v1.9.6: Tambah logging + set _lastUserToggleAt untuk anti-race dengan polling
function toggleFolder(folderId) {
  if (!folderId) {
    console.warn('[RecallFox] toggleFolder: no folderId');
    return;
  }
  const wasExpanded = _expandedFolderIds.has(folderId);
  if (wasExpanded) {
    _expandedFolderIds.delete(folderId);
  } else {
    _expandedFolderIds.add(folderId);
  }
  _lastUserToggleAt = Date.now();
  console.log('[RecallFox] toggleFolder:', folderId, '→', wasExpanded ? 'collapsed' : 'expanded', '— expanded set:', Array.from(_expandedFolderIds));
  renderList();
}

// v1.9.6: Expand all folders
function expandAllFolders() {
  // Ambil semua folder id dari IndexedDB
  (async () => {
    const allItems = await dbGetAllVaultItems();
    const groupItems = allItems.filter(i => isGroupItem(i) && !i.archived);
    groupItems.forEach(g => _expandedFolderIds.add(g.id));
    _lastUserToggleAt = Date.now();
    console.log('[RecallFox] Expanded all folders:', Array.from(_expandedFolderIds));
    renderList();
  })();
}

// v1.9.6: Collapse all folders
function collapseAllFolders() {
  _expandedFolderIds.clear();
  _lastUserToggleAt = Date.now();
  console.log('[RecallFox] Collapsed all folders');
  renderList();
}

// v1.10.0: Cleanup orphan folders — bersihkan folder yang parentId-nya menunjuk
// ke folder yang sudah dihapus (bug tampil yang user maksud "folder ngotorin").
// Aman: hanya set parentId=null, tidak hapus data.
async function doCleanupOrphanFolders() {
  showToast('🧹 Mencari folder orphan...');
  const orphans = await findOrphanFolders();
  if (orphans.length === 0) {
    showToast('✓ Tidak ada folder orphan — vault sudah bersih');
    return;
  }
  const names = orphans.map(o => `• ${o.title || o.id}`).join('\n');
  if (!confirm(`Ditemukan ${orphans.length} folder orphan (bug tampil):\n\n${names}\n\nBersihkan? Folder akan dijadikan top-level (parentId=null). Data tidak dihapus.`)) return;
  showToast('🧹 Membersihkan...');
  const result = await cleanupOrphanFolders(window.__rfUser);
  if (result.ok) {
    showToast(`✓ ${result.cleanedCount} folder orphan dibersihkan`);
    renderList();
  } else {
    showToast('✗ ' + (result.error || 'Gagal cleanup'));
  }
}

// v1.9.6: Export helper untuk anti-race dengan polling di main.js
// main.js polling 10s akan cek ini sebelum re-render vault — kalau user
// baru saja toggle folder, skip re-render supaya tidak override visual state.
export function isUserTogglingFolders() {
  return (Date.now() - _lastUserToggleAt) < USER_TOGGLE_GRACE_MS;
}

function renderItemCard(item, indent = 0) {
  const typeInfo = TYPE_LABELS[item.type] || { label: item.type, icon: '📄', color: '#6b7280' };
  const isFav = item.favorite ? '⭐' : '☆';
  const pinned = isPinned(item);  // v1.9.3
  const title = escapeHtml(item.title || 'Tanpa judul');
  const body = escapeHtml(truncateText(item.body || item.note || '', 150));
  const tags = (item.tags && item.tags.length) ? item.tags.map(t => `<span class="tag">#${escapeHtml(t)}</span>`).join('') : '';
  const isSelected = _batchSelected.has(item.id) ? 'selected' : '';
  const pinnedCls = pinned ? 'is-pinned' : '';  // v1.9.3
  const pinnedBadge = pinned ? '<span class="pinned-badge" title="Disematkan">📌</span>' : '';  // v1.9.3
  // v1.8.0: GPS location display (jika ada)
  const location = item.source?.location;
  const locationInfo = location ? `<div class="item-location">📍 ${escapeHtml(location.address || (location.lat?.toFixed(4) + ', ' + location.lng?.toFixed(4)))}</div>` : '';

  // Untuk link, tampilkan URL
  let linkInfo = '';
  if (item.type === 'link' && item.link_url) {
    linkInfo = `<div class="item-link"><a href="${escapeHtml(item.link_url)}" target="_blank" rel="noopener">${escapeHtml(item.link_url)}</a></div>`;
  }

  // Untuk snapshot, tampilkan domain + message count
  let snapshotInfo = '';
  if (item.type === 'snapshot') {
    const domain = item.snapshotDomain || (item.source?.url ? new URL(item.source.url).hostname : '');
    const count = item.snapshotMessageCount || 0;
    if (domain || count) {
      snapshotInfo = `<div class="item-meta">${domain ? `🌐 ${escapeHtml(domain)}` : ''} ${count ? ` · ${count} pesan` : ''}</div>`;
    }
  }

  // Untuk bundle, tampilkan jumlah item
  let bundleInfo = '';
  if (item.type === 'bundle' && item.item_ids) {
    const count = Array.isArray(item.item_ids) ? item.item_ids.length : 0;
    bundleInfo = `<div class="item-meta">📦 ${count} item</div>`;
  }

  return `
    <div class="vault-item ${isSelected} ${pinnedCls}" data-id="${item.id}" style="margin-left:${indent}px">
      <div class="item-type-badge" style="background:${typeInfo.color}">${typeInfo.icon}</div>
      <div class="item-content">
        <div class="item-title">${pinnedBadge}${title}</div>
        ${body ? `<div class="item-body">${body}</div>` : ''}
        ${linkInfo}
        ${snapshotInfo}
        ${bundleInfo}
        ${locationInfo}
        ${tags ? `<div class="item-tags">${tags}</div>` : ''}
      </div>
      <div class="item-actions">
        <button class="item-fav" data-id="${item.id}" title="Favorit">${isFav}</button>
        <button class="item-menu" data-id="${item.id}" title="Menu">⋯</button>
      </div>
    </div>
  `;
}

function openItemDetail(id) {
  // TODO: open detail modal (future enhancement)
  // Untuk v1.7.0, klik item = copy body ke clipboard
  copyItem(id);
}

async function toggleFavorite(id) {
  try {
    const items = await dbGetAllVaultItems();
    const item = items.find(i => i.id === id);
    if (!item) return;
    const newFav = !item.favorite;
    await updateVaultItem(window.__rfUser, id, { favorite: newFav });
    renderList();
  } catch (e) {
    console.error('[RecallFox] toggleFavorite error:', e);
  }
}

async function copyItem(id) {
  try {
    const items = await dbGetAllVaultItems();
    const item = items.find(i => i.id === id);
    if (!item) return;
    const text = item.body || item.note || item.title || '';
    await navigator.clipboard.writeText(text);
    showToast('✓ Disalin');
  } catch (e) {
    console.error('[RecallFox] copyItem error:', e);
    showToast('Gagal salin: ' + e.message);
  }
}

function confirmDelete(id) {
  if (!confirm('Hapus item ini?')) return;
  doDelete(id);
}

async function doDelete(id) {
  try {
    await deleteVaultItem(window.__rfUser, id);
    showToast('✓ Dihapus');
    renderList();
  } catch (e) {
    console.error('[RecallFox] doDelete error:', e);
    showToast('Gagal hapus: ' + e.message);
  }
}

// ============================================================
// v1.9.3: Item Menu Sheet (⋯) — Pin, Move, Copy, Delete
// ============================================================
function openItemMenuSheet(itemId) {
  // Buat sheet sekali pakai
  const sheet = document.createElement('div');
  sheet.className = 'bottom-sheet';
  sheet.innerHTML = `
    <div class="sheet-backdrop"></div>
    <div class="sheet-content">
      <div class="sheet-handle"></div>
      <div id="itemMenuBody">Memuat...</div>
    </div>
  `;
  document.body.appendChild(sheet);
  // Animasi open
  requestAnimationFrame(() => sheet.classList.add('open'));

  const close = () => {
    sheet.classList.remove('open');
    setTimeout(() => sheet.remove(), 250);
  };
  sheet.querySelector('.sheet-backdrop').addEventListener('click', close);

  // Render body async (perlu ambil item dari IndexedDB)
  (async () => {
    const items = await dbGetAllVaultItems();
    const item = items.find(i => i.id === itemId);
    if (!item) { close(); return; }
    const pinned = isPinned(item);
    const typeLabel = TYPE_LABELS[item.type]?.label || item.type;
    const title = escapeHtml(truncateText(item.title || 'Tanpa judul', 50));

    const body = sheet.querySelector('#itemMenuBody');
    body.innerHTML = `
      <h3 style="margin-bottom:8px;font-size:15px">${typeLabel} · ${title}</h3>
      <button class="sheet-btn" data-action="edit">✏️ Edit Judul & Isi</button>
      <button class="sheet-btn" data-action="pin">${pinned ? '📌 Lepas Sematan' : '📌 Sematkan ke Atas'}</button>
      <button class="sheet-btn" data-action="move">📂 Pindahkan ke Folder...</button>
      <button class="sheet-btn" data-action="copy">📋 Salin Teks</button>
      <button class="sheet-btn" data-action="fav">${item.favorite ? '⭐ Lepas Favorit' : '⭐ Tandai Favorit'}</button>
      <button class="sheet-btn" data-action="archive">${item.archived ? '📤 Keluarkan dari Arsip' : '📦 Arsipkan'}</button>
      ${item.type === 'screenshot' || item.type === 'document' ? '<button class="sheet-btn" data-action="annot">📝 Edit Catatan Anotasi</button>' : ''}
      <button class="sheet-btn cancel" data-action="delete" style="color:#ef4444">🗑️ Hapus</button>
      <button class="sheet-btn cancel" data-action="close">✕ Tutup</button>
    `;

    body.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const action = btn.dataset.action;
        close();
        // Delay supaya sheet close animasi selesai dulu
        setTimeout(async () => {
          if (action === 'pin') await togglePin(itemId);
          else if (action === 'move') openMoveToFolderSheet(itemId);
          else if (action === 'copy') copyItem(itemId);
          else if (action === 'fav') toggleFavorite(itemId);
          else if (action === 'archive') toggleArchiveItem(itemId);
          else if (action === 'edit') openEditItemSheet(itemId);
          else if (action === 'annot') openEditAnnotationSheet(itemId);
          else if (action === 'delete') confirmDelete(itemId);
        }, 100);
      });
    });
  })();
}

// ============================================================
// v1.10.0: Folder Menu Sheet — rename/archive/delete/move folder
// Semua operasi pakai lib/folder-ops.js yang punya guards anti-crash.
// ============================================================
function openFolderMenuSheet(folderId) {
  const sheet = document.createElement('div');
  sheet.className = 'bottom-sheet';
  sheet.innerHTML = `
    <div class="sheet-backdrop"></div>
    <div class="sheet-content">
      <div class="sheet-handle"></div>
      <div id="folderMenuBody">Memuat...</div>
    </div>
  `;
  document.body.appendChild(sheet);
  requestAnimationFrame(() => sheet.classList.add('open'));

  const close = () => {
    sheet.classList.remove('open');
    setTimeout(() => sheet.remove(), 250);
  };
  sheet.querySelector('.sheet-backdrop').addEventListener('click', close);

  (async () => {
    const items = await dbGetAllVaultItems();
    const folder = items.find(i => i.id === folderId && isGroupItem(i));
    if (!folder) {
      showToast('Folder tidak ditemukan');
      close();
      return;
    }
    // Hitung jumlah children (depth=1 saja untuk display)
    const directChildren = items.filter(i => getParentId(i) === folderId);
    const title = escapeHtml(truncateText(folder.title || 'Folder', 50));

    const body = sheet.querySelector('#folderMenuBody');
    body.innerHTML = `
      <h3 style="margin-bottom:8px;font-size:15px">📁 ${title}</h3>
      <div style="font-size:11px;color:var(--text-muted);margin-bottom:12px">${directChildren.length} item langsung di folder ini</div>
      <button class="sheet-btn" data-action="rename">✏️ Ganti Nama</button>
      <button class="sheet-btn" data-action="archive">📦 Arsipkan (folder + isi)</button>
      <button class="sheet-btn" data-action="move">📂 Pindahkan ke Folder...</button>
      <button class="sheet-btn" data-action="delete-keep" style="color:#d97706">🗑️ Hapus Folder (pertahankan isi)</button>
      <button class="sheet-btn cancel" data-action="delete-all" style="color:#ef4444">⚠️ Hapus Folder + Semua Isi</button>
      <button class="sheet-btn cancel" data-action="close">✕ Tutup</button>
    `;

    body.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const action = btn.dataset.action;
        close();
        setTimeout(async () => {
          if (action === 'rename') promptRenameFolder(folderId, folder.title);
          else if (action === 'archive') doArchiveFolder(folderId);
          else if (action === 'move') promptMoveFolder(folderId);
          else if (action === 'delete-keep') doDeleteFolder(folderId, 'keep-children');
          else if (action === 'delete-all') doDeleteFolder(folderId, 'delete-all');
        }, 100);
      });
    });
  })();
}

// v1.10.0: Prompt rename folder via inline modal (bukan prompt() native)
function promptRenameFolder(folderId, currentName) {
  const sheet = document.createElement('div');
  sheet.className = 'bottom-sheet';
  sheet.innerHTML = `
    <div class="sheet-backdrop"></div>
    <div class="sheet-content">
      <div class="sheet-handle"></div>
      <h3 style="margin-bottom:8px;font-size:15px">✏️ Ganti Nama Folder</h3>
      <input type="text" id="renameInput" value="${escapeHtml(currentName || '')}" maxlength="100"
        style="width:100%;padding:10px;border:1px solid var(--border);border-radius:8px;font-size:14px;margin-bottom:12px;background:var(--surface);color:var(--text)">
      <div style="display:flex;gap:8px">
        <button class="sheet-btn cancel" data-action="cancel" style="flex:1">Batal</button>
        <button class="sheet-btn" data-action="save" style="flex:1;background:var(--primary);color:#fff">Simpan</button>
      </div>
    </div>
  `;
  document.body.appendChild(sheet);
  requestAnimationFrame(() => {
    sheet.classList.add('open');
    const input = sheet.querySelector('#renameInput');
    if (input) { input.focus(); input.select(); }
  });

  const close = () => {
    sheet.classList.remove('open');
    setTimeout(() => sheet.remove(), 250);
  };
  sheet.querySelector('.sheet-backdrop').addEventListener('click', close);

  const doRename = async () => {
    const newName = sheet.querySelector('#renameInput').value;
    close();
    setTimeout(async () => {
      const result = await renameFolder(window.__rfUser, folderId, newName);
      if (result.ok) {
        showToast('✓ Folder di-rename');
        renderList();
      } else {
        showToast('✗ ' + (result.error || 'Gagal rename'));
      }
    }, 100);
  };

  sheet.querySelector('[data-action="cancel"]').addEventListener('click', close);
  sheet.querySelector('[data-action="save"]').addEventListener('click', doRename);
  sheet.querySelector('#renameInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); doRename(); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
}

// v1.10.0: Archive folder + semua isinya
async function doArchiveFolder(folderId) {
  if (!confirm('Arsipkan folder dan semua isinya?\n\nItem tidak dihapus — bisa di-unarchive nanti di addon.')) return;
  showToast('📦 Mengarsipkan...');
  const result = await archiveFolder(window.__rfUser, folderId);
  if (result.ok) {
    showToast(`✓ Folder diarsipkan (${result.archivedCount} item)`);
    renderList();
  } else {
    showToast('✗ ' + (result.error || 'Gagal arsip'));
  }
}

// v1.10.0: Delete folder — 2 mode
async function doDeleteFolder(folderId, mode) {
  const msg = mode === 'delete-all'
    ? '⚠️ HAPUS FOLDER + SEMUA ISI?\n\nIni tidak bisa dibatalkan. Semua item di dalam folder (termasuk sub-folder) akan dihapus permanen.'
    : 'Hapus folder ini?\n\nIsi folder akan dipertahankan — item jadi top-level, sub-folder jadi folder root.';
  if (!confirm(msg)) return;
  showToast('🗑️ Menghapus...');
  const result = await deleteFolder(window.__rfUser, folderId, mode);
  if (result.ok) {
    if (mode === 'delete-all') {
      showToast(`✓ Folder + ${result.deletedCount} item dihapus`);
    } else {
      showToast(`✓ Folder dihapus (${result.unparentedCount} item jadi top-level)`);
    }
    renderList();
  } else {
    showToast('✗ ' + (result.error || 'Gagal hapus'));
  }
}

// v1.10.0: Prompt pilih parent folder baru (move folder)
function promptMoveFolder(folderId) {
  (async () => {
    const allItems = await dbGetAllVaultItems();
    const folder = allItems.find(i => i.id === folderId);
    if (!folder) return;
    const currentParent = getParentId(folder);

    // Ambil semua folder lain (exclude diri sendiri + descendants untuk anti-loop)
    const allFolders = allItems.filter(i => isGroupItem(i) && !i.archived && i.id !== folderId);

    const sheet = document.createElement('div');
    sheet.className = 'bottom-sheet';
    sheet.innerHTML = `
      <div class="sheet-backdrop"></div>
      <div class="sheet-content" style="max-height:80vh;overflow-y:auto">
        <div class="sheet-handle"></div>
        <h3 style="margin-bottom:8px;font-size:15px">📂 Pindahkan Folder</h3>
        <button class="sheet-btn" data-action="root" style="${!currentParent ? 'background:var(--primary-soft);color:var(--primary)' : ''}">📁 Root (top-level) ${!currentParent ? '✓' : ''}</button>
        <div id="folderListBody"></div>
        <button class="sheet-btn cancel" data-action="close">✕ Tutup</button>
      </div>
    `;
    document.body.appendChild(sheet);
    requestAnimationFrame(() => sheet.classList.add('open'));

    const close = () => {
      sheet.classList.remove('open');
      setTimeout(() => sheet.remove(), 250);
    };
    sheet.querySelector('.sheet-backdrop').addEventListener('click', close);
    sheet.querySelector('[data-action="close"]').addEventListener('click', close);

    const listBody = sheet.querySelector('#folderListBody');
    if (allFolders.length === 0) {
      listBody.innerHTML = '<div style="padding:12px;color:var(--text-muted);font-size:12px;text-align:center">Belum ada folder lain</div>';
    } else {
      listBody.innerHTML = allFolders.map(f => {
        const isCurrent = currentParent === f.id;
        return `<button class="sheet-btn" data-folder-id="${f.id}" style="${isCurrent ? 'background:var(--primary-soft);color:var(--primary)' : ''}">📁 ${escapeHtml(f.title || 'Folder')} ${isCurrent ? '✓' : ''}</button>`;
      }).join('');
      listBody.querySelectorAll('[data-folder-id]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const newParentId = btn.dataset.folderId;
          close();
          setTimeout(async () => {
            const result = await moveFolder(window.__rfUser, folderId, newParentId);
            if (result.ok) {
              showToast('✓ Folder dipindahkan');
              renderList();
            } else {
              showToast('✗ ' + (result.error || 'Gagal pindah'));
            }
          }, 100);
        });
      });
    }

    sheet.querySelector('[data-action="root"]').addEventListener('click', async () => {
      close();
      setTimeout(async () => {
        const result = await moveFolder(window.__rfUser, folderId, null);
        if (result.ok) {
          showToast('✓ Folder dipindahkan ke root');
          renderList();
        } else {
          showToast('✗ ' + (result.error || 'Gagal pindah'));
        }
      }, 100);
    });
  })();
}

// ============================================================
// v1.9.3: Move To Folder Sheet — pilih folder dari daftar tree
// ============================================================
function openMoveToFolderSheet(itemId) {
  (async () => {
    const allItems = await dbGetAllVaultItems();
    const item = allItems.find(i => i.id === itemId);
    if (!item) return;
    const currentParent = getParentId(item);

    // Ambil semua folder (group items), exclude item itself
    const allFolders = allItems.filter(i => isGroupItem(i) && !i.archived && i.id !== itemId);
    if (allFolders.length === 0) {
      showToast('Belum ada folder. Buat folder dulu di addon.');
      return;
    }

    const sheet = document.createElement('div');
    sheet.className = 'bottom-sheet';
    sheet.innerHTML = `
      <div class="sheet-backdrop"></div>
      <div class="sheet-content" style="max-height:80vh;overflow-y:auto">
        <div class="sheet-handle"></div>
        <h3 style="margin-bottom:8px;font-size:15px">📂 Pindahkan ke Folder</h3>
        <div id="folderListBody"></div>
      </div>
    `;
    document.body.appendChild(sheet);
    requestAnimationFrame(() => sheet.classList.add('open'));

    const close = () => {
      sheet.classList.remove('open');
      setTimeout(() => sheet.remove(), 250);
    };
    sheet.querySelector('.sheet-backdrop').addEventListener('click', close);

    const list = sheet.querySelector('#folderListBody');
    let html = `<button class="sheet-btn" data-fid="" style="${!currentParent ? 'background:#ede9fe;font-weight:700' : ''}">📤 Top-level (keluarkan dari folder)${!currentParent ? ' ✓' : ''}</button>`;

    // Build folder tree untuk display nested
    const nodes = buildTree(allFolders, [], null, true, 'name');
    function renderFolderOption(node, depth) {
      if (node.kind === 'group') {
        const indent = '&nbsp;&nbsp;&nbsp;&nbsp;'.repeat(depth);
        const isCurrent = currentParent === node.item.id;
        const folderColor = node.item.source?.folderColor || '#6b7280';
        html += `<button class="sheet-btn" data-fid="${node.item.id}" style="${isCurrent ? 'background:#ede9fe;font-weight:700' : ''};text-align:left">`
          + `<span style="display:inline-block;width:4px;height:16px;background:${folderColor};border-radius:2px;margin-right:8px;vertical-align:middle"></span>`
          + `${indent}📁 ${escapeHtml(node.item.title || 'Folder')}${isCurrent ? ' ✓' : ''}`
          + `</button>`;
        if (node.children) node.children.forEach(c => renderFolderOption(c, depth + 1));
      }
    }
    nodes.forEach(n => renderFolderOption(n, 0));
    list.innerHTML = html;

    list.querySelectorAll('[data-fid]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const fid = btn.dataset.fid || null;
        close();
        setTimeout(() => moveItemToFolder(itemId, fid), 100);
      });
    });
  })();
}

// ============================================================
// v1.9.3: Move item to folder — update source.parentId lokal + cloud
// ============================================================
async function moveItemToFolder(itemId, targetFolderId) {
  try {
    const items = await dbGetAllVaultItems();
    const item = items.find(i => i.id === itemId);
    if (!item) return;
    const oldParent = getParentId(item);
    if (oldParent === targetFolderId) {
      showToast('Item sudah di folder ini');
      return;
    }
    // Anti circular: kalau item adalah group, pastikan targetFolderId bukan descendant-nya
    if (targetFolderId && isGroupItem(item)) {
      let current = targetFolderId;
      while (current) {
        if (current === itemId) {
          showToast('⚠ Tidak bisa pindah folder ke dalam dirinya sendiri');
          return;
        }
        const parent = items.find(i => i.id === current);
        current = parent ? getParentId(parent) : null;
      }
    }
    // Update source.parentId
    if (!item.source) item.source = {};
    setParentId(item, targetFolderId);
    // v1.9.3: Auto-expand target folder supaya user langsung lihat item yang dipindah
    if (targetFolderId) _expandedFolderIds.add(targetFolderId);
    // Update lokal instan (user langsung lihat perubahan)
    await dbPutVaultItem(item);
    // Update cloud (async, tidak block UI)
    await updateVaultItem(window.__rfUser, itemId, { source: item.source });
    showToast(targetFolderId ? '✓ Dipindahkan ke folder' : '✓ Dikeluarkan dari folder');
    renderList();
  } catch (e) {
    console.error('[RecallFox] moveItemToFolder error:', e);
    showToast('Gagal pindahkan: ' + e.message);
  }
}

// ============================================================
// v1.9.3: Toggle Pin — sematkan/lepas item ke atas daftar
// ============================================================
async function togglePin(itemId) {
  try {
    const items = await dbGetAllVaultItems();
    const item = items.find(i => i.id === itemId);
    if (!item) return;
    const newPinned = !isPinned(item);
    setPinned(item, newPinned);
    // Update lokal instan
    await dbPutVaultItem(item);
    // Update cloud
    await updateVaultItem(window.__rfUser, itemId, { source: item.source });
    showToast(newPinned ? '📌 Disematkan ke atas' : 'Pin dilepas');
    renderList();
  } catch (e) {
    console.error('[RecallFox] togglePin error:', e);
    showToast('Gagal pin: ' + e.message);
  }
}

// ============================================================
// v1.9.3: Auto-scroll saat DnD mendekati tepi atas/bawah
// Solusi untuk "item di bawah sulit dipindah ke folder di atas"
// ============================================================
function handleDndAutoScroll(e) {
  // e.clientY = posisi cursor relatif viewport
  // clientY < 100 → scroll ke atas, clientY > window.innerHeight - 100 → scroll ke bawah
  const EDGE = 80;  // px dari tepi untuk trigger
  const SPEED = 15;  // px per frame
  const clientY = e.clientY;
  if (clientY == null || isNaN(clientY)) return;

  stopDndAutoScroll();  // clear timer lama

  let direction = 0;
  if (clientY < EDGE) direction = -1;
  else if (clientY > window.innerHeight - EDGE) direction = 1;

  if (direction !== 0) {
    _dndAutoScrollTimer = setInterval(() => {
      // Scroll container utama (bisa window atau .app-main)
      const main = document.getElementById('appMain');
      if (main) {
        main.scrollBy(0, direction * SPEED);
      } else {
        window.scrollBy(0, direction * SPEED);
      }
    }, 16);  // ~60fps
  }
}

function stopDndAutoScroll() {
  if (_dndAutoScrollTimer) {
    clearInterval(_dndAutoScrollTimer);
    _dndAutoScrollTimer = null;
  }
}

function toggleBatchMode() {
  _batchMode = !_batchMode;
  _batchSelected.clear();
  document.getElementById('vaultBatchBar').style.display = _batchMode ? 'flex' : 'none';
  document.getElementById('vaultBatchToggle').classList.toggle('active', _batchMode);
  renderList();
}

function exitBatchMode() {
  _batchMode = false;
  _batchSelected.clear();
  document.getElementById('vaultBatchBar').style.display = 'none';
  document.getElementById('vaultBatchToggle').classList.remove('active');
  renderList();
}

function toggleSelect(id, card) {
  if (_batchSelected.has(id)) {
    _batchSelected.delete(id);
    card.classList.remove('selected');
  } else {
    _batchSelected.add(id);
    card.classList.add('selected');
  }
  document.getElementById('vaultBatchCount').textContent = _batchSelected.size + ' dipilih';
}

async function doBatchCopy() {
  if (_batchSelected.size === 0) return;
  try {
    const items = await dbGetAllVaultItems();
    const selected = items.filter(i => _batchSelected.has(i.id));
    const text = selected.map(i => {
      const typeLabel = TYPE_LABELS[i.type]?.label || i.type;
      return `=== ${typeLabel}: ${i.title || 'Tanpa judul'} ===\n${i.body || i.note || ''}`;
    }).join('\n\n');
    await navigator.clipboard.writeText(text);
    showToast(`✓ ${selected.length} item disalin`);
    exitBatchMode();
  } catch (e) {
    showToast('Gagal: ' + e.message);
  }
}

async function doBatchDelete() {
  if (_batchSelected.size === 0) return;
  if (!confirm(`Hapus ${_batchSelected.size} item?`)) return;
  try {
    for (const id of _batchSelected) {
      await deleteVaultItem(window.__rfUser, id);
    }
    showToast(`✓ ${_batchSelected.size} item dihapus`);
    exitBatchMode();
  } catch (e) {
    showToast('Gagal: ' + e.message);
  }
}

function truncateText(text, maxLen) {
  if (!text) return '';
  // Strip HTML tags untuk preview
  const stripped = String(text).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return stripped.length > maxLen ? stripped.slice(0, maxLen) + '...' : stripped;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function showToast(msg) {
  let t = document.getElementById('rfToast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'rfToast';
    t.className = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2000);
}

// ============================================================
// v1.10.3 TIER 1: Fitur baru — Arsip, Edit, Buat Folder, Edit Anotasi
// ============================================================

// v1.10.3: Toggle archive item (single item, bukan folder)
async function toggleArchiveItem(itemId) {
  try {
    const items = await dbGetAllVaultItems();
    const item = items.find(i => i.id === itemId);
    if (!item) return;
    const newVal = !item.archived;
    // Update lokal instan
    item.archived = newVal;
    await dbPutVaultItem(item);
    // Update cloud
    await updateVaultItem(window.__rfUser, itemId, { archived: newVal });
    showToast(newVal ? '📦 Diarsipkan' : '📤 Dikeluarkan dari arsip');
    renderList();
  } catch (e) {
    console.error('[RecallFox] toggleArchiveItem error:', e);
    showToast('Gagal: ' + e.message);
  }
}

// v1.10.3: Edit item (judul + isi + tag) — bottom sheet dengan textarea
function openEditItemSheet(itemId) {
  const sheet = document.createElement('div');
  sheet.className = 'bottom-sheet';
  sheet.innerHTML = `
    <div class="sheet-backdrop"></div>
    <div class="sheet-content" style="max-height:80vh;overflow-y:auto">
      <div class="sheet-handle"></div>
      <div id="editItemBody">Memuat...</div>
    </div>
  `;
  document.body.appendChild(sheet);
  requestAnimationFrame(() => sheet.classList.add('open'));
  const close = () => {
    sheet.classList.remove('open');
    setTimeout(() => sheet.remove(), 250);
  };
  sheet.querySelector('.sheet-backdrop').addEventListener('click', close);

  (async () => {
    const items = await dbGetAllVaultItems();
    const item = items.find(i => i.id === itemId);
    if (!item) { close(); return; }

    const body = sheet.querySelector('#editItemBody');
    const tagsStr = Array.isArray(item.tags) ? item.tags.join(', ') : (item.tags || '');
    body.innerHTML = `
      <h3 style="margin-bottom:12px;font-size:15px">✏️ Edit Item</h3>
      <label style="display:block;font-size:12px;color:var(--text-muted);margin-bottom:4px;font-weight:600">Judul</label>
      <input id="editTitle" type="text" value="${escapeHtml(item.title || '')}" placeholder="Judul..."
        style="width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:8px;font-size:14px;box-sizing:border-box;margin-bottom:10px">
      <label style="display:block;font-size:12px;color:var(--text-muted);margin-bottom:4px;font-weight:600">Isi</label>
      <textarea id="editBody" rows="8" placeholder="Isi prompt/konteks..."
        style="width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:8px;font-size:13px;box-sizing:border-box;margin-bottom:10px;font-family:monospace;resize:vertical">${escapeHtml(item.body || '')}</textarea>
      <label style="display:block;font-size:12px;color:var(--text-muted);margin-bottom:4px;font-weight:600">Tag (pisahkan dengan koma)</label>
      <input id="editTags" type="text" value="${escapeHtml(tagsStr)}" placeholder="tag1, tag2..."
        style="width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:8px;font-size:14px;box-sizing:border-box;margin-bottom:14px">
      <div style="display:flex;gap:8px">
        <button class="btn btn-ghost" id="editCancel" style="flex:1;padding:10px;border:1px solid var(--border);border-radius:8px;font-size:13px;font-weight:600;cursor:pointer">Batal</button>
        <button class="btn btn-primary" id="editSave" style="flex:1;padding:10px;background:var(--primary);color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer">Simpan</button>
      </div>
    `;

    body.querySelector('#editCancel').addEventListener('click', close);
    body.querySelector('#editSave').addEventListener('click', async () => {
      const title = body.querySelector('#editTitle').value.trim();
      const bodyText = body.querySelector('#editBody').value;
      const tagsText = body.querySelector('#editTags').value.trim();
      const tags = tagsText ? tagsText.split(',').map(t => t.trim()).filter(Boolean) : [];
      close();
      try {
        // Update lokal instan
        item.title = title || 'Untitled';
        item.body = bodyText;
        item.tags = tags;
        await dbPutVaultItem(item);
        // Update cloud
        await updateVaultItem(window.__rfUser, itemId, { title: item.title, body: item.body, tags: item.tags });
        showToast('✓ Tersimpan');
        renderList();
      } catch (e) {
        showToast('Gagal simpan: ' + e.message);
      }
    });
  })();
}

// v1.10.3: Edit annotation note untuk screenshot/document
function openEditAnnotationSheet(itemId) {
  const sheet = document.createElement('div');
  sheet.className = 'bottom-sheet';
  sheet.innerHTML = `
    <div class="sheet-backdrop"></div>
    <div class="sheet-content">
      <div class="sheet-handle"></div>
      <div id="annotBody">Memuat...</div>
    </div>
  `;
  document.body.appendChild(sheet);
  requestAnimationFrame(() => sheet.classList.add('open'));
  const close = () => {
    sheet.classList.remove('open');
    setTimeout(() => sheet.remove(), 250);
  };
  sheet.querySelector('.sheet-backdrop').addEventListener('click', close);

  (async () => {
    const items = await dbGetAllVaultItems();
    const item = items.find(i => i.id === itemId);
    if (!item) { close(); return; }
    const existingNote = item.source?.annotationNote || item.annotation_note || '';

    const body = sheet.querySelector('#annotBody');
    body.innerHTML = `
      <h3 style="margin-bottom:12px;font-size:15px">📝 Edit Catatan Anotasi</h3>
      <textarea id="annotText" rows="5" placeholder="Catatan tentang screenshot/dokumen ini..."
        style="width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:8px;font-size:13px;box-sizing:border-box;margin-bottom:14px;resize:vertical">${escapeHtml(existingNote)}</textarea>
      <div style="display:flex;gap:8px">
        <button class="btn btn-ghost" id="annotCancel" style="flex:1;padding:10px;border:1px solid var(--border);border-radius:8px;font-size:13px;font-weight:600;cursor:pointer">Batal</button>
        <button class="btn btn-primary" id="annotSave" style="flex:1;padding:10px;background:var(--primary);color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer">Simpan</button>
      </div>
    `;

    body.querySelector('#annotCancel').addEventListener('click', close);
    body.querySelector('#annotSave').addEventListener('click', async () => {
      const note = body.querySelector('#annotText').value.trim();
      close();
      try {
        if (!item.source) item.source = {};
        item.source.annotationNote = note;
        await dbPutVaultItem(item);
        await updateVaultItem(window.__rfUser, itemId, { source: item.source });
        showToast('✓ Catatan disimpan');
        renderList();
      } catch (e) {
        showToast('Gagal: ' + e.message);
      }
    });
  })();
}

// v1.10.3: Buat folder baru — dipanggil dari FAB menu atau vault header
export async function handleCreateFolder() {
  const name = prompt('Nama folder baru:');
  if (!name || !name.trim()) return;
  // Type folder = filter type yang aktif (atau 'prompt' default)
  const folderType = (_filterType && _filterType !== 'all') ? _filterType : 'prompt';
  const folder = createGroup(name.trim(), folderType);
  try {
    // Save ke IndexedDB + cloud (pola sama dengan addon handleAddGroup)
    await dbPutVaultItem(folder);
    await updateVaultItem(window.__rfUser, folder.id, {
      title: folder.title,
      type: folder.type,
      tags: folder.tags,
      source: folder.source
    });
    // Auto-expand folder baru
    _expandedFolderIds.add(folder.id);
    showToast('✓ Folder "' + name.trim() + '" dibuat');
    renderList();
  } catch (e) {
    // Fallback: coba createNote (yang sudah ada di sync.js)
    console.error('[RecallFox] createFolder error:', e);
    showToast('Gagal buat folder: ' + e.message);
  }
}
