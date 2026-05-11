// Shifty Service Worker v8 — HTML はキャッシュせず常に network、静的アセットのみキャッシュ
// + Round 34: Web Push 通知サポート
// + Round 42: CRITICAL bug fix (seedState → migrate) と dark mode 包括対応で再 bump
// CACHE 名を bump すると activate 時に旧キャッシュを削除する
const CACHE = "shifty-v8";
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
  // Round 42: ネットワーク失敗時は 503 で返す。以前は 200 + {"error":"offline"} で返していたが
  // クライアント側 (api.js / loadState) が 401 / 認証エラーと区別できず、
  // 「認証されてないのに認証されたフリ」をしてスケルトン UI で固まる原因になっていた。
  if (url.pathname.startsWith("/api/")) {
    e.respondWith(fetch(e.request).catch(() => new Response(
      JSON.stringify({ error: "offline", message: "ネットワーク接続失敗" }),
      { status: 503, headers: { "Content-Type": "application/json" } }
    )));
    return;
  }

  // HTML ドキュメントは常に network から（キャッシュしない）
  // Round 42 fix: caches.match("/app") は STATIC_ASSETS に含まれていないので必ず undefined を返し、
  // respondWith(undefined) で NetworkError になっていた。fallback で最低限の HTML を返す。
  if (e.request.destination === "document" || url.pathname === "/" || url.pathname === "/app" || url.pathname === "/staff" ||
      url.pathname === "/tos" || url.pathname === "/privacy" || url.pathname === "/tokushoho") {
    e.respondWith(fetch(e.request).catch(() => new Response(
      '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<style>body{font-family:system-ui;max-width:480px;margin:60px auto;padding:24px;text-align:center;background:#0f172a;color:#f1f5f9}.box{background:#1e293b;border-radius:12px;padding:32px}h1{font-size:18px;margin-bottom:12px}p{font-size:13px;line-height:1.6;color:#cbd5e1}button{background:#4f46e5;color:white;border:0;border-radius:8px;padding:10px 20px;font-size:14px;font-weight:600;margin-top:16px;cursor:pointer}</style>' +
      '<div class="box"><div style="font-size:48px">📡</div><h1>オフラインです</h1><p>ネットワーク接続を確認して再読み込みしてください。</p><button onclick="location.reload()">🔄 再読み込み</button></div>',
      { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } }
    )));
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

// Round 34: Web Push 通知 — push イベント受信
self.addEventListener("push", (e) => {
  let data = {};
  try {
    data = e.data ? e.data.json() : {};
  } catch (_) {
    try { data = { title: "Shifty", body: e.data ? e.data.text() : "" }; } catch (_) {}
  }
  const title = data.title || "Shifty";
  const opts = {
    body: data.body || "",
    icon: data.icon || "/manifest.json",
    badge: data.badge || "/manifest.json",
    data: { url: data.url || "/" },
    tag: data.tag || "shifty",
    renotify: !!data.renotify,
    requireInteraction: !!data.urgent,
  };
  e.waitUntil(self.registration.showNotification(title, opts));
});

// 通知クリックで該当 URL を開く
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const targetUrl = (e.notification.data && e.notification.data.url) || "/";
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const c of clients) {
        if (c.url.includes(targetUrl) && "focus" in c) return c.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
