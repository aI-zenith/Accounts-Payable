/* Zenith Group — service worker. Keeps the app installable and gives a usable
   offline shell. Pages are network-first (never serve stale private data);
   static assets are cache-first. */
const CACHE = 'zenith-v2';
const SHELL = [
  '/css/styles.css',
  '/css/app.css',
  '/css/tasks.css',
  '/js/app.js',
  '/img/zenith-mark.svg',
  '/img/icon-192.png',
  '/manifest.webmanifest',
  '/offline.html',
];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => {})))));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // App pages: network-first, fall back to the offline page when offline.
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() => caches.match('/offline.html')));
    return;
  }

  // Static assets: stale-while-revalidate — instant from cache, refreshed in
  // the background so a new deploy is picked up on the next load.
  if (/\.(?:css|js|svg|png|jpg|jpeg|woff2?|webmanifest)$/.test(url.pathname)) {
    e.respondWith(
      caches.open(CACHE).then((c) =>
        c.match(req).then((hit) => {
          const net = fetch(req)
            .then((res) => {
              if (res && res.ok) c.put(req, res.clone());
              return res;
            })
            .catch(() => hit);
          return hit || net;
        })
      )
    );
  }
});
