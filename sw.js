// ============================================
// Oracle Party — Service Worker
// Caches app shell for offline launch + faster loads.
// Supabase API calls are always network-only.
// ============================================

const CACHE_VERSION = 'op-v17';
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
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

// Install: cache app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(cache => cache.addAll(APP_SHELL))
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
