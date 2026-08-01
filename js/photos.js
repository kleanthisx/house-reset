// Reset — photo capture, resize orchestration, storage, and blob-URL lifecycle.
import { uid, now } from './util.js';
import * as db from './db.js';

// ---- Worker (with main-thread fallback) ----
let _worker = null;
let _seq = 0;
const _pending = new Map();

function getWorker() {
  if (_worker === false) return null; // known-unsupported
  if (_worker) return _worker;
  try {
    _worker = new Worker('js/photo-worker.js');
    _worker.onmessage = (e) => {
      const { id } = e.data;
      const p = _pending.get(id);
      if (!p) return;
      _pending.delete(id);
      e.data.ok ? p.resolve(e.data) : p.reject(new Error(e.data.error));
    };
    _worker.onerror = () => { _worker = false; }; // fall back on hard worker error
    return _worker;
  } catch (_) {
    _worker = false;
    return null;
  }
}

function resizeInWorker(file) {
  const w = getWorker();
  if (!w) return null;
  const id = ++_seq;
  return new Promise((resolve, reject) => {
    _pending.set(id, { resolve, reject });
    w.postMessage({ id, file });
  });
}

// Main-thread fallback: used when OffscreenCanvas/Worker is unavailable.
async function resizeOnMain(file) {
  const bitmap = await createImageBitmap(file);
  const draw = async (maxEdge, quality) => {
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', quality));
    return { blob, width: w, height: h };
  };
  const full = await draw(1600, 0.8);
  const thumb = await draw(320, 0.7);
  bitmap.close && bitmap.close();
  return { full, thumb, width: full.width, height: full.height };
}

// Capture + process + persist. Returns the stored Photo record.
export async function capturePhoto(file, { sessionId, sessionBlockId, kind }) {
  let out;
  try {
    out = (await resizeInWorker(file)) || (await resizeOnMain(file));
  } catch (_) {
    out = await resizeOnMain(file); // worker failed mid-flight -> main thread
  }

  // Replace any existing photo of this block+kind (spec allows replacing later).
  const existing = await db.getAllByIndex('photos', 'blockKind', [sessionBlockId, kind]);
  for (const old of existing) { revoke(old.id); await db.del('photos', old.id); }

  const photo = {
    id: uid(),
    sessionId,
    sessionBlockId,
    kind,                       // 'before' | 'after'
    full: out.full.blob,
    thumb: out.thumb.blob,
    width: out.width,
    height: out.height,
    bytes: out.full.blob.size,
    createdAt: now(),
    syncedAt: null,
    remoteUrl: null,
  };
  await db.put('photos', photo);
  return photo;
}

// ---- Object-URL cache (create once per photo id+variant, revoke on demand) ----
const _urls = new Map(); // key: `${photoId}:${variant}` -> objectURL

export async function urlFor(photoId, variant = 'thumb') {
  if (!photoId) return null;
  const key = `${photoId}:${variant}`;
  if (_urls.has(key)) return _urls.get(key);
  const photo = await db.get('photos', photoId);
  if (!photo) return null;
  const url = URL.createObjectURL(variant === 'full' ? photo.full : photo.thumb);
  _urls.set(key, url);
  return url;
}

export function revoke(photoId) {
  for (const variant of ['thumb', 'full']) {
    const key = `${photoId}:${variant}`;
    if (_urls.has(key)) { URL.revokeObjectURL(_urls.get(key)); _urls.delete(key); }
  }
}

// Revoke every live URL — call before a full re-render to avoid blob-URL leaks.
export function revokeAll() {
  for (const url of _urls.values()) URL.revokeObjectURL(url);
  _urls.clear();
}

export async function getPhoto(photoId) {
  return photoId ? db.get('photos', photoId) : null;
}
