// ⚡ Stroom — offline support.
// Network first, saved copy as fallback: online you always get the latest
// page, offline the last one you saw. The price APIs are on other domains and
// never pass through here — the page keeps its own copy of the prices.
const CACHE = 'stroom-shell-v1';
const SHELL = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'shared/config.js',
  'shared/classify.js',
  'shared/describe.js',
  'shared/fetch-prices.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(event.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(event.request, { ignoreSearch: true }).then((r) => r || caches.match('index.html')))
  );
});
