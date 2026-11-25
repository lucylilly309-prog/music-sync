/* SyncPair service worker: network-first for the app shell, with the last good copy as an offline fallback.
   It never touches /api, /music, /health or the Socket.IO transport, so sync and audio behave exactly as before. */
const VERSION = 'syncpair-v29';
const SHELL = ['/', '/app.js', '/style.css', '/embed.html', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png', '/socket.io/socket.io.js'];
const SHELL_SET = new Set(SHELL);

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(VERSION)
      .then(cache => Promise.allSettled(SHELL.map(path => cache.add(path))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('syncpair-') && k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET' || req.headers.has('range')) return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || !SHELL_SET.has(url.pathname)) return;
  event.respondWith(
    fetch(req)
      .then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(cache => cache.put(url.pathname, copy)).catch(() => {}); }
        return res;
      })
      .catch(() => caches.match(url.pathname).then(hit => hit || Response.error()))
  );
});

// ---- Notifications (Web Push) ----
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data ? event.data.text() : '' }; }
  event.waitUntil(self.registration.showNotification(data.title || 'SyncPair', {
    body: data.body || '', tag: data.tag || 'syncpair', renotify: true, icon: '/icon-192.png', badge: '/icon-192.png', data: { url: data.url || '/' }
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) if ('focus' in c) return c.focus();
    return self.clients.openWindow(url);
  }));
});
