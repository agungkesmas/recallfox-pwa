// src/share-target.js — v1.9.0: Preview modal untuk share target
// User share link → PWA terbuka → app render normal → preview modal muncul
// User lihat preview → klik "Simpan" → item disimpan ke Supabase → navigate vault
// User klik "Batal" → tidak simpan, tetap di app normal
//
// FLOW:
// 1. Android Share Sheet → buka /share-target?title=...&text=...&url=...
// 2. main.js init() → simpan ke sessionStorage → clean URL → render app normal
// 3. Setelah showApp() selesai → showSharePreviewModal(data, user)
// 4. Modal muncul dengan preview (URL/title/text)
// 5. User klik "Simpan ke Vault" → createShareItem → navigate vault → toast
// 6. User klik "Batal" → modal tutup → tetap di app

import { getSession } from './auth.js';

async function createShareItem(user, payload) {
  const { supabase, VAULT_TABLE } = await import('./supabase.js');
  const itemId = 'sh_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  const now = new Date().toISOString();

  let type = 'prompt';
  let title = payload.title || '';
  let body = payload.text || '';
  let linkUrl = null;

  // v1.8.8: Brave browser kadang kirim URL di text field
  let cleanUrl = payload.url || '';
  let cleanText = body;
  if (!cleanUrl && body) {
    try {
      const testUrl = new URL(body.trim());
      if (testUrl.protocol === 'http:' || testUrl.protocol === 'https:') {
        cleanUrl = body.trim();
        cleanText = '';
      }
    } catch (e) {}
  }

  if (cleanUrl) {
    type = 'link';
    linkUrl = cleanUrl;
    title = title || cleanUrl;
    body = cleanText || cleanUrl;
  } else if (cleanText && cleanText.length > 100) {
    type = 'context';
    if (!title) {
      const firstLine = cleanText.split('\n')[0];
      title = firstLine.length > 60 ? firstLine.slice(0, 60) + '...' : firstLine;
    }
  } else if (cleanText) {
    type = 'prompt';
    if (!title) title = cleanText.slice(0, 60);
  } else if (title) {
    type = 'prompt';
    body = title;
    title = title.slice(0, 60);
  }

  const row = {
    id: itemId,
    user_id: user.id,
    type,
    title: title || 'Shared item',
    body: body || '',
    tags: ['shared'],
    category: null,
    source: { capturedAt: now, device: 'pwa-share', shareSource: 'android-share-sheet' },
    link_url: type === 'link' ? linkUrl : null,
    link_title: type === 'link' ? (title || linkUrl) : null,
    favorite: false,
    archived: false,
    use_count: 0,
    last_used_at: null,
    created_at: now,
    updated_at: now,
    deleted_at: null,
    device_id: 'pwa-share'
  };

  console.log('[RecallFox/Share] Creating item:', itemId, 'type:', type, 'title:', title);

  try {
    const { error } = await supabase.from(VAULT_TABLE).upsert(row);
    if (error) {
      console.error('[RecallFox/Share] Supabase error:', error.message);
      return { ok: false, error: error.message };
    }
    try {
      const { dbPutVaultItem } = await import('./db.js');
      await dbPutVaultItem(row);
    } catch (e) {}
    return { ok: true, item: row };
  } catch (e) {
    console.error('[RecallFox/Share] Exception:', e.message);
    return { ok: false, error: e.message };
  }
}

/**
 * v1.9.0: Tampilkan preview modal untuk share data.
 * User lihat preview → klik Simpan → item dibuat → navigate vault.
 * User klik Batal → modal tutup.
 */
export async function showSharePreviewModal(data, user) {
  console.log('[RecallFox/Share] Showing preview modal:', data);

  // Extract URL dari text kalau tidak ada url field (Brave browser)
  let url = data.url || '';
  let text = data.text || '';
  let title = data.title || '';

  if (!url && text) {
    try {
      const testUrl = new URL(text.trim());
      if (testUrl.protocol === 'http:' || testUrl.protocol === 'https:') {
        url = text.trim();
        text = '';
      }
    } catch (e) {}
  }

  // Tentukan tipe untuk label
  let typeLabel = '💬 Prompt';
  let typeIcon = '💬';
  if (url) { typeLabel = '🔗 Link'; typeIcon = '🔗'; }
  else if (text && text.length > 100) { typeLabel = '📋 Konteks'; typeIcon = '📋'; }

  // Default title dari URL kalau kosong
  if (!title && url) {
    try { title = new URL(url).hostname; } catch (e) { title = url; }
  }
  if (!title && text) title = text.slice(0, 60);

  // Buat modal
  const modal = document.createElement('div');
  modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.6);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;animation:fadeIn .2s';

  // Preview content
  let previewHtml = '';
  if (url) {
    // URL preview — tampilkan sebagai link card
    let hostname = '';
    try { hostname = new URL(url).hostname; } catch (e) { hostname = url; }
    previewHtml = `
      <div style="background:#f5f5f4;border-radius:8px;padding:12px;margin-bottom:10px">
        <div style="font-size:11px;color:#a8a29e;margin-bottom:4px">${typeIcon} ${typeLabel}</div>
        <div style="font-size:14px;font-weight:600;color:#1c1917;margin-bottom:4px">${escapeHtml(title || hostname)}</div>
        <div style="font-size:12px;color:#6366f1;word-break:break-all">${escapeHtml(url)}</div>
        ${text ? `<div style="font-size:12px;color:#57534e;margin-top:8px">${escapeHtml(text)}</div>` : ''}
      </div>`;
  } else if (text) {
    // Text preview
    previewHtml = `
      <div style="background:#f5f5f4;border-radius:8px;padding:12px;margin-bottom:10px">
        <div style="font-size:11px;color:#a8a29e;margin-bottom:4px">${typeIcon} ${typeLabel}</div>
        <div style="font-size:14px;font-weight:600;color:#1c1917;margin-bottom:4px">${escapeHtml(title || 'Teks')}</div>
        <div style="font-size:12px;color:#57534e;white-space:pre-wrap;max-height:150px;overflow-y:auto">${escapeHtml(text)}</div>
      </div>`;
  } else if (title) {
    previewHtml = `
      <div style="background:#f5f5f4;border-radius:8px;padding:12px;margin-bottom:10px">
        <div style="font-size:11px;color:#a8a29e;margin-bottom:4px">${typeIcon} ${typeLabel}</div>
        <div style="font-size:14px;font-weight:600;color:#1c1917">${escapeHtml(title)}</div>
      </div>`;
  }

  modal.innerHTML = `
    <div style="background:#fff;border-radius:16px;max-width:380px;width:100%;padding:20px;box-shadow:0 20px 60px rgba(0,0,0,.3)">
      <div style="font-size:16px;font-weight:700;margin-bottom:12px;color:#1c1917">📥 Bagikan ke RecallFox</div>
      ${previewHtml}
      <div style="display:flex;gap:8px;margin-top:14px">
        <button id="shareCancel" style="flex:1;padding:10px;border:1px solid #e7e5e4;background:#fff;color:#57534e;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer">Batal</button>
        <button id="shareSave" style="flex:1;padding:10px;background:#6d3df5;color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer">Simpan ke Vault</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  // Wire buttons
  const cancelBtn = modal.querySelector('#shareCancel');
  const saveBtn = modal.querySelector('#shareSave');

  cancelBtn.addEventListener('click', () => {
    modal.remove();
    console.log('[RecallFox/Share] User cancelled share');
  });

  saveBtn.addEventListener('click', async () => {
    saveBtn.textContent = 'Menyimpan...';
    saveBtn.disabled = true;
    try {
      const result = await createShareItem(user, { title, text, url });
      if (result.ok) {
        modal.remove();
        const typeLabel2 = result.item.type === 'link' ? '🔗 Link' : (result.item.type === 'context' ? '📋 Konteks' : '💬 Prompt');
        showToast('✓ Tersimpan ke ' + typeLabel2 + ': ' + (result.item.title || 'Shared item'));
        // Navigate ke vault
        if (window.__rfNavigate) window.__rfNavigate('vault');
        console.log('[RecallFox/Share] Saved and navigated to vault');
      } else {
        showToast('✗ Gagal: ' + result.error, true);
        saveBtn.textContent = 'Coba Lagi';
        saveBtn.disabled = false;
      }
    } catch (e) {
      showToast('✗ Error: ' + e.message, true);
      saveBtn.textContent = 'Coba Lagi';
      saveBtn.disabled = false;
    }
  });

  // Click backdrop to cancel
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      modal.remove();
    }
  });
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function showToast(msg, isError = false) {
  let t = document.getElementById('rfToast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'rfToast';
    t.className = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.background = isError ? '#ef4444' : '#10b981';
  t.style.color = '#fff';
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3000);
}

// Legacy: handleShareTarget dan processPendingShare — tidak dipakai di v1.9.0
// main.js sekarang pakai showSharePreviewModal langsung.
// Tetap export supaya tidak break import lama.
export async function handleShareTarget(url, navigateTo) {
  console.warn('[RecallFox/Share] handleShareTarget deprecated — use showSharePreviewModal');
  return { handled: false };
}
export async function processPendingShare(navigateTo) {
  console.warn('[RecallFox/Share] processPendingShare deprecated — use showSharePreviewModal');
  return { handled: false };
}
