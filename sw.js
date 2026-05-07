// Shifty Service Worker v3 — HTML はキャッシュせず常に network、静的アセットのみキャッシュ
// CACHE 名を bump すると activate 時に旧キャッシュを削除する
const CACHE = "shifty-v5";
const STATIC_ASSETS = [
  "/styles.css",
  "/manifest.json",
  "/js/api.js",
  "/js/data.js",
  "/js/algorithm.js",
  "/js/app.js",
  "/js/staff-portal.js",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(STATIC_ASSETS)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);

  // API はキャッシュしない
  if (url.pathname.startsWith("/api/")) {
    e.respondWith(fetch(e.request).catch(() => new Response('{"error":"offline"}', { headers: { "Content-Type": "application/json" } })));
    return;
  }

  // HTML ドキュメントは常に network から（キャッシュしない）
  if (e.request.destination === "document" || url.pathname === "/" || url.pathname === "/app" || url.pathname === "/staff" ||
      url.pathname === "/tos" || url.pathname === "/privacy" || url.pathname === "/tokushoho") {
    e.respondWith(fetch(e.request).catch(() => caches.match("/app")));
    return;
  }

  // 静的アセットは cache-first
  if (e.request.method === "GET") {
    e.respondWith(
      caches.match(e.request).then((cached) =>
        cached ||
        fetch(e.request).then((r) => {
          if (r.ok && r.type === "basic") {
            const clone = r.clone();
            caches.open(CACHE).then((c) => c.put(e.request, clone));
          }
          return r;
        }).catch(() => caches.match(e.request))
      )
    );
  }
});
