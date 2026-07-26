// src/share-target.js — Handle incoming share dari Android Share Sheet
// v1.8.7: RecallFox PWA muncul di menu Share HP. User share link/teks dari app
// mana pun → langsung masuk vault sebagai prompt/context/link item.
//
// Flow:
//   1. User share dari app lain → Android buka https://recallfox-pwa.vercel.app/share-target?title=...&text=...&url=...
//   2. main.js init() cek URL → kalau ada /share-target, panggil handleShareTarget()
//   3. handleShareTarget() parse query params → tentukan tipe item (link/text) → simpan via sync.js
//   4. Redirect ke vault view + toast konfirmasi
//
// Tipe item yang dibuat berdasarkan share content:
//   - Kalau ada URL → type='link' (simpan linkUrl + title + text sebagai body)
//   - Kalau hanya text panjang → type='context' (simpan body=text, title dari first line)
//   - Kalau text pendek (< 100 chars) → type='prompt' (prompt teks untuk AI)
//
// Auth: kalau user belum login → redirect ke login dulu, setelah login baru proses share.

import { getSession } from './auth.js';
import { updateVaultItem } from './sync.js';
import { dbGetAllVaultItems } from './db.js';

// Lazy import createVaultItem-style — pakai supabase langsung karena sync.js
// tidak expose generic createItem (hanya createScreenshotItem/createDocumentItem/createNote).
// Untuk share target, kita buat item type='link'/'context'/'prompt' langsung via supabase.
async function createShareItem(user, payload) {
  const { supabase, VAULT_TABLE } = await import('./supabase.js');
  const itemId = 'sh_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  const now = new Date().toISOString();

  // Determine type based on content
  let type = 'prompt';
  let title = payload.title || '';
  let body = payload.text || '';
  let linkUrl = null;

  if (payload.url) {
    type = 'link';
    linkUrl = payload.url;
    title = title || payload.url;
    body = payload.text || payload.url;
  } else if (body && body.length > 100) {
    type = 'context';
    if (!title) {
      // Title = first line atau first 60 chars
      const firstLine = body.split('\n')[0];
      title = firstLine.length > 60 ? firstLine.slice(0, 60) + '...' : firstLine;
    }
  } else if (body) {
    type = 'prompt';
    if (!title) title = body.slice(0, 60);
  } else if (payload.title) {
    // Hanya title, no text/url → treat as prompt
    type = 'prompt';
    body = payload.title;
    title = payload.title.slice(0, 60);
  }

  const row = {
    id: itemId,
    user_id: user.id,
    type,
    title: title || 'Shared item',
    body: body || '',
    tags: ['shared'],
    category: null,
    source: {
      capturedAt: now,
      device: 'pwa-share',
      shareSource: 'android-share-sheet'
    },
    link_url: type === 'link' ? linkUrl : null,
    link_title: type === 'link' ? (title || linkUrl) : null,
    favorite: false,
    archived: false,
    use_count: 0,
    last_used_at: null,
    created_at: now,
    updated_at: now,
    deleted_at: null,
    device_id: 'pwa-share-' + (navigator.userAgent.slice(0, 20) || 'unknown')
  };

  console.log('[RecallFox/Share] Creating item:', itemId, 'type:', type, 'title:', title);

  try {
    const { error } = await supabase.from(VAULT_TABLE).upsert(row);
    if (error) {
      console.error('[RecallFox/Share] Supabase upsert error:', error.message);
      return { ok: false, error: error.message };
    }
    // Cache ke IndexedDB supaya langsung tampil di vault view
    try {
      const { dbPutVaultItem } = await import('./db.js');
      await dbPutVaultItem(row);
    } catch (e) {
      console.warn('[RecallFox/Share] IndexedDB cache failed (non-critical):', e.message);
    }
    return { ok: true, item: row };
  } catch (e) {
    console.error('[RecallFox/Share] Exception:', e.message);
    return { ok: false, error: e.message };
  }
}

/**
 * Handle share target URL.
 * Dipanggil dari main.js init() kalau URL path = '/share-target'.
 *
 * @param {URL} url — current URL (dengan query params)
 * @param {function} navigateTo — router function untuk pindah view
 * @returns {Promise<{handled: boolean}>}
 */
export async function handleShareTarget(url, navigateTo) {
  // v1.8.8: Log lebih detail untuk debugging
  console.log('[RecallFox/Share] handleShareTarget called. pathname:', url.pathname);
  if (!url.pathname.endsWith('/share-target') && !url.pathname.endsWith('/share-target/')) {
    console.log('[RecallFox/Share] Not a share-target URL, skip');
    return { handled: false };
  }

  const params = url.searchParams;
  const title = params.get('title') || '';
  const text = params.get('text') || '';
  const urlParam = params.get('url') || '';

  // v1.8.8: Brave browser kadang kirim URL di 'text' field, bukan 'url' field.
  // Cek kalau text berisi URL, extract sebagai url.
  let cleanUrl = urlParam ? urlParam.split('#')[0] : '';
  let cleanText = text;
  if (!cleanUrl && text) {
    // Cek apakah text adalah URL
    try {
      const testUrl = new URL(text.trim());
      if (testUrl.protocol === 'http:' || testUrl.protocol === 'https:') {
        cleanUrl = text.trim();
        cleanText = '';
        console.log('[RecallFox/Share] URL found in text field, extracted:', cleanUrl);
      }
    } catch (e) {
      // text bukan URL, biarkan
    }
  }

  console.log('[RecallFox/Share] Parsed:', { title, text: cleanText?.slice(0, 80), url: cleanUrl });

  if (!title && !cleanText && !cleanUrl) {
    console.warn('[RecallFox/Share] Empty share — no title/text/url');
    // v1.8.8: Jangan return error, tetap navigate ke vault supaya user tidak stuck
    if (navigateTo) navigateTo('vault');
    showShareToast('Share kosong — tidak ada data diterima');
    return { handled: true, error: 'empty_share' };
  }

  // Cek auth
  const session = await getSession();
  if (!session?.user) {
    sessionStorage.setItem('rf_pending_share', JSON.stringify({ title, text: cleanText, url: cleanUrl }));
    console.log('[RecallFox/Share] Not logged in — saved pending share, redirect to login');
    showShareToast('Silakan login dulu — share akan diproses otomatis');
    return { handled: true, pendingLogin: true };
  }

  // Sudah login → proses share
  const result = await createShareItem(session.user, { title, text: cleanText, url: cleanUrl });
  if (result.ok) {
    console.log('[RecallFox/Share] Item saved:', result.item.id, 'type:', result.item.type);
    if (navigateTo) navigateTo('vault');
    const typeLabel = result.item.type === 'link' ? '🔗 Link' : (result.item.type === 'context' ? '📋 Konteks' : '💬 Prompt');
    showShareToast('✓ Tersimpan ke ' + typeLabel + ': ' + (result.item.title || 'Shared item'));
    return { handled: true, item: result.item };
  } else {
    console.error('[RecallFox/Share] Save failed:', result.error);
    showShareToast('✗ Gagal simpan: ' + result.error, true);
    return { handled: true, error: result.error };
  }
}

/**
 * Process pending share setelah user login.
 * Dipanggil dari main.js showApp() kalau ada pending share di sessionStorage.
 */
export async function processPendingShare(navigateTo) {
  const pending = sessionStorage.getItem('rf_pending_share');
  if (!pending) return { handled: false };
  sessionStorage.removeItem('rf_pending_share');
  try {
    const data = JSON.parse(pending);
    const session = await getSession();
    if (!session?.user) return { handled: false };
    const result = await createShareItem(session.user, data);
    if (result.ok) {
      if (navigateTo) navigateTo('vault');
      showShareToast('✓ Tersimpan ke vault: ' + (result.item.title || 'Shared item'));
      return { handled: true, item: result.item };
    }
  } catch (e) {
    console.error('[RecallFox/Share] processPendingShare error:', e.message);
  }
  return { handled: false };
}

function showShareToast(msg, isError = false) {
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
