/**
 * Offline support.
 *
 * Strategy differs by request type, deliberately:
 *
 * - **Navigations** are network-first. The HTML shell is the one file whose URL
 *   never changes, so serving it cache-first would pin visitors to whatever
 *   build they first landed on and make every future deploy invisible to them.
 * - **Hashed assets** are cache-first. Vite gives them content-addressed
 *   filenames, so a cached copy can never be stale — a changed file is a
 *   different URL.
 *
 * Together that means the app updates on the next visit while still working
 * with no network at all.
 */
const CACHE = 'image-toolkit-v2';
const SHELL = ['/', '/index.html', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL).catch(() => undefined)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // The service worker script and the manifest must never be served from the
  // cache, or a new version could never take over.
  if (url.pathname === '/sw.js') return;

  const isNavigation = request.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('.html');

  if (isNavigation) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => caches.match(request).then((cached) => cached || caches.match('/index.html'))),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request)
        .then((response) => {
          if (response.ok && response.type === 'basic') {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => Response.error());
    }),
  );
});
