const CACHE = "entrenacoco-v2";
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
  "./src/state/telemetry.js",
  "./src/state/ranking.js",

  "./src/engine/normalize.js",
  "./src/engine/srs.js",

  "./src/modes/home.js",
  "./src/modes/study.js",
  "./src/modes/pasapalabra.js",
  "./src/modes/ranking.js",
  "./src/modes/editor.js",

  "./src/auth/auth_stub.js",
  "./decks/oficiales.es.json"
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (e) => {
  e.respondWith(
    caches.match(e.request).then((r) => r || fetch(e.request))
  );
});
