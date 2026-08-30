// CA-Accounting Agent · service worker (app-shell, network-first with offline fallback)
const CACHE = "ca-app-shell-v1";
const ASSETS = [
  "./",
  "./index.html",
  "./data.bundle.js",
  "./rag-client.js",
  "./manifest.webmanifest",
  "./icon.svg"
];

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      return c.addAll(ASSETS).catch(function () {});
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (ks) {
      return Promise.all(ks.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (e) {
  if (e.request.method !== "GET") return;
  e.respondWith(
    fetch(e.request)
      .then(function (r) {
        var cp = r.clone();
        caches.open(CACHE).then(function (c) { c.put(e.request, cp); });
        return r;
      })
      .catch(function () {
        return caches.match(e.request).then(function (m) { return m || caches.match("./index.html"); });
      })
  );
});
