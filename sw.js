const CACHE = "gpn-v4";
const ASSETS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./firebase-config.js",
  "./icons/icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png"
];

self.addEventListener("install", function(event) {
  event.waitUntil(
    caches.open(CACHE).then(function(cache) {
      return cache.addAll(ASSETS);
    })
  );
  self.skipWaiting();
});

self.addEventListener("activate", function(event) {
  event.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(k) { return k !== CACHE; }).map(function(k) { return caches.delete(k); })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener("fetch", function(event) {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (!/\.(html|js|json|png|svg)$/.test(url.pathname) && !url.pathname.endsWith("/citi/")) return;

  event.respondWith(
    caches.match(event.request).then(function(cached) {
      const network = fetch(event.request).then(function(response) {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then(function(cache) {
            cache.put(event.request, copy);
          });
        }
        return response;
      });
      return cached || network;
    }).catch(function() {
      return caches.match("./index.html");
    })
  );
});
