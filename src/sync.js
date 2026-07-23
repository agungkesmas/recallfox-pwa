// src/sync.js — Sync engine: upload/download ke Supabase + Realtime subscription
// Strategi: online-first (langsung upload ke cloud), IndexedDB sebagai cache
// untuk offline read + queue upload yang gagal.

import { supabase, STORAGE_BUCKET, VAULT_TABLE, NOTES_TABLE } from './supabase.js';
import {
  dbGetAllVaultItems, dbPutVaultItem, dbDeleteVaultItem,
  dbGetAllNotes, dbPutNote, dbDeleteNote,
  dbGetScreenshotBlob, dbPutScreenshotBlob, dbDeleteScreenshotBlob,
  dbEnqueueSync, dbGetSyncQueue, dbDeleteSyncQueueItem
} from './db.js';

// ===== Helpers =====
function genId(prefix = 'p') {
  return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

function getDeviceId() {
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
    // Convert dataUrl → Blob
    const resp = await fetch(dataUrl);
    const blob = await resp.blob();
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
    const { error } = await supabase.storage
      .from(STORAGE_BUCKET)
      .upload(path, pngBlob, { contentType: 'image/png', upsert: true });
    if (error) {
      return { ok: false, error: error.message };
    }
    // URL public (bucket screenshots = public=true di Supabase)
    const url = `${supabase.supabaseUrl}/storage/v1/object/public/${STORAGE_BUCKET}/${path}`;
    return { ok: true, url, path };
  } catch (e) {
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
    const res = await fetch(cloudUrl);
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
export async function createScreenshotItem(user, payload) {
  // payload: { dataUrl, width, height, mode, title, annotationNote, sourceUrl, sourceTitle }
  const itemId = genId('sh');
  const now = new Date().toISOString();
  const thumbnailDataUrl = await generateThumbnail(payload.dataUrl, 200);

  // Upload blob ke Storage dulu
  const upRes = await uploadScreenshotBlob(user, itemId, payload.dataUrl);
  if (!upRes.ok) {
    // Kalau upload gagal (mis. offline), enqueue untuk retry
    await dbEnqueueSync({
      op: 'upload_screenshot',
      user_id: user.id,
      item_id: itemId,
      data_url: payload.dataUrl,
      payload
    });
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
      annotationNote: payload.annotationNote || ''  // simpan di source (bukan column)
    },
    screenshot_mode: payload.mode || 'selection',
    screenshot_width: payload.width || 0,
    screenshot_height: payload.height || 0,
    screenshot_format: 'png',
    screenshot_bytes: payload.dataUrl?.length || 0,
    thumbnail_data_url: thumbnailDataUrl,
    gdrive_file_id: upRes.ok ? upRes.path : null,
    gdrive_file_url: upRes.ok ? upRes.url : null,
    // annotation_note TIDAK dikirim — column tidak ada di DB actual.
    // Catatan anotasi disimpan di source.annotationNote (JSONB).
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

  // Insert ke Supabase
  const { data: upsertData, error } = await supabase.from(VAULT_TABLE).upsert(row).select();
  console.log('[RecallFox] upsert result:', { error: error?.message, hasData: !!upsertData });
  if (error) {
    console.error('[RecallFox] upsert FAILED — enqueuing for retry. Row:', { id: row.id, type: row.type });
    await dbEnqueueSync({ op: 'upsert_vault', user_id: user.id, row });
  }

  // Cache ke IndexedDB
  await dbPutVaultItem(row);
  // Cache blob lokal juga
  await dbPutScreenshotBlob(itemId, payload.dataUrl);

  return { ok: true, item: row };
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
  // Hapus dari IndexedDB
  await dbDeleteVaultItem(itemId);
  await dbDeleteScreenshotBlob(itemId);
  return { ok: true };
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
export async function pullFromCloud(user) {
  if (!user) return { ok: false, error: 'no_user' };

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
    // Hapus lokal yang tidak ada di cloud (kecuali yang baru dibuat <60s)
    const now = Date.now();
    for (const li of localItems) {
      if (!cloudIds.has(li.id) && li.user_id === user.id) {
        const createdAt = new Date(li.created_at || 0).getTime();
        if (now - createdAt > 60000) {
          await dbDeleteVaultItem(li.id);
        }
      }
    }
    // Merge cloud → local (last-write-wins by updated_at)
    for (const row of items) {
      const local = await (await import('./db.js')).dbGetVaultItem(row.id);
      if (!local || new Date(row.updated_at) > new Date(local.updated_at || 0)) {
        await dbPutVaultItem(row);
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
          await dbDeleteSyncQueueItem(entry.id);
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
