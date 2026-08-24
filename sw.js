/* LOOX — service worker
   Handles offline app-shell loading. The app's Qur'an/tafsir/hadith/salah
   data already caches itself into IndexedDB via cacheGet/cacheSet in
   index.html — this worker's job is everything IndexedDB can't cover:
   letting the page itself (HTML/manifest/icons/fonts) open with no
   network at all, and giving other GET requests a cache fallback. */

const VERSION = 'v1';
const SHELL_CACHE = `loox-shell-${VERSION}`;
const FONT_CACHE = `loox-fonts-${VERSION}`;
const RUNTIME_CACHE = `loox-runtime-${VERSION}`;
const KEEP = [SHELL_CACHE, FONT_CACHE, RUNTIME_CACHE];

const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './favicon-32.png',
  './icon-192.png',
  './icon-512.png',
  './icon-512-maskable.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // allSettled, not addAll — one bad request shouldn't sink the whole install
    await Promise.allSettled(SHELL_ASSETS.map((url) => cache.add(url)));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.map((n) => (KEEP.includes(n) ? null : caches.delete(n))));
    self.clients.claim();
  })());
});

function isFontHost(hostname) {
  return hostname === 'fonts.googleapis.com' ||
         hostname === 'fonts.gstatic.com' ||
         hostname === 'db.onlinewebfonts.com';
}

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Only GET is cacheable; POSTs (e.g. the Gemini "ask" calls) go straight
  // to the network and simply fail naturally when offline.
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // ---- Same-origin app shell ----
  if (url.origin === self.location.origin) {
    // Full-page navigations: try network first (so a real connection
    // always gets the latest build), fall back to the cached shell.
    if (req.mode === 'navigate') {
      event.respondWith((async () => {
        try {
          const fresh = await fetch(req);
          const cache = await caches.open(SHELL_CACHE);
          cache.put('./index.html', fresh.clone());
          return fresh;
        } catch (e) {
          const cache = await caches.open(SHELL_CACHE);
          return (await cache.match('./index.html')) || (await cache.match('./'));
        }
      })());
      return;
    }
    // Other same-origin assets (manifest, icons): cache-first, refresh in background.
    event.respondWith((async () => {
      const cache = await caches.open(SHELL_CACHE);
      const cached = await cache.match(req);
      const network = fetch(req).then((res) => {
        if (res.ok) cache.put(req, res.clone());
        return res;
      }).catch(() => cached);
      return cached || network;
    })());
    return;
  }

  // ---- Web fonts (Google Fonts + the custom Kufi/Naskh cuts) ----
  // These almost never change, so cache-first is safe and keeps Arabic
  // text rendering correctly offline after the first successful load.
  if (isFontHost(url.hostname)) {
    event.respondWith((async () => {
      const cache = await caches.open(FONT_CACHE);
      const cached = await cache.match(req);
      if (cached) return cached;
      try {
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      } catch (e) {
        return cached; // undefined if never fetched — browser just skips the font
      }
    })());
    return;
  }

  // ---- Everything else (Qur'an text, tafsir, hadith, prayer-time APIs) ----
  // Network-first so an online device always sees fresh data; on failure,
  // fall back to whatever was last fetched. This is a safety net alongside
  // the app's own IndexedDB caching, not a replacement for it.
  event.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok) {
        const cache = await caches.open(RUNTIME_CACHE);
        cache.put(req, res.clone());
      }
      return res;
    } catch (e) {
      const cache = await caches.open(RUNTIME_CACHE);
      const cached = await cache.match(req);
      if (cached) return cached;
      throw e;
    }
  })());
});
