// The service worker that makes Deadzone installable as an app (Add to Home Screen / Install).
// It doesn't cache anything: the game needs the live server anyway, and a cached copy would only
// keep you on an old version after an update. Every request goes straight to the network.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});

// Base alerts (Web Push): the server sends one when your base is attacked while you're out of the game.
self.addEventListener('push', (e) => {
  let m = {};
  try { m = e.data ? e.data.json() : {}; } catch { m = { body: e.data?.text() }; }
  e.waitUntil(self.registration.showNotification(m.title || 'Deadzone', {
    body: m.body || 'Your base is under attack',
    icon: '/icons/icon-192.png', badge: '/icons/icon-192.png',
    tag: m.tag || 'base', renotify: true, vibrate: [200, 100, 200, 100, 400],
    data: { url: '/' },
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    const open = list.find((c) => 'focus' in c);
    return open ? open.focus() : self.clients.openWindow('/');
  }));
});
