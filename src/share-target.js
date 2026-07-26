// src/share-target.js — v1.9.2: ROBUST share target — no navigateTo after save
//
// FIX v1.9.2 (ROOT CAUSE "memuat terus"):
// 1. HAPUS window.__rfNavigate('vault') setelah save — itu trigger renderVault async
//    yang race dengan pullFromCloud di background → list stuck "Memuat..."
// 2. Setelah save, TETAP di view saat ini. Toast sukses 6 detik + tombol "Lihat" optional.
// 3. User kontrol navigasi sendiri → tidak ada surprise re-render.
//
// FIX v1.9.1 (sebelumnya):
// 1. withTimeout di upsert Supabase (anti hang/blank)
// 2. IndexedDB write DULU sebelum cloud (anti data loss)
// 3. Input judul + auto-fetch page title dari URL
// 4. Toast z-index 10000 (di atas modal 9999)
// 5. Modal tutup dulu, save di background, toast feedback
// 6. Cancel button kasih toast feedback

import { getSession } from './auth.js';
import { withTimeout, getDeviceId } from './sync.js';
import { dbPutVaultItem, dbEnqueueSync } from './db.js';

/**
 * v1.9.1: Create share item — IndexedDB DULU, cloud dengan timeout.
 * Pattern sama dengan createScreenshotItem (v1.5.1 fix).
 */
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
    device_id: getDeviceId()
  };

  console.log('[RecallFox/Share] Creating item:', itemId, 'type:', type, 'title:', title);

  // v1.9.1 Fix #2: IndexedDB DULU — data tidak pernah hilang walau cloud hang
  try {
    await dbPutVaultItem(row);
    console.log('[RecallFox/Share] IndexedDB write OK:', itemId);
  } catch (e) {
    console.error('[RecallFox/Share] IndexedDB write FAILED:', e.message);
    return { ok: false, error: 'IndexedDB: ' + e.message };
  }

  // v1.9.1 Fix #1: Cloud upsert dengan withTimeout (anti hang)
  let cloudOk = false;
  let cloudError = null;
  try {
    const { error } = await withTimeout(
      supabase.from(VAULT_TABLE).upsert(row),
      20000,
      'share_vault_upsert'
    );
    if (error) {
      cloudError = error.message;
      console.error('[RecallFox/Share] Supabase error:', cloudError);
      await dbEnqueueSync({ op: 'upsert_vault', user_id: user.id, row });
    } else {
      cloudOk = true;
      console.log('[RecallFox/Share] Cloud upsert OK:', itemId);
    }
  } catch (e) {
    cloudError = e.message;
    console.error('[RecallFox/Share] Cloud upsert exception:', cloudError);
    await dbEnqueueSync({ op: 'upsert_vault', user_id: user.id, row });
  }

  return {
    ok: true,  // data SUDAH di IndexedDB
    item: row,
    synced: cloudOk,
    localOnly: !cloudOk,
    error: cloudError
  };
}

/**
 * v1.9.1: Preview modal dengan input judul + auto-fetch page title.
 */
export async function showSharePreviewModal(data, user) {
  console.log('[RecallFox/Share] Showing preview modal:', data);

  let url = data.url || '';
  let text = data.text || '';
  let title = data.title || '';

  // Extract URL dari text (Brave browser)
  if (!url && text) {
    try {
      const testUrl = new URL(text.trim());
      if (testUrl.protocol === 'http:' || testUrl.protocol === 'https:') {
        url = text.trim();
        text = '';
      }
    } catch (e) {}
  }

  // Tentukan tipe
  let typeLabel = '💬 Prompt';
  let typeIcon = '💬';
  if (url) { typeLabel = '🔗 Link'; typeIcon = '🔗'; }
  else if (text && text.length > 100) { typeLabel = '📋 Konteks'; typeIcon = '📋'; }

  // Default title dari hostname
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
    let hostname = '';
    try { hostname = new URL(url).hostname; } catch (e) { hostname = url; }
    previewHtml = `
      <div style="background:#f5f5f4;border-radius:8px;padding:12px;margin-bottom:10px">
        <div style="font-size:11px;color:#a8a29e;margin-bottom:4px">${typeIcon} ${typeLabel}</div>
        <div style="font-size:12px;color:#6366f1;word-break:break-all">${escapeHtml(url)}</div>
        ${text ? `<div style="font-size:12px;color:#57534e;margin-top:8px">${escapeHtml(text)}</div>` : ''}
      </div>`;
  } else if (text) {
    previewHtml = `
      <div style="background:#f5f5f4;border-radius:8px;padding:12px;margin-bottom:10px">
        <div style="font-size:11px;color:#a8a29e;margin-bottom:4px">${typeIcon} ${typeLabel}</div>
        <div style="font-size:12px;color:#57534e;white-space:pre-wrap;max-height:120px;overflow-y:auto">${escapeHtml(text)}</div>
      </div>`;
  }

  // v1.9.1 Fix #3: Tambah input judul + tombol auto-fetch
  modal.innerHTML = `
    <div style="background:#fff;border-radius:16px;max-width:380px;width:100%;padding:20px;box-shadow:0 20px 60px rgba(0,0,0,.3)">
      <div style="font-size:16px;font-weight:700;margin-bottom:12px;color:#1c1917">📥 Bagikan ke RecallFox</div>

      <label style="display:block;font-size:12px;color:#57534e;margin:0 0 4px;font-weight:600">Judul</label>
      <input id="shareTitleInput" type="text" value="${escapeHtml(title)}" placeholder="Ketik judul..."
        style="width:100%;padding:10px 12px;border:1px solid #e7e5e4;border-radius:8px;font-size:14px;box-sizing:border-box;margin-bottom:6px">
      <button id="shareAutoTitle" type="button"
        style="background:none;border:none;color:#6d3df5;font-size:12px;padding:4px 0;cursor:pointer;display:block">
        ✨ Ambil judul otomatis dari URL
      </button>

      ${previewHtml}

      <div style="display:flex;gap:8px;margin-top:14px">
        <button id="shareCancel" style="flex:1;padding:10px;border:1px solid #e7e5e4;background:#fff;color:#57534e;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer">Batal</button>
        <button id="shareSave" style="flex:1;padding:10px;background:#6d3df5;color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer">Simpan ke Vault</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  const titleInput = modal.querySelector('#shareTitleInput');
  const autoBtn = modal.querySelector('#shareAutoTitle');
  const cancelBtn = modal.querySelector('#shareCancel');
  const saveBtn = modal.querySelector('#shareSave');

  // v1.9.1 Fix #3: Auto-fetch page title dari URL
  autoBtn.addEventListener('click', async () => {
    if (!url) return;
    autoBtn.textContent = '⏳ Mengambil...';
    autoBtn.disabled = true;
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(url, { signal: controller.signal, mode: 'cors' });
      clearTimeout(t);
      const html = await res.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const ogTitle = doc.querySelector('meta[property="og:title"]')?.content;
      const docTitle = doc.querySelector('title')?.textContent;
      const fetched = (ogTitle || docTitle || '').trim();
      if (fetched) {
        titleInput.value = fetched;
        autoBtn.textContent = '✓ Judul otomatis terpasang';
      } else {
        autoBtn.textContent = '⚠ Judul tidak ditemukan, ketik manual';
      }
    } catch (e) {
      autoBtn.textContent = '⚠ Gagal ambil (CORS?), ketik manual';
    } finally {
      autoBtn.disabled = false;
      setTimeout(() => { autoBtn.textContent = '✨ Ambil judul otomatis dari URL'; }, 3000);
    }
  });

  // v1.9.1 Fix #6: Cancel button kasih toast
  cancelBtn.addEventListener('click', () => {
    modal.remove();
    showToast('Dibatalkan', false);
    console.log('[RecallFox/Share] User cancelled share');
  });

  // v1.10.4 FIX: Tutup modal INSTAN saat user klik Simpan.
  // Sebelumnya: modal tetap tampil selama save (bisa 25 detik) → user tidak bisa
  // interaksi → terasa "hang/blank". Sekarang: modal tutup langsung, toast
  // "Menyimpan..." muncul, save di background, toast sukses/error setelah selesai.
  saveBtn.addEventListener('click', async () => {
    const finalTitle = (titleInput.value || '').trim() || title;

    // TUTUP MODAL INSTAN — user bisa langsung interaksi dengan app
    modal.remove();
    showToast('⏳ Menyimpan...', false);

    try {
      const result = await Promise.race([
        createShareItem(user, { title: finalTitle, text, url }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('Save timeout 25s')), 25000))
      ]);

      if (result.ok) {
        const typeLabel2 = result.item.type === 'link' ? '🔗 Link' : (result.item.type === 'context' ? '📋 Konteks' : '💬 Prompt');
        if (result.synced) {
          showSuccessToast('✓ Tersimpan ke ' + typeLabel2, 'Lihat di Vault');
        } else {
          showSuccessToast('✓ Tersimpan lokal (sync nanti)', 'Lihat di Vault');
        }
        console.log('[RecallFox/Share] Saved:', result.item.id, 'synced:', result.synced);
      } else {
        showToast('✗ Gagal: ' + result.error, true);
      }
    } catch (e) {
      console.error('[RecallFox/Share] Save exception:', e.message);
      showToast('✗ Error: ' + e.message, true);
    }
  });

  // Click backdrop to cancel
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      modal.remove();
      showToast('Dibatalkan', false);
    }
  });
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// v1.9.1 Fix #4: Toast z-index 10000 (di atas modal 9999) + timer cleanup
function showToast(msg, isError = false) {
  let t = document.getElementById('rfToast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'rfToast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);padding:10px 20px;border-radius:8px;font-size:13px;font-weight:600;color:#fff;z-index:10000;transition:opacity .3s;max-width:90%;text-align:center;box-shadow:0 4px 20px rgba(0,0,0,.3)';
  t.style.background = isError ? '#ef4444' : '#10b981';
  if (t._rfTimer) clearTimeout(t._rfTimer);
  t.style.opacity = '1';
  t.onclick = null;
  t._rfTimer = setTimeout(() => { t.style.opacity = '0'; }, 4000);
}

// v1.9.2: Toast sukses dengan tombol "Lihat di Vault" — user klik untuk navigasi.
// TIDAK auto-navigate. User kontrol sendiri.
function showSuccessToast(msg, actionLabel) {
  let t = document.getElementById('rfToast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'rfToast';
    document.body.appendChild(t);
  }
  // Struktur: [msg] [actionLabel]
  t.innerHTML = '';
  const span = document.createElement('span');
  span.textContent = msg;
  span.style.cssText = 'margin-right:10px';
  t.appendChild(span);

  if (actionLabel && window.__rfNavigate) {
    const btn = document.createElement('button');
    btn.textContent = actionLabel;
    btn.style.cssText = 'background:rgba(255,255,255,.25);border:none;color:#fff;padding:4px 10px;border-radius:6px;font-size:12px;font-weight:700;cursor:pointer';
    btn.onclick = (e) => {
      e.stopPropagation();
      t.style.opacity = '0';
      if (t._rfTimer) clearTimeout(t._rfTimer);
      // v1.9.2: Safe navigate — cek apakah __rfNavigate masih valid
      try { window.__rfNavigate('vault'); } catch (err) { console.warn('[RecallFox] navigate failed:', err.message); }
    };
    t.appendChild(btn);
  }

  t.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);padding:10px 16px;border-radius:8px;font-size:13px;font-weight:600;color:#fff;z-index:10000;transition:opacity .3s;max-width:90%;text-align:center;box-shadow:0 4px 20px rgba(0,0,0,.3);display:flex;align-items:center;background:#10b981';
  if (t._rfTimer) clearTimeout(t._rfTimer);
  t.style.opacity = '1';
  // 6 detik (lebih lama dari toast biasa 4s) supaya user sempat baca + klik
  t._rfTimer = setTimeout(() => { t.style.opacity = '0'; }, 6000);
}

// Legacy exports
export async function handleShareTarget(url, navigateTo) {
  console.warn('[RecallFox/Share] handleShareTarget deprecated — use showSharePreviewModal');
  return { handled: false };
}
export async function processPendingShare(navigateTo) {
  console.warn('[RecallFox/Share] processPendingShare deprecated — use showSharePreviewModal');
  return { handled: false };
}
