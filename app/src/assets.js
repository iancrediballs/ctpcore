// CTP Core — where an asset actually lives, per surface.
//
// The database stores relative paths like "assets/photos/raw_1001.jpg". On the
// desktop those resolve against app/public/, which Vite serves at the web root,
// so "/" + path is all it ever needed. A hosted PWA has no public/ — that 215MB
// folder is not in the deployed bundle — so every one of those paths 404s.
//
// This is the one place that knows the difference. Same rule as the data seam
// in data/api.ts: if we are inside Tauri, use the local bundle; otherwise go to
// the Supabase Storage CDN.
//
// The bucket mirrors app/public/assets EXACTLY — same relative keys, so no
// database row changes and nothing to keep in sync but the files themselves.
// Upload with:  python server/sync_assets.py
//
// Bucket `ctp-assets` is PUBLIC (read-only to the world; writes are
// service_role only). That is deliberate:
//   * a signed URL expires, which breaks service-worker offline caching — the
//     whole point of the PWA;
//   * these are catalogue photos and exploded views, the same images that go
//     out in CTP_Parts_Catalogue.html. No price, cost, locator or OEM number is
//     visible in a picture.
// If that ever stops being true — a diagram with cost annotations, say — do NOT
// switch this to signed URLs without solving the offline story first.
import { isTauri } from "./data/api";
import { SUPABASE_URL } from "./sync/config";
/** Public read endpoint for the asset bucket. */
export const ASSET_BASE = `${SUPABASE_URL}/storage/v1/object/public/ctp-assets`;
/**
 * Resolve a stored asset path for the current surface.
 *
 * Returns "" for null/empty so it can be dropped straight into an <img src>
 * without a guard — matching the helper it replaces. Absolute http(s) URLs are
 * passed through untouched: some diagram rows point at rusauto rather than a
 * local file, and those must not be rewritten.
 */
export function assetUrl(path) {
    if (!path)
        return "";
    if (/^(https?:|data:|blob:)/i.test(path))
        return path;
    const rel = path.replace(/^\/+/, "");
    return isTauri ? `/${rel}` : `${ASSET_BASE}/${rel}`;
}
/**
 * Should this surface load a 3D model at all?
 *
 * The one .glb in the catalogue is 37MB and the showroom truck is another. On a
 * phone that is a minute of someone's data to render a spinning object nobody
 * asked for, so models are desktop-only and sync_assets.py does not upload them
 * by default. Gate any model UI on this rather than hiding it in CSS.
 */
export const supportsModels = isTauri;
