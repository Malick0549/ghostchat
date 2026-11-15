// GhostChat service worker  v2
// Goal: make the app installable and show a friendly page when offline.
// It deliberately does NOT cache anything private:
//   - never /api, /socket.io, /health, /uploads or message media
//   - never a response that says no-store/private, or that is not a plain 200
// Pages and scripts are fetched from the network first (so a new release is used at once);
// the cache is only a fallback when the network is down.
const VERSION = 'ghostchat-v2';
const SHELL = ['/offline.html', '/assets/icons/icon-192.png', '/assets/icons/icon-512.png'];
const NEVER = [/^\/api\//, /^\/socket\.io\//, /^\/health/, /^\/uploads\//, /^\/avatar/, /^\/admin/];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (NEVER.some(re => re.test(url.pathname))) return;
  e.respondWith((async () => {
    try {
      const res = await fetch(req);
      const cc = (res.headers.get('Cache-Control') || '').toLowerCase();
      if (res.status === 200 && res.type === 'basic' && !/no-store|private/.test(cc) && /\.(css|js|png|svg|ico|woff2?|html)$/.test(url.pathname)) {
        const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)).catch(() => {});
      }
      return res;
    } catch (_) {
      const hit = await caches.match(req);
      if (hit) return hit;
      if (req.mode === 'navigate') return (await caches.match('/offline.html')) || Response.error();
      return Response.error();
    }
  })());
});
