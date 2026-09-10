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
//
// ── WHAT WAS WRONG WITH v1, and why it presented as "images loading forever"
//
// Rule 1 had three faults stacked on each other, and the visible symptom was
// the third:
//
//   a) `await fetch(...)` with NO CATCH. Offline, that rejects the promise
//      handed to respondWith(). The browser turns that into a network error
//      and, in Chrome, an unhandled rejection PER IMAGE — a burst of them on a
//      diagram page.
//
//   b) `if (res.ok)` never fired. These images are cross-origin and no <img>
//      carries `crossorigin`, so they are no-cors requests returning OPAQUE
//      responses. An opaque response reports `status: 0` and `ok: false` by
//      design, whatever the server actually said. So nothing was ever cached,
//      and every image was fetched over the network every time. In a warehouse
//      with poor signal that is the "loading forever".
//
//   c) NO TIMEOUT. A stalled connection is not a failed one: the fetch neither
//      resolves nor rejects, so the request hangs until the browser gives up
//      minutes later. That is the difference between an image that fails —
//      which shows a broken icon and moves on — and an image that spins.
//
// ⚠ A CORRECTION TO OUR OWN EARLIER DIAGNOSIS, recorded so it does not get
//   repeated: we wrote that `Cache.put()` also rejects on opaque responses, and
//   that removing the `res.ok` guard therefore would not help. That is wrong.
//   `cache.put()` accepts opaque responses; it is `cache.add()`/`addAll()` that
//   reject, because they check `ok`. `put()` rejects only on a 206 or a
//   non-http(s) scheme. So the guard WAS the whole bug on that count. It is
//   still wrapped in a catch below, because quota exhaustion is real and an
//   image that fails to cache must still be shown.
const CACHE = "ctp-core-v2";
const ASSET_HOST = "hkzmydowyiajkbakxfkj.supabase.co";

// A stalled image must not hold a connection open indefinitely. Ten seconds is
// long enough for a slow shed connection and short enough that a person sees a
// broken image rather than a spinner and concludes the app is broken.
const IMAGE_TIMEOUT_MS = 10000;

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

/** fetch() with a deadline. AbortController so the socket is actually released
 *  rather than left dangling with a promise nobody is waiting on. */
function fetchWithTimeout(request, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  // A no-cors request cannot carry a signal through a clone, so the signal is
  // attached to the outgoing fetch rather than to the Request.
  return fetch(request, { signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

/** Storable means: a real response we are allowed to keep.
 *  - `ok` covers same-origin and CORS responses.
 *  - `opaque` is a cross-origin no-cors response. status is 0 and ok is false
 *    BY DESIGN — that is not a failure, it is the browser refusing to let us
 *    read a response we did not ask permission for. It can still be cached and
 *    replayed to an <img>, which is all we need.
 *  - 206 is excluded because Cache.put() rejects on partial content. */
function storable(res) {
  if (!res) return false;
  if (res.status === 206) return false;
  return res.ok || res.type === "opaque";
}

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;

  // Rule 3: hands off data. Only the public storage endpoint is cacheable.
  if (url.hostname === ASSET_HOST && !url.pathname.startsWith("/storage/v1/object/public/")) return;
  if (url.hostname.endsWith("powersync.journeyapps.com")) return;

  // Rule 1: catalogue images — cache-first, and it must NEVER hang or throw.
  if (url.hostname === ASSET_HOST) {
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);

      const hit = await cache.match(e.request);
      if (hit) return hit;

      try {
        const res = await fetchWithTimeout(e.request, IMAGE_TIMEOUT_MS);
        if (storable(res)) {
          // Cache in the background. A quota failure must not stop the image
          // being shown — the cache is an optimisation, the image is the job.
          const copy = res.clone();
          cache.put(e.request, copy).catch(() => {});
        }
        return res;
      } catch {
        // Offline, aborted, or DNS failure. Try the cache once more in case
        // another request populated it while this one was in flight, then give
        // the <img> a definite answer. A 504 renders as a broken image
        // immediately; a rejected promise renders as a spinner that never
        // stops, and looks to the person using it like the whole app has hung.
        const late = await cache.match(e.request);
        if (late) return late;
        return new Response("", {
          status: 504,
          statusText: "image unavailable offline",
        });
      }
    })());
    return;
  }

  // Rule 2: the app shell — network-first, cache fallback.
  if (url.origin === self.location.origin) {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          if (storable(res)) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
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
