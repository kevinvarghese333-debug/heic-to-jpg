/**
 * Offline support.
 *
 * Vite emits content-hashed filenames, so a hand-written precache list would go
 * stale on every build. Instead this caches same-origin GET responses as they
 * are fetched: the first visit populates the cache, and every visit after that
 * works with no network at all — which is also the simplest way for someone to
 * verify the no-upload claim (turn off wifi, it still converts).
 */
const CACHE = 'heic-to-jpg-v1';
const SHELL = ['/', '/index.html', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL).catch(() => undefined)),
  );
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
        .catch(() => {
          // Offline navigation falls back to the cached app shell.
          if (request.mode === 'navigate') return caches.match('/index.html');
          return Response.error();
        });
    }),
  );
});
