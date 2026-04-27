self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
    } catch (_) {}
    try {
      await self.registration.unregister();
    } catch (_) {}
    const clients = await self.clients.matchAll({ type: 'window' });
    for (const client of clients) {
      client.navigate(client.url);
    }
  })());
});

self.addEventListener('fetch', () => {
  // Intentionally no-op. This worker only cleans previous buggy SW state.
});
