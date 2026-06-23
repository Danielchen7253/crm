self.CRM_CACHE_NAME = "coolfix-crm-mobile-v2";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(self.CRM_CACHE_NAME).then((cache) =>
      cache.addAll(["/mobile/inbox", "/manifest.webmanifest", "/mobile-icon.svg"]),
    ),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== self.CRM_CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.pathname.startsWith("/api/")) return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(self.CRM_CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match("/mobile/inbox"))),
  );
});
