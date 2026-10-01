/* Served as /sw.js only on retired storefront origins. No imports or fetch handler. */
self.addEventListener("install", function (event) {
  event.waitUntil(self.skipWaiting());
});
self.addEventListener("activate", function (event) {
  event.waitUntil(
    (async function () {
      try {
        await self.clients.claim();
        var names = await caches.keys();
        await Promise.all(
          names
            .filter(function (name) {
              return /^runtime-cache-v/.test(name);
            })
            .map(function (name) {
              return caches.delete(name);
            }),
        );
      } finally {
        await self.registration.unregister();
      }
    })(),
  );
});
