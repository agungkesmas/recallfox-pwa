// src/views/vault.js — Vault tab: render text-based items (prompt, context, snapshot, link, bundle)
// v1.7.0: Janji cross-device terpenuhi — semua tipe item tampil di PWA, bukan hanya screenshot/document/notes.
// v1.8.0: Folder tree support — folder yang dibuat di addon tampil di PWA (read-only + collapse).
//         Pakai buildTree dari lib/vault-tree.js (port dari addon).
//         Tampilan: indent saja, tanpa connector ├──/└── (mobile-friendly).
//         Tidak ada DnD — pakai menu "Pindahkan ke Folder" (TODO iterasi berikutnya).

import { dbGetAllVaultItems } from '../db.js';
import { deleteVaultItem, updateVaultItem } from '../sync.js';
import { buildTree, isGroupItem, getParentId } from '../lib/vault-tree.js';

let _batchMode = false;
let _batchSelected = new Set();
let _onRefresh = null;
let _searchQuery = '';
let _filterType = 'all';
let _sortBy = 'recent';
let _expandedFolderIds = new Set();  // v1.8.0: folder yang di-expand
let _currentFolderId = null;  // v1.8.0: null = root, atau folder id untuk breadcrumb navigation
let _lastRenderToken = null;  // v1.9.2: token untuk detect renderList race condition

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
    const groupItems = allItems.filter(i => isGroupItem(i) && !i.archived);
    items = [...items, ...groupItems];

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
function toggleFolder(folderId) {
  if (_expandedFolderIds.has(folderId)) {
    _expandedFolderIds.delete(folderId);
  } else {
    _expandedFolderIds.add(folderId);
  }
  renderList();
}

function renderItemCard(item, indent = 0) {
  const typeInfo = TYPE_LABELS[item.type] || { label: item.type, icon: '📄', color: '#6b7280' };
  const isFav = item.favorite ? '⭐' : '☆';
  const title = escapeHtml(item.title || 'Tanpa judul');
  const body = escapeHtml(truncateText(item.body || item.note || '', 150));
  const tags = (item.tags && item.tags.length) ? item.tags.map(t => `<span class="tag">#${escapeHtml(t)}</span>`).join('') : '';
  const isSelected = _batchSelected.has(item.id) ? 'selected' : '';
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
    <div class="vault-item ${isSelected}" data-id="${item.id}" style="margin-left:${indent}px">
      <div class="item-type-badge" style="background:${typeInfo.color}">${typeInfo.icon}</div>
      <div class="item-content">
        <div class="item-title">${title}</div>
        ${body ? `<div class="item-body">${body}</div>` : ''}
        ${linkInfo}
        ${snapshotInfo}
        ${bundleInfo}
        ${locationInfo}
        ${tags ? `<div class="item-tags">${tags}</div>` : ''}
      </div>
      <div class="item-actions">
        <button class="item-fav" data-id="${item.id}" title="Favorit">${isFav}</button>
        <button class="item-copy" data-id="${item.id}" title="Salin">📋</button>
        <button class="item-delete" data-id="${item.id}" title="Hapus">🗑️</button>
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
