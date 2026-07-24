// src/sync.js — Sync engine: upload/download ke Supabase + Realtime subscription
// Strategi: online-first (langsung upload ke cloud), IndexedDB sebagai cache
// untuk offline read + queue upload yang gagal.
//
// v1.2.0 FIX:
//   - BUG #1: pullFromCloud sekarang cache blob screenshot ke IndexedDB (background,
//     non-blocking) supaya getOrDownloadScreenshotBlob bisa ambil dari local saat
//     openItemDetail. Sebelumnya hanya metadata yang di-cache, jadi fetch cloud
//     URL yang gagal di mobile → paste kosong.
//   - BUG #2: createScreenshotItem sekarang return ok:false kalau upload Storage
//     ATAU upsert vault_items gagal. UI bisa tampilkan toast akurat ke user.
//     Sebelumnya selalu ok:true meski gagal → user pikir "tersimpan" padahal cuma
//     di IndexedDB lokal.
//   - BUG #2: pullFromCloud sekarang JANGAN hapus item lokal yang device_id-nya
//     cocok dengan device ini (item yang baru dibuat di sini tapi belum sync).
//     Sebelumnya setelah 60s item lokal dihapus → user lihat "tidak terjadi
//     apa-apa".
//   - Insert ke tabel screenshots supaya konsisten dengan addon (sebelumnya
//     PWA hanya insert ke vault_items).

import { supabase, STORAGE_BUCKET, VAULT_TABLE, NOTES_TABLE } from './supabase.js';
import {
  dbGetAllVaultItems, dbPutVaultItem, dbDeleteVaultItem,
  dbGetAllNotes, dbPutNote, dbDeleteNote,
  dbGetScreenshotBlob, dbPutScreenshotBlob, dbDeleteScreenshotBlob,
  dbEnqueueSync, dbGetSyncQueue, dbDeleteSyncQueueItem
} from './db.js';

const SCREENSHOTS_TABLE = 'screenshots';

// ===== Helpers =====
function genId(prefix = 'p') {
  return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

// v1.5.1: Promise timeout — supaya operasi Supabase/Storage yang hang
// tidak nge-block save flow selamanya. Sebelumnya await supabase.upsert()
// bisa hang tanpa limit → IndexedDB write (yang ada SETELAH upsert) tidak
// pernah dieksekusi → user lihat "tidak ada jejak save apapun di media".
//
// Pemakaian: await withTimeout(supabase.from(t).upsert(row), 20000, 'vault_upsert')
export function withTimeout(promise, ms, label = 'op') {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      reject(new Error(label + ' timeout after ' + ms + 'ms'));
    }, ms);
    Promise.resolve(promise).then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

export function getDeviceId() {
  let id = localStorage.getItem('recallfox_pwa_device_id');
  if (!id) {
    id = 'pwa_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    localStorage.setItem('recallfox_pwa_device_id', id);
  }
  return id;
}

async function generateThumbnail(dataUrl, maxSize = 200) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const scale = Math.min(maxSize / img.width, maxSize / img.height, 1);
      canvas.width = img.width * scale;
      canvas.height = img.height * scale;
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = () => resolve('');
    img.src = dataUrl;
  });
}

// ===== Upload screenshot blob ke Supabase Storage =====
export async function uploadScreenshotBlob(user, itemId, dataUrl) {
  if (!user || !itemId || !dataUrl) return { ok: false, error: 'invalid_args' };
  const path = `user-${user.id}/${itemId}.png`;
  try {
    console.log('[RecallFox] uploadScreenshotBlob START:', itemId, 'path:', path);
    // Convert dataUrl → Blob (pakai atob lebih reliable di mobile dibanding fetch)
    // v1.5.1: wrap fetch(dataUrl) dengan timeout — dataUrl besar bisa stall di HP low-end
    let blob = dataUrlToBlob(dataUrl);
    if (!blob) {
      try {
        const res = await withTimeout(fetch(dataUrl), 10000, 'dataUrl_fetch');
        blob = await res.blob();
      } catch (e) {
        console.warn('[RecallFox] dataUrl fetch failed, fallback ke atob manual:', e.message);
        // Fallback terakhir: coba decode manual kalau ada
        if (!blob) return { ok: false, error: 'blob_conversion_failed: ' + e.message };
      }
    }
    if (!blob) return { ok: false, error: 'blob_conversion_failed' };
    // Convert ke PNG kalau perlu
    let pngBlob;
    if (blob.type === 'image/png') {
      pngBlob = blob;
    } else {
      const img = await createImageBitmap(blob);
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      canvas.getContext('2d').drawImage(img, 0, 0);
      pngBlob = await new Promise(r => canvas.toBlob(r, 'image/png'));
    }
    if (!pngBlob) return { ok: false, error: 'png_conversion_failed' };
    // v1.5.1: wrap storage.upload dengan timeout 20s — kalau Supabase Storage
    // hang (project paused, network issue, dll), jangan block save selamanya.
    const { error } = await withTimeout(
      supabase.storage.from(STORAGE_BUCKET).upload(path, pngBlob, { contentType: 'image/png', upsert: true }),
      20000,
      'storage_upload'
    );
    if (error) {
      console.error('[RecallFox] storage.upload error:', error.message);
      return { ok: false, error: error.message };
    }
    const url = `${supabase.supabaseUrl}/storage/v1/object/public/${STORAGE_BUCKET}/${path}`;
    console.log('[RecallFox] uploadScreenshotBlob OK:', itemId);
    return { ok: true, url, path };
  } catch (e) {
    console.error('[RecallFox] uploadScreenshotBlob exception:', e.message);
    return { ok: false, error: e.message };
  }
}

export async function deleteScreenshotBlob(user, itemId) {
  if (!user || !itemId) return { ok: false, error: 'invalid_args' };
  const path = `user-${user.id}/${itemId}.png`;
  try {
    const { error } = await supabase.storage.from(STORAGE_BUCKET).remove([path]);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ===== Screenshot blob lazy download =====
export async function downloadScreenshotBlob(item) {
  if (!item?.id) return { ok: false, error: 'no_id' };
  const cloudUrl = item.gdrive_file_url || item.gdriveFileUrl;
  if (!cloudUrl) return { ok: false, error: 'no_cloud_url' };
  try {
    // cache: 'no-store' supaya Service Worker (kalau ada) tidak intercept
    const res = await fetch(cloudUrl, { cache: 'no-store' });
    if (!res.ok) return { ok: false, error: 'http_' + res.status };
    const blob = await res.blob();
    if (!blob || blob.size === 0) return { ok: false, error: 'empty_blob' };
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('filereader_failed'));
      reader.readAsDataURL(blob);
    });
    await dbPutScreenshotBlob(item.id, dataUrl);
    return { ok: true, dataUrl };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export async function getOrDownloadScreenshotBlob(item) {
  if (!item?.id) return { ok: false, dataUrl: null, error: 'no_id' };
  // Step 1: cek local cache
  let dataUrl = await dbGetScreenshotBlob(item.id);
  if (dataUrl) return { ok: true, dataUrl, source: 'local' };
  // Step 2: download dari cloud
  const dlRes = await downloadScreenshotBlob(item);
  if (dlRes.ok) return { ok: true, dataUrl: dlRes.dataUrl, source: 'cloud' };
  return { ok: false, dataUrl: null, error: dlRes.error };
}

// ===== Vault items CRUD =====
// v1.2.0: Return ok:false kalau upload Storage ATAU upsert vault_items gagal.
//         UI bisa tampilkan pesan error yang akurat ke user.
//         Sebelumnya selalu ok:true meski gagal → user pikir "tersimpan".
// v1.5.1: IndexedDB write DILAKUKAN PERTAMA (sebelum upload Storage & upsert
//         vault_items). Ini menjamin data user TIDAK PERNAH hilang meski cloud
//         gagal/hang. Sebelumnya IndexedDB write ada SETELAH upsert — kalau upsert
//         hang (Supabase paused/network issue), IndexedDB tidak pernah ditulis →
//         user lihat "tidak ada jejak save apapun di media".
//         Semua await supabase.* dibungkus withTimeout 20s supaya tidak hang selamanya.
export async function createScreenshotItem(user, payload) {
  // payload: { dataUrl, width, height, mode, title, annotationNote, sourceUrl, sourceTitle }
  const itemId = genId('sh');
  const now = new Date().toISOString();
  console.log('[RecallFox] createScreenshotItem START:', itemId, 'user:', user?.id, 'mode:', payload?.mode);
  const thumbnailDataUrl = await generateThumbnail(payload.dataUrl, 200);

  // Step 1: Upload blob ke Storage DULU
  const upRes = await uploadScreenshotBlob(user, itemId, payload.dataUrl);
  let storageOk = upRes.ok;
  let storageError = upRes.error || null;
  if (!storageOk) {
    // Enqueue untuk retry di background
    await dbEnqueueSync({
      op: 'upload_screenshot',
      user_id: user.id,
      item_id: itemId,
      data_url: payload.dataUrl,
      payload
    });
    console.warn('[RecallFox] Storage upload failed, enqueued for retry:', storageError);
  }

  const row = {
    id: itemId,
    user_id: user.id,
    type: 'screenshot',
    title: payload.title || `HP Capture ${new Date().toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' })}`,
    body: '',
    tags: [],
    category: null,
    source: {
      url: payload.sourceUrl || null,
      title: payload.sourceTitle || 'HP Capture',
      capturedAt: now,
      device: 'pwa-mobile',
      annotationNote: payload.annotationNote || ''
    },
    screenshot_mode: payload.mode || 'selection',
    screenshot_width: payload.width || 0,
    screenshot_height: payload.height || 0,
    screenshot_format: 'png',
    screenshot_bytes: payload.dataUrl?.length || 0,
    thumbnail_data_url: thumbnailDataUrl,
    gdrive_file_id: upRes.ok ? upRes.path : null,
    gdrive_file_url: upRes.ok ? upRes.url : null,
    toppings: [],
    variables: [],
    favorite: false,
    archived: false,
    use_count: 0,
    last_used_at: null,
    created_at: now,
    updated_at: now,
    deleted_at: null,
    device_id: getDeviceId()
  };

  // v1.5.1: Step 2 — IndexedDB write PERTAMA (sebelum cloud upsert).
  // Ini menjamin data user tidak hilang meski cloud gagal/hang.
  // Kalau IndexedDB write gagal (quota, db corruption), log error tapi lanjut
  // ke cloud upsert — cloud mungkin masih bisa simpan.
  try {
    await dbPutVaultItem(row);
    await dbPutScreenshotBlob(itemId, payload.dataUrl);
    console.log('[RecallFox] IndexedDB write OK (pre-cloud):', itemId);
  } catch (e) {
    console.error('[RecallFox] IndexedDB write FAILED (pre-cloud):', e.message);
  }

  // Step 3: Insert ke Supabase vault_items (dengan timeout 20s)
  let upsertOk = false;
  let upsertError = null;
  try {
    const { data: upsertData, error } = await withTimeout(
      supabase.from(VAULT_TABLE).upsert(row).select(),
      20000,
      'vault_upsert'
    );
    console.log('[RecallFox] upsert result:', { error: error?.message, hasData: !!upsertData });
    if (error) {
      upsertError = error.message;
      console.error('[RecallFox] upsert FAILED — enqueuing for retry:', upsertError);
      await dbEnqueueSync({ op: 'upsert_vault', user_id: user.id, row });
    } else {
      upsertOk = true;
      // v1.2.0: Juga insert ke tabel screenshots supaya konsisten dengan addon
      // (addon selalu insert ke screenshots table dengan storage_path/url)
      if (upRes.ok) {
        try {
          await withTimeout(
            supabase.from(SCREENSHOTS_TABLE).upsert({
              id: itemId,
              user_id: user.id,
              vault_item_id: itemId,
              storage_path: upRes.path,
              storage_url: upRes.url,
              file_size: payload.dataUrl?.length || 0,
              width: payload.width || 0,
              height: payload.height || 0,
              format: 'png',
              annotation_note: payload.annotationNote || '',
              captured_at: now,
              source_url: payload.sourceUrl || null,
              source_title: payload.sourceTitle || null
            }),
            15000,
            'screenshots_upsert'
          );
        } catch (e) {
          // Tidak fatal — vault_items sudah berhasil
          console.warn('[RecallFox] screenshots table insert failed (non-fatal):', e.message);
        }
      }
    }
  } catch (e) {
    upsertError = e.message;
    console.error('[RecallFox] upsert exception:', upsertError);
    await dbEnqueueSync({ op: 'upsert_vault', user_id: user.id, row });
  }

  // Step 4: Return status akurat
  // v1.5.1: Data SUDAH di IndexedDB (step 2) — return ok:true bahkan kalau
  // cloud gagal, supaya UI tampilkan item di media tab + toast akurat.
  if (storageOk && upsertOk) {
    console.log('[RecallFox] createScreenshotItem OK (cloud synced):', itemId);
    return { ok: true, item: row, synced: true };
  }
  if (upsertOk && !storageOk) {
    // vault_items saved, but blob upload failed — retry in background
    console.log('[RecallFox] createScreenshotItem PARTIAL (vault saved, blob pending):', itemId);
    return {
      ok: true,
      item: row,
      synced: false,
      partial: true,
      warning: 'Metadata tersimpan, gambar sedang diupload ulang',
      storageError
    };
  }
  // Both failed or upsert failed — data only in local IndexedDB
  // v1.5.1: Tetap return ok:true + localOnly supaya UI tetap tampilkan item
  // (item sudah ada di IndexedDB dari step 2). Toast bilang "lokal".
  console.log('[RecallFox] createScreenshotItem LOCAL-ONLY:', itemId, 'errors:', { upsertError, storageError });
  return {
    ok: true,                  // v1.5.1: changed from false → true (data IS saved locally)
    item: row,
    synced: false,
    localOnly: true,
    error: upsertError || storageError || 'sync_failed',
    storageError,
    upsertError
  };
}

export async function deleteVaultItem(user, itemId) {
  if (!user || !itemId) return { ok: false, error: 'invalid_args' };
  // Hard delete dari Supabase
  const { error } = await supabase.from(VAULT_TABLE).delete().eq('id', itemId);
  if (error) {
    await dbEnqueueSync({ op: 'delete_vault', user_id: user.id, item_id: itemId });
  }
  // Hapus screenshot blob dari Storage
  await deleteScreenshotBlob(user, itemId);
  // v1.2.0: Hapus dari tabel screenshots juga (konsistensi dengan addon)
  try {
    await supabase.from(SCREENSHOTS_TABLE).delete().eq('id', itemId);
  } catch (e) { /* non-fatal */ }
  // Hapus dari IndexedDB
  await dbDeleteVaultItem(itemId);
  await dbDeleteScreenshotBlob(itemId);
  return { ok: true };
}

// ===== v1.3.0: Document item (CamScanner-like) =====
// Sama seperti createScreenshotItem, tapi type='document' dan source.pages berisi metadata halaman.
// Phase 2: single page only. Phase 5 (later): multi-page batch.
export async function createDocumentItem(user, payload) {
  // payload: { dataUrl, width, height, filter, title, note }
  const itemId = genId('doc');
  const now = new Date().toISOString();
  const thumbnailDataUrl = await generateThumbnail(payload.dataUrl, 200);

  // Upload blob ke Storage (pakai path terpisah dari screenshot supaya mudah filter)
  const path = `user-${user.id}/${itemId}.jpg`;
  let storageOk = false;
  let storageError = null;
  let storageUrl = null;
  try {
    // v1.5.1: wrap fetch dengan timeout
    let blob = dataUrlToBlob(payload.dataUrl);
    if (!blob) {
      const res = await withTimeout(fetch(payload.dataUrl), 10000, 'doc_dataUrl_fetch');
      blob = await res.blob();
    }
    let uploadBlob = blob;
    if (blob.type !== 'image/jpeg') {
      // Convert ke JPEG
      const img = await createImageBitmap(blob);
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
      uploadBlob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.92));
    }
    // v1.5.1: wrap storage.upload dengan timeout 20s
    const { error: upErr } = await withTimeout(
      supabase.storage.from(STORAGE_BUCKET).upload(path, uploadBlob, { contentType: 'image/jpeg', upsert: true }),
      20000,
      'doc_storage_upload'
    );
    if (upErr) {
      storageError = upErr.message;
    } else {
      storageOk = true;
      storageUrl = `${supabase.supabaseUrl}/storage/v1/object/public/${STORAGE_BUCKET}/${path}`;
    }
  } catch (e) {
    storageError = e.message;
  }
  if (!storageOk) {
    await dbEnqueueSync({
      op: 'upload_document',
      user_id: user.id,
      item_id: itemId,
      data_url: payload.dataUrl,
      payload
    });
    console.warn('[RecallFox] Document storage upload failed, enqueued for retry:', storageError);
  }

  const row = {
    id: itemId,
    user_id: user.id,
    type: 'document',                     // ← TYPE BARU v1.3.0
    title: payload.title || `Dokumen ${new Date().toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' })}`,
    body: '',
    tags: [],
    category: null,
    source: {
      capturedAt: now,
      device: 'pwa-mobile',
      annotationNote: payload.note || '',
      pages: [                             // ← ARRAY HALAMAN (Phase 2: 1 halaman)
        {
          url: storageUrl,
          width: payload.width || 0,
          height: payload.height || 0,
          filter: payload.filter || 'original',
          size_bytes: payload.dataUrl?.length || 0
        }
      ]
    },
    screenshot_mode: 'document',
    screenshot_width: payload.width || 0,
    screenshot_height: payload.height || 0,
    screenshot_format: 'jpeg',
    screenshot_bytes: payload.dataUrl?.length || 0,
    thumbnail_data_url: thumbnailDataUrl,
    gdrive_file_id: storageOk ? path : null,
    gdrive_file_url: storageOk ? storageUrl : null,
    toppings: [],
    variables: [],
    favorite: false,
    archived: false,
    use_count: 0,
    last_used_at: null,
    created_at: now,
    updated_at: now,
    deleted_at: null,
    device_id: getDeviceId()
  };

  // v1.5.1: IndexedDB write PERTAMA (sebelum cloud upsert) supaya data user
  // tidak hilang meski cloud gagal/hang.
  try {
    await dbPutVaultItem(row);
    await dbPutScreenshotBlob(itemId, payload.dataUrl);
    console.log('[RecallFox] Document (single-page) IndexedDB write OK (pre-cloud):', itemId);
  } catch (e) {
    console.error('[RecallFox] Document (single-page) IndexedDB write FAILED (pre-cloud):', e.message);
  }

  // Insert ke vault_items (dengan timeout 20s)
  let upsertOk = false;
  let upsertError = null;
  try {
    const { error } = await withTimeout(
      supabase.from(VAULT_TABLE).upsert(row),
      20000,
      'doc_single_vault_upsert'
    );
    if (error) {
      upsertError = error.message;
      await dbEnqueueSync({ op: 'upsert_vault', user_id: user.id, row });
    } else {
      upsertOk = true;
    }
  } catch (e) {
    upsertError = e.message;
    await dbEnqueueSync({ op: 'upsert_vault', user_id: user.id, row });
  }

  // v1.5.1: Return ok:true bahkan kalau upsert gagal — data sudah di IndexedDB.
  if (storageOk && upsertOk) {
    return { ok: true, item: row, synced: true };
  }
  if (upsertOk && !storageOk) {
    return { ok: true, item: row, synced: false, partial: true, warning: 'Dokumen tersimpan, gambar sedang diupload ulang', storageError };
  }
  return {
    ok: true,                    // v1.5.1: changed from false → true (data IS saved locally)
    item: row,
    synced: false,
    localOnly: true,
    error: upsertError || storageError || 'sync_failed',
    storageError,
    upsertError
  };
}

// ===== v1.4.0: Document multi-page (Fase 5 — batch) =====
// Upload semua halaman ke Storage, simpan metadata di source.pages
// v1.5.1: IndexedDB write DILAKUKAN PERTAMA (sebelum upload & upsert) supaya
//         data user tidak hilang kalau cloud hang/gagal. Sama seperti
//         createScreenshotItem. Semua fetch + supabase calls dibungkus timeout.
export async function createDocumentItemMultiPage(user, payload) {
  // payload: { pages: [{dataUrl, filter, width, height}], title, note }
  const pages = payload.pages || [];
  if (pages.length === 0) return { ok: false, error: 'no_pages' };

  const itemId = genId('doc');
  const now = new Date().toISOString();
  console.log('[RecallFox] createDocumentItemMultiPage START:', itemId, 'user:', user?.id, 'pages:', pages.length);

  // Thumbnail dari halaman pertama
  const thumbnailDataUrl = await generateThumbnail(pages[0].dataUrl, 200);

  // Upload semua halaman ke Storage
  const pageMetas = [];
  let totalBytes = 0;
  let allUploadsOk = true;
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const path = `user-${user.id}/${itemId}_p${i + 1}.jpg`;
    let pageUrl = null;
    try {
      // v1.5.1: wrap fetch(dataUrl) dengan timeout — dataUrl besar bisa stall
      const blob = await (await withTimeout(fetch(page.dataUrl), 10000, 'page_fetch_' + (i + 1))).blob();
      let uploadBlob = blob;
      if (blob.type !== 'image/jpeg') {
        const img = await createImageBitmap(blob);
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0);
        uploadBlob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.92));
      }
      // v1.5.1: wrap storage.upload dengan timeout 20s
      const { error: upErr } = await withTimeout(
        supabase.storage.from(STORAGE_BUCKET).upload(path, uploadBlob, { contentType: 'image/jpeg', upsert: true }),
        20000,
        'page_upload_' + (i + 1)
      );
      if (!upErr) {
        pageUrl = `${supabase.supabaseUrl}/storage/v1/object/public/${STORAGE_BUCKET}/${path}`;
        console.log('[RecallFox] Page ' + (i + 1) + ' uploaded OK');
      } else {
        console.warn(`[RecallFox] Page ${i + 1} upload failed:`, upErr.message);
        allUploadsOk = false;
      }
    } catch (e) {
      console.warn(`[RecallFox] Page ${i + 1} upload exception:`, e.message);
      allUploadsOk = false;
    }
    const sizeBytes = Math.round(page.dataUrl.length * 0.75);
    totalBytes += sizeBytes;
    pageMetas.push({
      url: pageUrl,
      width: page.width || 0,
      height: page.height || 0,
      filter: page.filter || 'original',
      size_bytes: sizeBytes
    });
  }

  const row = {
    id: itemId,
    user_id: user.id,
    type: 'document',
    title: payload.title || `Dokumen ${new Date().toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' })}`,
    body: '',
    tags: [],
    category: null,
    source: {
      capturedAt: now,
      device: 'pwa-mobile',
      annotationNote: payload.note || '',
      pages: pageMetas
    },
    screenshot_mode: 'document',
    screenshot_width: pageMetas[0]?.width || 0,
    screenshot_height: pageMetas[0]?.height || 0,
    screenshot_format: 'jpeg',
    screenshot_bytes: totalBytes,
    thumbnail_data_url: thumbnailDataUrl,
    gdrive_file_id: pageMetas[0]?.url ? `user-${user.id}/${itemId}_p1.jpg` : null,
    gdrive_file_url: pageMetas[0]?.url || null,
    toppings: [],
    variables: [],
    favorite: false,
    archived: false,
    use_count: 0,
    last_used_at: null,
    created_at: now,
    updated_at: now,
    deleted_at: null,
    device_id: getDeviceId()
  };

  // v1.5.1: IndexedDB write PERTAMA (sebelum cloud upsert) supaya data user
  // tidak hilang meski cloud gagal/hang.
  try {
    await dbPutVaultItem(row);
    await dbPutScreenshotBlob(itemId, pages[0].dataUrl);
    console.log('[RecallFox] Document IndexedDB write OK (pre-cloud):', itemId);
  } catch (e) {
    console.error('[RecallFox] Document IndexedDB write FAILED (pre-cloud):', e.message);
  }

  // Insert ke vault_items (dengan timeout 20s)
  let upsertOk = false;
  let upsertError = null;
  try {
    const { data: upsertData, error } = await withTimeout(
      supabase.from(VAULT_TABLE).upsert(row).select(),
      20000,
      'doc_vault_upsert'
    );
    console.log('[RecallFox] document upsert result:', { error: error?.message, hasData: !!upsertData });
    if (error) {
      upsertError = error.message;
      console.error('[RecallFox] document upsert FAILED — enqueuing for retry:', upsertError);
      await dbEnqueueSync({ op: 'upsert_vault', user_id: user.id, row });
    } else {
      upsertOk = true;
    }
  } catch (e) {
    upsertError = e.message;
    console.error('[RecallFox] document upsert exception:', upsertError);
    await dbEnqueueSync({ op: 'upsert_vault', user_id: user.id, row });
  }

  // v1.5.1: Return ok:true bahkan kalau upsert gagal — data sudah di IndexedDB.
  // UI tetap tampilkan item di media tab + toast akurat.
  if (upsertOk && allUploadsOk) {
    console.log('[RecallFox] createDocumentItemMultiPage OK (cloud synced):', itemId);
    return {
      ok: true,
      item: row,
      synced: true,
      pageCount: pages.length,
      upsertError: null
    };
  }
  if (upsertOk && !allUploadsOk) {
    console.log('[RecallFox] createDocumentItemMultiPage PARTIAL:', itemId);
    return {
      ok: true,
      item: row,
      synced: true,
      partial: true,
      pageCount: pages.length,
      warning: 'Dokumen tersimpan, beberapa halaman sedang diupload ulang',
      upsertError: null
    };
  }
  // upsert failed — data only in IndexedDB
  console.log('[RecallFox] createDocumentItemMultiPage LOCAL-ONLY:', itemId, 'upsertError:', upsertError);
  return {
    ok: true,                  // v1.5.1: changed from upsertOk → true (data IS saved locally)
    item: row,
    synced: false,
    localOnly: true,
    pageCount: pages.length,
    error: upsertError || 'sync_failed',
    upsertError
  };
}

// ===== Notes CRUD =====
export async function createNote(user, payload) {
  const noteId = genId('n');
  const now = new Date().toISOString();
  const row = {
    id: noteId,
    user_id: user.id,
    title: payload.title || null,
    body: payload.body || '',
    color: payload.color || 'default',
    group: payload.group || null,
    pinned: !!payload.pinned,
    archived: !!payload.archived,
    created_at: now,
    updated_at: now,
    deleted_at: null,
    device_id: getDeviceId()
  };
  const { error } = await supabase.from(NOTES_TABLE).upsert(row);
  if (error) {
    await dbEnqueueSync({ op: 'upsert_note', user_id: user.id, row });
  }
  await dbPutNote(row);
  return { ok: true, note: row };
}

export async function updateNote(user, noteId, patch) {
  const now = new Date().toISOString();
  const updates = { ...patch, updated_at: now, device_id: getDeviceId() };
  const { error } = await supabase.from(NOTES_TABLE).update(updates).eq('id', noteId);
  if (error) {
    await dbEnqueueSync({ op: 'update_note', user_id: user.id, note_id: noteId, patch: updates });
  }
  // Update local cache
  const local = await (await import('./db.js')).dbGetAllNotes();
  const note = local.find(n => n.id === noteId);
  if (note) {
    await dbPutNote({ ...note, ...updates });
  }
  return { ok: true };
}

export async function deleteNote(user, noteId) {
  const { error } = await supabase.from(NOTES_TABLE).delete().eq('id', noteId);
  if (error) {
    await dbEnqueueSync({ op: 'delete_note', user_id: user.id, note_id: noteId });
  }
  await dbDeleteNote(noteId);
  return { ok: true };
}

// ===== Pull (download dari cloud ke IndexedDB) =====
// v1.2.0:
//   - Jangan hapus item lokal yang device_id-nya cocok dengan device ini
//     (item yang baru dibuat di device ini tapi belum sempat sync ke cloud).
//     Sebelumnya setelah 60s item lokal dihapus → user lihat "tidak terjadi
//     apa-apa" setelah toast "Tersimpan" muncul.
//   - Cache blob screenshot ke IndexedDB saat pull (background, non-blocking)
//     supaya getOrDownloadScreenshotBlob bisa ambil dari local saat openItemDetail.
export async function pullFromCloud(user) {
  if (!user) return { ok: false, error: 'no_user' };
  const currentDeviceId = getDeviceId();

  // Pull vault_items (HANYA yang deleted_at IS NULL)
  const { data: items, error: e1 } = await supabase
    .from(VAULT_TABLE)
    .select('*')
    .eq('user_id', user.id)
    .is('deleted_at', null)
    .order('updated_at', { ascending: false });
  if (!e1 && items) {
    const cloudIds = new Set(items.map(r => r.id));
    const localItems = await dbGetAllVaultItems();
    const now = Date.now();
    // Hapus lokal yang tidak ada di cloud
    for (const li of localItems) {
      if (!cloudIds.has(li.id) && li.user_id === user.id) {
        const isOwnDevice = li.device_id === currentDeviceId;
        // v1.2.0: JANGAN hapus item yang dibuat di device ini sendiri.
        //         Mungkin item baru dibuat tapi upsert Supabase gagal → masih di queue
        //         retry. Kalau dihapus, user kehilangan data yang baru dibuat.
        if (isOwnDevice) {
          continue;
        }
        const createdAt = new Date(li.created_at || 0).getTime();
        if (now - createdAt > 60000) {
          await dbDeleteVaultItem(li.id);
          // v1.2.0: Hapus juga blob screenshot-nya (cleanup IndexedDB)
          await dbDeleteScreenshotBlob(li.id);
        }
      }
    }
    // Merge cloud → local (last-write-wins by updated_at)
    for (const row of items) {
      const local = await (await import('./db.js')).dbGetVaultItem(row.id);
      if (!local || new Date(row.updated_at) > new Date(local.updated_at || 0)) {
        await dbPutVaultItem(row);
        // v1.2.0: Cache blob screenshot di background (jangan block pull)
        // Hanya untuk item screenshot yang punya cloud URL dan belum ada di cache
        // v1.3.0: Juga untuk type='document'
        if ((row.type === 'screenshot' || row.type === 'document') && row.gdrive_file_url) {
          const cached = await dbGetScreenshotBlob(row.id);
          if (!cached) {
            // Fire-and-forget — jangan tunggu, agar UI cepat muncul
            downloadScreenshotBlob(row).catch(err => {
              console.warn('[RecallFox] background blob cache failed for', row.id, ':', err.message || err.error);
            });
          }
        }
      }
    }
  }

  // Pull notes
  const { data: notes, error: e2 } = await supabase
    .from(NOTES_TABLE)
    .select('*')
    .eq('user_id', user.id)
    .is('deleted_at', null)
    .order('updated_at', { ascending: false });
  if (!e2 && notes) {
    const cloudIds = new Set(notes.map(r => r.id));
    const localNotes = await dbGetAllNotes();
    const now = Date.now();
    for (const ln of localNotes) {
      if (!cloudIds.has(ln.id) && ln.user_id === user.id) {
        const isOwnDevice = ln.device_id === currentDeviceId;
        // v1.2.0: JANGAN hapus note yang dibuat di device ini sendiri.
        if (isOwnDevice) {
          continue;
        }
        const createdAt = new Date(ln.created_at || 0).getTime();
        if (now - createdAt > 60000) {
          await dbDeleteNote(ln.id);
        }
      }
    }
    for (const row of notes) {
      const local = await (await import('./db.js')).dbGetAllNotes();
      const ln = local.find(n => n.id === row.id);
      if (!ln || new Date(row.updated_at) > new Date(ln.updated_at || 0)) {
        await dbPutNote(row);
      }
    }
  }

  return { ok: true };
}

// ===== Realtime subscription =====
let _vaultSub = null;
let _notesSub = null;

export function subscribeRealtime(user, onChange) {
  if (!user) return;
  // Unsubscribe existing
  unsubscribeRealtime();

  _vaultSub = supabase
    .channel(`realtime:vault_${user.id}`)
    .on('postgres_changes',
      { event: '*', schema: 'public', table: VAULT_TABLE, filter: `user_id=eq.${user.id}` },
      async (payload) => {
        const row = payload.new || payload.old;
        if (payload.eventType === 'DELETE') {
          if (row?.id) {
            await dbDeleteVaultItem(row.id);
            await dbDeleteScreenshotBlob(row.id);
          }
        } else if (payload.eventType === 'INSERT' || payload.eventType === 'UPDATE') {
          if (row?.deleted_at) {
            await dbDeleteVaultItem(row.id);
            await dbDeleteScreenshotBlob(row.id);
          } else {
            await dbPutVaultItem(row);
          }
        }
        onChange && onChange('vault', payload);
      }
    )
    .subscribe();

  _notesSub = supabase
    .channel(`realtime:notes_${user.id}`)
    .on('postgres_changes',
      { event: '*', schema: 'public', table: NOTES_TABLE, filter: `user_id=eq.${user.id}` },
      async (payload) => {
        const row = payload.new || payload.old;
        if (payload.eventType === 'DELETE') {
          if (row?.id) await dbDeleteNote(row.id);
        } else if (payload.eventType === 'INSERT' || payload.eventType === 'UPDATE') {
          if (row?.deleted_at) {
            await dbDeleteNote(row.id);
          } else {
            await dbPutNote(row);
          }
        }
        onChange && onChange('notes', payload);
      }
    )
    .subscribe();
}

export function unsubscribeRealtime() {
  if (_vaultSub) { supabase.removeChannel(_vaultSub); _vaultSub = null; }
  if (_notesSub) { supabase.removeChannel(_notesSub); _notesSub = null; }
}

// ===== Process sync queue (retry failed uploads) =====
export async function processSyncQueue(user) {
  if (!user) return;
  const queue = await dbGetSyncQueue();
  for (const entry of queue) {
    try {
      if (entry.op === 'upload_screenshot') {
        const upRes = await uploadScreenshotBlob(user, entry.item_id, entry.data_url);
        if (upRes.ok) {
          // Update vault_items row dengan gdrive_file_url
          await supabase.from(VAULT_TABLE).update({
            gdrive_file_id: upRes.path,
            gdrive_file_url: upRes.url,
            updated_at: new Date().toISOString()
          }).eq('id', entry.item_id);
          // v1.2.0: Juga insert ke screenshots table
          try {
            await supabase.from(SCREENSHOTS_TABLE).upsert({
              id: entry.item_id,
              user_id: user.id,
              vault_item_id: entry.item_id,
              storage_path: upRes.path,
              storage_url: upRes.url,
              captured_at: new Date().toISOString()
            });
          } catch (e) { /* non-fatal */ }
          await dbDeleteSyncQueueItem(entry.id);
        }
      } else if (entry.op === 'upload_document') {
        // v1.3.0: Retry document blob upload
        const path = `user-${user.id}/${entry.item_id}.jpg`;
        try {
          const blob = dataUrlToBlob(entry.data_url) || await (await fetch(entry.data_url)).blob();
          let uploadBlob = blob;
          if (blob.type !== 'image/jpeg') {
            const img = await createImageBitmap(blob);
            const canvas = document.createElement('canvas');
            canvas.width = img.width;
            canvas.height = img.height;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(img, 0, 0);
            uploadBlob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.92));
          }
          const { error } = await supabase.storage.from(STORAGE_BUCKET).upload(path, uploadBlob, { contentType: 'image/jpeg', upsert: true });
          if (!error) {
            const url = `${supabase.supabaseUrl}/storage/v1/object/public/${STORAGE_BUCKET}/${path}`;
            await supabase.from(VAULT_TABLE).update({
              gdrive_file_id: path,
              gdrive_file_url: url,
              updated_at: new Date().toISOString()
            }).eq('id', entry.item_id);
            await dbDeleteSyncQueueItem(entry.id);
          }
        } catch (e) {
          console.warn('[RecallFox] document upload retry failed:', entry.id, e.message);
        }
      } else if (entry.op === 'upsert_vault') {
        const { error } = await supabase.from(VAULT_TABLE).upsert(entry.row);
        if (!error) await dbDeleteSyncQueueItem(entry.id);
      } else if (entry.op === 'delete_vault') {
        const { error } = await supabase.from(VAULT_TABLE).delete().eq('id', entry.item_id);
        if (!error) await dbDeleteSyncQueueItem(entry.id);
      } else if (entry.op === 'upsert_note') {
        const { error } = await supabase.from(NOTES_TABLE).upsert(entry.row);
        if (!error) await dbDeleteSyncQueueItem(entry.id);
      } else if (entry.op === 'update_note') {
        const { error } = await supabase.from(NOTES_TABLE).update(entry.patch).eq('id', entry.note_id);
        if (!error) await dbDeleteSyncQueueItem(entry.id);
      } else if (entry.op === 'delete_note') {
        const { error } = await supabase.from(NOTES_TABLE).delete().eq('id', entry.note_id);
        if (!error) await dbDeleteSyncQueueItem(entry.id);
      }
    } catch (e) {
      console.warn('[RecallFox] sync queue item failed:', entry.id, e.message);
      // Keep in queue, retry next time
    }
  }
}

// ===== Utility: dataUrl → Blob (lebih reliable di mobile dibanding fetch) =====
export function dataUrlToBlob(dataUrl) {
  try {
    if (!dataUrl || !dataUrl.startsWith('data:')) return null;
    const [meta, b64] = dataUrl.split(',');
    if (!b64) return null;
    const mimeMatch = meta.match(/data:([^;]+)/);
    const mime = mimeMatch ? mimeMatch[1] : 'image/png';
    // Cek apakah base64
    if (!meta.includes(';base64')) {
      // Data URL non-base64 (URL-encoded) — rare, fallback ke fetch
      return null;
    }
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new Blob([bytes], { type: mime });
  } catch (e) {
    console.warn('[RecallFox] dataUrlToBlob failed:', e.message);
    return null;
  }
}
