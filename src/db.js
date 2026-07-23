// src/db.js — IndexedDB wrapper (offline cache + sync queue)
// Pakai library `idb` (3KB) untuk API yang lebih ergonomis.

import { openDB } from 'idb';

const DB_NAME = 'recallfox-pwa';
const DB_VERSION = 1;

let _db = null;

export async function getDB() {
  if (_db) return _db;
  _db = await openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      // Vault items cache (mirror of Supabase vault_items untuk user ini)
      if (!db.objectStoreNames.contains('vault_items')) {
        const store = db.createObjectStore('vault_items', { keyPath: 'id' });
        store.createIndex('updated_at', 'updated_at');
        store.createIndex('type', 'type');
      }
      // Notes cache
      if (!db.objectStoreNames.contains('notes')) {
        const store = db.createObjectStore('notes', { keyPath: 'id' });
        store.createIndex('updated_at', 'updated_at');
      }
      // Sync queue (pending uploads saat offline)
      if (!db.objectStoreNames.contains('sync_queue')) {
        db.createObjectStore('sync_queue', { keyPath: 'id', autoIncrement: true });
      }
      // Screenshot blobs (dataUrl cache untuk akses offline)
      if (!db.objectStoreNames.contains('screenshot_blobs')) {
        db.createObjectStore('screenshot_blobs', { keyPath: 'id' });
      }
    }
  });
  return _db;
}

// ===== Vault items =====
export async function dbGetAllVaultItems() {
  const db = await getDB();
  return db.getAll('vault_items');
}

export async function dbGetVaultItem(id) {
  const db = await getDB();
  return db.get('vault_items', id);
}

export async function dbPutVaultItem(item) {
  const db = await getDB();
  await db.put('vault_items', item);
}

export async function dbDeleteVaultItem(id) {
  const db = await getDB();
  await db.delete('vault_items', id);
}

export async function dbClearVaultItems() {
  const db = await getDB();
  await db.clear('vault_items');
}

// ===== Notes =====
export async function dbGetAllNotes() {
  const db = await getDB();
  return db.getAll('notes');
}

export async function dbPutNote(note) {
  const db = await getDB();
  await db.put('notes', note);
}

export async function dbDeleteNote(id) {
  const db = await getDB();
  await db.delete('notes', id);
}

// ===== Sync queue =====
export async function dbEnqueueSync(item) {
  const db = await getDB();
  return db.add('sync_queue', { ...item, enqueuedAt: new Date().toISOString() });
}

export async function dbGetSyncQueue() {
  const db = await getDB();
  return db.getAll('sync_queue');
}

export async function dbDeleteSyncQueueItem(id) {
  const db = await getDB();
  await db.delete('sync_queue', id);
}

// ===== Screenshot blobs =====
export async function dbGetScreenshotBlob(id) {
  const db = await getDB();
  const rec = await db.get('screenshot_blobs', id);
  return rec?.dataUrl || null;
}

export async function dbPutScreenshotBlob(id, dataUrl) {
  const db = await getDB();
  await db.put('screenshot_blobs', { id, dataUrl, cachedAt: new Date().toISOString() });
}

export async function dbDeleteScreenshotBlob(id) {
  const db = await getDB();
  await db.delete('screenshot_blobs', id);
}
