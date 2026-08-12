// CTP Core — service worker. Hand-rolled on purpose: three caching rules and
// zero build-time dependencies.
//
//   1. Catalogue images (the Supabase Storage bucket) — cache-first, forever.
//      The bucket is served with `immutable, max-age=1y`; a changed image is
//      re-uploaded under the SAME key though, so "forever" is really "until
//      the cache is dropped". CACHE version bumps drop it.
//   2. The app shell (same-origin navigations + hashed build assets) —
//      network-first with cache fallback, so the app opens in a dead zone in
//      the warehouse but still picks up new deploys when there is signal.
//   3. Everything that is DATA — Supabase REST/auth, the PowerSync socket —
//      is never touched. PowerSync already owns offline data (local SQLite);
//      a stale cached API response would only fight it.
const CACHE = "ctp-core-v1";
const ASSET_HOST = "hkzmydowyiajkbakxfkj.supabase.co";

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(["/"])));
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
  if (e.request.method !== "GET") return;

  // Rule 3: hands off data. Only the public storage endpoint is cacheable.
  if (url.hostname === ASSET_HOST && !url.pathname.startsWith("/storage/v1/object/public/")) return;
  if (url.hostname.endsWith("powersync.journeyapps.com")) return;

  // Rule 1: catalogue images — cache-first.
  if (url.hostname === ASSET_HOST) {
    e.respondWith(
      caches.open(CACHE).then(async (c) => {
        const hit = await c.match(e.request);
        if (hit) return hit;
        const res = await fetch(e.request);
        if (res.ok) c.put(e.request, res.clone());
        return res;
      })
    );
    return;
  }

  // Rule 2: the app shell — network-first, cache fallback.
  if (url.origin === self.location.origin) {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy));
          }
          return res;
        })
        .catch(async () => {
          const hit = await caches.match(e.request);
          // An offline navigation falls back to the cached shell.
          return hit ?? (e.request.mode === "navigate"
            ? (await caches.match("/")) ?? Response.error()
            : Response.error());
        })
    );
  }
});
