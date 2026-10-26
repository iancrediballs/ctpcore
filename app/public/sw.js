// CTP Core — service worker. Hand-rolled on purpose: three caching rules and
// zero build-time dependencies.
//
//   1. Catalogue images (the Supabase Storage bucket) — cache-first, forever.
//      The bucket is served with `immutable, max-age=1y` and a changed image
//      goes up under a NEW key (e.g. sections/<CODE>_v3.webp), so a cached
//      image is never stale. They live in their OWN cache, IMG_CACHE, which a
//      shell release (CACHE bump) does not drop. Bump IMG_CACHE only if an
//      image key is ever reused.
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
const CACHE = "ctp-core-v47";   // v47: QA regression — completed-order VAT from the Zoho invoice; discounts struck only when real; customer sees Cancelled vs Declined; note spacing. v46: QA sweep — diagrams + markers offline, opens offline with an expired login, sync badge (syncing / N to send), friendly offline errors, first-visit precache, stock moves record who. v45: QA sweep — search (all words, OEM without dashes, aliases), fitment + cross-refs on the part sheet, "no list price", bigger diagram tap targets, category chips after sync. v44: QA sweep — warehouse sees no cost; staff-access confirms; cancel voids the Zoho SO; honest fulfil pills; Zoho discounts on cards; JHB times. v43: QA sweep — lighter Home/section pictures (WebP), logos, diagram thumbnails, images in their own cache (ctp-img-v1), security headers. v42: Fulfil needs a SENT Zoho invoice for account customers too; draft says "ask Michelle to mark it sent" (0078). v41: customer rebate on Zoho quotes (struck list per line, "you save" on the incl-VAT total). v40: section drawings visible on phones again (hint no longer squeezes the drawing to 0 px); image-orientation from EXIF. v39: rebate on order cards (saving vs list, above-rebate warning; customer total struck through) (0077 UI). v38: rebate prices on cards, part sheet, cart and order lines; lines default to the rebate (0076). v37: catalogue fields + Find filters (Make/Model/Type, Supplier for staff) (0074); server-side hiding (0073); salesperson on Zoho SOs (2026-10-24)
// v33:   // v33: app version shown (Info, Settings) + "new version ready — Reload"; SO status mapped on the order desk; Send quote always creates the estimate; one-tap Refresh (2026-10-24)
// v32:   // v32: CTP-mode Fulfil also creates the Zoho package + shipment (mirror) so Inventory physical stock follows (2026-10-24)
// v31:   // v31: e2e fixes — staff-only history (privacy, 0067), SO status labels, Fill from list only fills, Send quote creates the estimate, close toast, accept-on-behalf modal, lane headers, word wrap (2026-10-23)
// v30:   // v30: Zoho Inventory is the item master — Multicat wording removed; new Zoho items become CTP parts on Pull & apply (0066) (2026-10-23)
// v29:   // v29: Phase 3 on Zoho Inventory behind the rehearsal switch — Zoho stock on parts, Ship in Zoho, count → Zoho adjustment, Receive goods (0065) (2026-10-23)
// v28:   // v28: Phase 2 close-out — admin "Create new estimate" (deleted/voided in Zoho), estimate status on cancelled/completed cards (0064) (2026-10-23)
// v27:   // v27: dark-mode fix — order card names/amounts were black (buttons do not inherit color); AA contrast tokens in both themes (2026-10-23)
// v26:   // v26: quotes as Zoho estimates, Zoho leads — lines locked to the estimate, accept only after accounts send it, Zoho figures for the customer, Settings toggle (0063) (2026-10-23)
// v25:   // v25: Phase 2 groundwork — quote card shows its Zoho estimate; Send quote asks for the draft estimate (server skips until 0062 switch is on) (2026-10-23)
// v24:   // v24: header basket with a live quantity badge (persists on the device); order desk search + filters (2026-10-23)
// v22: fulfil waits for accounts (Zoho SO sent), Michelle's SO edits read back, account terms (0059) (2026-10-22)
// v21: admin "Accept on customer's behalf" on the order desk (0058) (2026-10-22)
// v20: add customer (Zoho companies & people), print copy carries Zoho invoice no. (2026-10-21)
// Images get their own cache so a deploy (CACHE bump) does not empty the
// offline image store. Until 2026-10-26 they shared CACHE, so every release
// threw away every cached photo, drawing and section tile (perf PERF-8).
const IMG_CACHE = "ctp-img-v1";
const ASSET_HOST = "hkzmydowyiajkbakxfkj.supabase.co";

// ── TIMEOUTS, and the mistake the first version of this file made with them.
//
// v2 set the image deadline to TEN SECONDS and the shell deadline to TWO,
// calibrated from a browser in a datacentre where a photo took 1-2 s. On the
// connection this app is actually used from, in KwaZulu-Natal, the same fetch
// measured 3.6-5.7 s for a SINGLE image with nothing else loading. A diagram
// page loads a dozen at once and they share the line. So every image hit the
// deadline, the catch returned the 504 fallback, and the fix that was meant to
// stop images hanging made every image fail instead. The 2 s shell deadline did
// the same to a 10 KB icon.
//
// THE PURPOSE OF A TIMEOUT HERE IS TO STOP AN INDEFINITE HANG. It is not a
// performance budget imposed on a customer's connection. A slow image that
// eventually appears is enormously better than a fast failure. Sixty seconds
// stops a hang; it does not stop a slow line from finishing.
const IMAGE_TIMEOUT_MS = 60000;

// The shell only gets a SHORT deadline when there is a cached copy to fall
// back to — that is the whole point of racing the network, and without a
// cached copy a short deadline turns "slow" into "broken" for no gain. See
// Rule 2b. With nothing cached the deadline is the long one.
const SHELL_TIMEOUT_MS = 3000;
const SHELL_TIMEOUT_UNCACHED_MS = 60000;

// INSTALL PRECACHES THE WHOLE SHELL (SO-6). It used to cache only "/". The
// page that registers the worker has already loaded its scripts before the
// worker controls it, so they never passed through the fetch handler, and a
// first-time visitor who reloaded offline got "/" from the cache and a blank
// page (index-*.js, the AuthedApp chunk and the CSS were missing). Now the
// build's own list (precache.json, written by vite.config.ts) plus whatever
// "/" references is fetched here. "/" is required; the rest is best effort, so
// one failed file cannot stop the worker installing.
async function precacheShell() {
  const cache = await caches.open(CACHE);
  const shell = await fetch("/", { cache: "no-cache" });
  if (!shell.ok) throw new Error("shell fetch failed: " + shell.status);
  const html = await shell.clone().text();
  await cache.put("/", shell);
  const urls = new Set();
  for (const m of html.matchAll(/(?:src|href)="(\/[^"]+)"/g)) urls.add(m[1]);
  try {
    const r = await fetch("/precache.json", { cache: "no-cache" });
    if (r.ok) for (const f of (await r.json()).files ?? []) urls.add(f);
  } catch { /* an older build without the manifest: the html's own files only */ }
  await Promise.allSettled([...urls].map(async (u) => {
    if (await cache.match(u)) return;
    const res = await fetch(u);
    if (storable(res)) await cache.put(u, res);
  }));
}

self.addEventListener("install", (e) => {
  e.waitUntil(precacheShell());
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE && k !== IMG_CACHE).map((k) => caches.delete(k)))
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
      const cache = await caches.open(IMG_CACHE);

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

  // Rule 2a: HASHED BUILD ASSETS — cache-first, because they are immutable.
  //
  // Vite names every build output by a hash of its contents: index-B1vJNIsq.js
  // becomes index-<something else>.js the moment one byte changes. So a cached
  // /assets/ file can NEVER be stale — a new deploy asks for a different
  // filename. Going to the network for these is pure cost.
  //
  // And it was a large cost. Measured on the live site, through this same
  // worker, on files that were ALREADY in the cache:
  //
  //     cache-first  (Rule 1, images)      2-14 ms
  //     network-first (the old Rule 2)     690-819 ms, on EVERY load
  //
  // That was most of the ~3.5 seconds the app took to reach its login screen.
  // It was never PowerSync's WASM — that does not load until after sign-in,
  // which the running app confirmed and the source code had suggested
  // otherwise.
  if (url.origin === self.location.origin && url.pathname.startsWith("/assets/")) {
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      // ignoreVary: the copy precached at install was fetched by the worker
      // (no Origin header) while the page asks with `crossorigin` (Origin
      // set). A server that sends `Vary: Origin` would make them never match,
      // and immutable files cannot differ by Origin anyway.
      const hit = await cache.match(e.request, { ignoreVary: true });
      if (hit) return hit;
      try {
        const res = await fetch(e.request);
        if (storable(res)) {
          const copy = res.clone();
          cache.put(e.request, copy).catch(() => {});
        }
        return res;
      } catch {
        return (await cache.match(e.request, { ignoreVary: true })) ?? Response.error();
      }
    })());
    return;
  }

  // Rule 2b: everything else same-origin — the HTML document, the manifest,
  // the icons, the brand images. Network-first WITH A DEADLINE, cache fallback.
  //
  // Network-first is right here and only here: "/" is not content-hashed, so
  // this is what picks up a new deploy. But it must not be able to stall the
  // launch — a slow connection should cost a moment, not the whole start-up —
  // so a response that has not arrived within SHELL_TIMEOUT_MS falls back to
  // the cached copy.
  if (url.origin === self.location.origin) {
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      // Only race the network against a deadline when losing that race has
      // somewhere to land. First visit, nothing cached: wait for the network,
      // however long the line takes.
      const cached = await cache.match(e.request);
      const deadline = cached ? SHELL_TIMEOUT_MS : SHELL_TIMEOUT_UNCACHED_MS;
      try {
        const res = await fetchWithTimeout(e.request, deadline);
        if (storable(res)) {
          const copy = res.clone();
          cache.put(e.request, copy).catch(() => {});
        }
        return res;
      } catch {
        const hit = cached ?? (await cache.match(e.request));
        // An offline navigation falls back to the cached shell.
        return hit ?? (e.request.mode === "navigate"
          ? (await cache.match("/")) ?? Response.error()
          : Response.error());
      }
    })());
  }
});
