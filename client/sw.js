// The service worker that makes Deadzone installable as an app (Add to Home Screen / Install).
// It doesn't cache anything: the game needs the live server anyway, and a cached copy would only
// keep you on an old version after an update. Every request goes straight to the network.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
