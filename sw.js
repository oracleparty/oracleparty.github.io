// ============================================
// Oracle Party — Service Worker
// Caches app shell for offline launch + faster loads.
// Supabase API calls are always network-only.
// ============================================

const CACHE_VERSION = 'op-v56';
const APP_SHELL = [
  './',
  './index.html',
  './host.html',
  './join.html',
  './lobby.html',
  './game.html',
  './leaderboard.html',
  './profile.html',
  './css/style.css',
  './js/categories.js',
  './fonts/hieroglyphs.woff2',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

// Pinned, immutable third-party URLs we treat as part of the app shell.
// Cache-first: once fetched, we never go back to the network for them
// (their version is in the URL, so they cannot change underneath us).
const PINNED_VENDOR = [
  'https://esm.sh/@supabase/supabase-js@2.45.4',
];

// Install: cache app shell + pinned vendor. Vendor is fetched with no-cors
// so we don't fail install if esm.sh is briefly down — we'll just lazy-cache
// it on first fetch instead. App-shell failures still abort install (correct).
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(async (cache) => {
        await cache.addAll(APP_SHELL);
        await Promise.allSettled(
          PINNED_VENDOR.map(u => fetch(u).then(r => r.ok && cache.put(u, r)).catch(() => {}))
        );
      })
      .then(() => self.skipWaiting())
  );
});

// Activate: clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// Fetch: network-first for everything, cache as fallback (offline support).
// This ensures users always get fresh files while still working offline.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const href = url.origin + url.pathname + url.search;

  // Pinned vendor (Supabase JS): cache-first. URL has the version in it, so
  // contents can never change. This is the fix for the "esm.sh is slow/down
  // → blank app" failure mode we saw in production.
  if (event.request.method === 'GET' && PINNED_VENDOR.some(u => href.startsWith(u))) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_VERSION).then(cache => cache.put(event.request, clone));
          }
          return response;
        });
      })
    );
    return;
  }

  // Never cache Supabase, external APIs, or WebSocket upgrades
  if (
    url.hostname.includes('supabase') ||
    url.hostname.includes('googleapis') ||
    url.hostname.includes('gstatic') ||
    url.hostname !== self.location.hostname ||
    event.request.method !== 'GET'
  ) {
    return; // let the browser handle it normally
  }

  // Network-first: always try fresh, fall back to cache if offline
  event.respondWith(
    fetch(event.request)
      .then(response => {
        // Update cache with fresh response
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_VERSION).then(cache => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
