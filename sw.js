const CACHE = "entrenacoco-v3";

// Lista de assets “core” que quieres offline sí o sí
const ASSETS = [
  "./",
  "./index.html",
  "./styles/app.css",
  "./styles/mobile.css",
  "./manifest.webmanifest",
  "./src/main.js",
  "./src/ui.js",
  "./src/router.js",
  "./src/state/db.js",
  "./src/state/deck.js",
  "./src/engine/normalize.js",
  "./src/engine/srs.js",
  "./src/modes/home.js",
  "./src/modes/study.js",
  "./src/modes/pasapalabra.js",
  "./src/modes/editor.js",
  "./src/auth/auth_stub.js",
  "./decks/oficiales.es.json"
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    (async () => {
      // Borra caches antiguos
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => (k !== CACHE ? caches.delete(k) : Promise.resolve())));
      await self.clients.claim();
    })()
  );
});

// Cache-first con actualización en background para assets estáticos.
// Para HTML: network-first (para ver cambios rápido)
self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);

  // Solo cacheamos mismo origen
  if (url.origin !== location.origin) return;

  const isHTML = req.mode === "navigate" || (req.headers.get("accept") || "").includes("text/html");

  if (isHTML) {
    // HTML: intenta red primero para que despliegues se vean
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then((r) => r || caches.match("./index.html")))
    );
    return;
  }

  // JS/CSS/JSON/etc: cache-first, pero refresca cache si hay red
  e.respondWith(
    caches.match(req).then((cached) => {
      const fetchPromise = fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => null);

      return cached || fetchPromise || new Response("", { status: 504 });
    })
  );
});
