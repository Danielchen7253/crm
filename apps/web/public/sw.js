self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open("coolfix-crm-mobile-v1").then((cache) =>
      cache.addAll(["/mobile/inbox", "/manifest.webmanifest", "/mobile-icon.svg"]),
    ),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open("coolfix-crm-mobile-v1").then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match("/mobile/inbox"))),
  );
});
