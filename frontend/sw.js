// service-worker.js - Enables offline capability
const CACHE_NAME = 'ghostchat-v1';
const urlsToCache = [
  '/',
  '/index.html',
  '/dashboard.html',
  '/login.html',
  '/register.html',
  '/css/ghostchat.css',
  '/themes/dark.theme.css',
  '/themes/light.theme.css',
  '/js/ui.js',
  '/js/api.js',
  '/js/encrypt.js',
  '/js/decrypt.js',
  '/js/dashboard.js',
  '/assets/icons/icon-192.png',
  '/assets/icons/icon-512.png'
];

// Install service worker
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(urlsToCache))
  );
});

// Fetch from cache first, then network
self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request)
      .then(response => response || fetch(event.request))
  );
});

// Activate and clean old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cache => {
          if (cache !== CACHE_NAME) {
            return caches.delete(cache);
          }
        })
      );
    })
  );
});