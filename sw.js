// Minimal service worker. It lets phones offer "Install app".
// It does not save any pages, so people always get the latest version of the site.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).catch(() => new Response(
      '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:sans-serif;padding:40px 20px;text-align:center"><h2>You are offline</h2><p>Check your internet connection and try again.</p></body>',
      { headers: { 'Content-Type': 'text/html' } })));
  }
});
