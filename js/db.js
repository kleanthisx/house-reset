// Reset — IndexedDB layer. All records, including photo Blobs, live here.
// NEVER use localStorage for photos (5MB cap, strings only). Blobs go in IDB.

const DB_NAME = 'reset';
const DB_VERSION = 1;
let _db = null;

export function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('templates')) {
        const t = db.createObjectStore('templates', { keyPath: 'id' });
        t.createIndex('updatedAt', 'updatedAt');
      }
      if (!db.objectStoreNames.contains('sessions')) {
        const s = db.createObjectStore('sessions', { keyPath: 'id' });
        s.createIndex('status', 'status');
        s.createIndex('startedAt', 'startedAt');
      }
      if (!db.objectStoreNames.contains('photos')) {
        const p = db.createObjectStore('photos', { keyPath: 'id' });
        p.createIndex('sessionId', 'sessionId');
        p.createIndex('sessionBlockId', 'sessionBlockId');
        p.createIndex('blockKind', ['sessionBlockId', 'kind']); // spec: [sessionBlockId+kind]
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

// Resolve on transaction COMPLETE for writes, so a resolved promise means durably queued+committed.
export function put(store, value) {
  return openDB().then((db) => new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value);
    tx.oncomplete = () => res(value);
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error || new Error('tx aborted'));
  }));
}

export function del(store, key) {
  return openDB().then((db) => new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error || new Error('tx aborted'));
  }));
}

export function get(store, key) {
  return openDB().then((db) => new Promise((res, rej) => {
    const r = db.transaction(store, 'readonly').objectStore(store).get(key);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
}

export function getAll(store) {
  return openDB().then((db) => new Promise((res, rej) => {
    const r = db.transaction(store, 'readonly').objectStore(store).getAll();
    r.onsuccess = () => res(r.result || []);
    r.onerror = () => rej(r.error);
  }));
}

export function getAllByIndex(store, index, query) {
  return openDB().then((db) => new Promise((res, rej) => {
    const r = db.transaction(store, 'readonly').objectStore(store).index(index).getAll(query);
    r.onsuccess = () => res(r.result || []);
    r.onerror = () => rej(r.error);
  }));
}

// --- meta helpers (key/value: schemaVersion, activeSessionId, settings, seededAt) ---
export async function metaGet(key, fallback = null) {
  const row = await get('meta', key);
  return row ? row.value : fallback;
}
export function metaSet(key, value) {
  return put('meta', { key, value });
}

// --- convenience: non-deleted records only ---
export async function listTemplates() {
  return (await getAll('templates')).filter((t) => !t.deletedAt);
}
export async function listSessions() {
  return (await getAll('sessions')).filter((s) => !s.deletedAt);
}
