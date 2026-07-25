// src/views/vault.js — Vault tab: render text-based items (prompt, context, snapshot, link, bundle)
// v1.7.0: Janji cross-device terpenuhi — semua tipe item tampil di PWA, bukan hanya screenshot/document/notes.
//
// Item types yang ditampilkan:
//   - prompt: prompt teks untuk AI
//   - context: konteks/latar belakang
//   - snapshot: snapshot percakapan AI
//   - link: bookmark/link
//   - bundle: kumpulan item
//
// TIDAK ditampilkan di view ini (sudah ada di Media):
//   - screenshot, document → renderMedia()

import { dbGetAllVaultItems } from '../db.js';
import { deleteVaultItem, updateVaultItem } from '../sync.js';

let _batchMode = false;
let _batchSelected = new Set();
let _onRefresh = null;
let _searchQuery = '';
let _filterType = 'all';
let _sortBy = 'recent';

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

  try {
    const allItems = await dbGetAllVaultItems();
    let items = allItems.filter(i => TEXT_TYPES.includes(i.type) && !i.archived);

    // Filter by type
    if (_filterType !== 'all') {
      items = items.filter(i => i.type === _filterType);
    }

    // Search
    if (_searchQuery) {
      items = items.filter(i => {
        const title = (i.title || '').toLowerCase();
        const body = (i.body || '').toLowerCase();
        const note = (i.note || '').toLowerCase();
        return title.includes(_searchQuery) || body.includes(_searchQuery) || note.includes(_searchQuery);
      });
    }

    // Sort
    if (_sortBy === 'recent') {
      items.sort((a, b) => new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at));
    } else if (_sortBy === 'favorite') {
      items.sort((a, b) => (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0) || new Date(b.updated_at) - new Date(a.updated_at));
    } else if (_sortBy === 'title') {
      items.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
    }

    if (items.length === 0) {
      list.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">🗂️</div>
          <div class="empty-title">Belum ada item teks</div>
          <div class="empty-desc">Prompt, konteks, snapshot, link, dan bundle dari addon akan muncul di sini.</div>
        </div>`;
      return;
    }

    list.innerHTML = items.map(item => renderItemCard(item)).join('');

    // Wire event listeners
    list.querySelectorAll('.vault-item').forEach(card => {
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
  }
}

function renderItemCard(item) {
  const typeInfo = TYPE_LABELS[item.type] || { label: item.type, icon: '📄', color: '#6b7280' };
  const isFav = item.favorite ? '⭐' : '☆';
  const title = escapeHtml(item.title || 'Tanpa judul');
  const body = escapeHtml(truncateText(item.body || item.note || '', 150));
  const tags = (item.tags && item.tags.length) ? item.tags.map(t => `<span class="tag">#${escapeHtml(t)}</span>`).join('') : '';
  const isSelected = _batchSelected.has(item.id) ? 'selected' : '';

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
    <div class="vault-item ${isSelected}" data-id="${item.id}">
      <div class="item-type-badge" style="background:${typeInfo.color}">${typeInfo.icon}</div>
      <div class="item-content">
        <div class="item-title">${title}</div>
        ${body ? `<div class="item-body">${body}</div>` : ''}
        ${linkInfo}
        ${snapshotInfo}
        ${bundleInfo}
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
