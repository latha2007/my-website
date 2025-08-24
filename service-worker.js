// Basic offline shell cache (no 3rd-party assets)
const CACHE = "nav-v1";
const ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./script.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))
        )
      )
  );
});

self.addEventListener("fetch", (e) => {
  const { request } = e;
  // Network-first for routing/geocoding; cache-first for local assets
  const isLocal = request.url.startsWith(self.location.origin);
  if (isLocal) {
    e.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ||
          fetch(request)
            .then((resp) => {
              const copy = resp.clone();
              caches.open(CACHE).then((c) => c.put(request, copy));
              return resp;
            })
            .catch(() => cached)
      )
    );
  } else {
    // pass-through for OSRM/Nominatim/tiles to avoid CORS/cache headaches
    e.respondWith(fetch(request).catch(() => caches.match("./index.html")));
  }
});
