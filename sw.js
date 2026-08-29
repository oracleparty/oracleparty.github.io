// ============================================
// Oracle Party — Service Worker
// Caches app shell for offline launch + faster loads.
// Supabase API calls are always network-only.
// ============================================

const CACHE_VERSION = 'op-v20260829d';
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

// Third-party module URLs we treat as part of the app shell. These use a
// major-version tag (e.g. @2) so esm.sh may transparently serve a newer
// minor over time — but we still want stale-while-revalidate so a temporary
// CDN outage cannot strand users on a blank page after they've loaded
// the app once. Match by URL prefix in the fetch handler.
const PINNED_VENDOR = [
  'https://esm.sh/@supabase/supabase-js@2',
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

  // Pinned vendor (Supabase JS): stale-while-revalidate. Serve cached copy
  // instantly if we have one (so a slow/dead esm.sh can't blank the page
  // after first load), but kick off a background fetch to refresh the
  // cache for next time. Floats with esm.sh's resolution of @2.
  if (event.request.method === 'GET' && PINNED_VENDOR.some(u => href.startsWith(u))) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        const fresh = fetch(event.request).then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_VERSION).then(cache => cache.put(event.request, clone));
          }
          return response;
        });
        return cached || fresh;
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
