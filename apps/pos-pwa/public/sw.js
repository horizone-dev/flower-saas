/* Flower SaaS POS — Phase 0 service worker.
 *
 * SHELL PRECACHE ONLY. Runtime caching of mutable API responses is deliberately
 * NOT done here — the POS is online-first (Z-6 / ADR-0008); financial and
 * inventory-changing operations are online-only. Reference-data caching with a
 * visible "as of HH:MM" marker arrives in a later phase.
 */
const SHELL_CACHE = 'flower-pos-shell-v1';
const SHELL_ASSETS = ['/', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // Never serve API or cross-origin requests from cache.
  if (url.origin !== self.location.origin || url.pathname.startsWith('/v1')) return;

  // App-shell navigations: network-first, fall back to the cached shell offline.
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match('/', { cacheName: SHELL_CACHE })));
    return;
  }

  // Static shell assets: cache-first.
  event.respondWith(caches.match(request).then((hit) => hit || fetch(request)));
});
