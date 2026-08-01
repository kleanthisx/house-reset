/* Reset — service worker. Cache the app shell so it launches offline (airplane mode
   is a hard acceptance criterion). Network-first for same-origin so updates land when
   online; cache fallback when offline. Photos/data live in IndexedDB, not here. */

const CACHE = 'reset-v1';
const ASSETS = [
  './',
  'index.html',
  'manifest.webmanifest',
  'icon.svg',
  'css/styles.css',
  'js/app.js',
  'js/util.js',
  'js/db.js',
  'js/timer.js',
  'js/seed.js',
  'js/photos.js',
  'js/photo-worker.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      // Don't let one missing asset (e.g. an icon not generated yet) abort the whole install.
      .then((c) => Promise.allSettled(ASSETS.map((a) => c.add(a))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return; // never touch cross-origin
  e.respondWith(
    fetch(e.request)
      .then((resp) => {
        if (resp && resp.ok) {
          const clone = resp.clone();
          caches.open(CACHE).then((c) => c.put(e.request, clone));
        }
        return resp;
      })
      .catch(() => caches.match(e.request).then((m) => m || caches.match('index.html')))
  );
});
