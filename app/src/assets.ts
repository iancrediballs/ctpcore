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
export function assetUrl(path: string | null | undefined): string {
  if (!path) return "";
  if (/^(https?:|data:|blob:)/i.test(path)) return path;
  const rel = path.replace(/^\/+/, "");
  return isTauri ? `/${rel}` : `${ASSET_BASE}/${rel}`;
}

/**
 * The web-sized variant of a catalogue photo, or "" when there is none to try.
 *
 * Masters under assets/photos/ are full camera frames — 1600x1067 in which the
 * part may be 60 px wide — and scaling a frame down to a thumbnail makes the
 * part vanish. The web variants (server/upload_web_variants.py, 2026-09-14)
 * are the same photographs cropped to their content: square, white, at most
 * 1200 px, ~13 KB. They live at assets/photos/web/<master basename>.webp, so
 * the key is derived from the master path the row already carries and no
 * database column is involved. Callers try this first and fall back to
 * assetUrl(path) on error — a master with no variant yet still renders.
 *
 * Diagrams, brand art and anything outside assets/photos/ have no variant.
 * The desktop bundle has none either (public/ is masters only).
 */
export function photoWebUrl(path: string | null | undefined): string {
  if (!path || isTauri) return "";
  if (/^(https?:|data:|blob:)/i.test(path)) return "";
  const rel = path.replace(/^\/+/, "");
  if (!rel.startsWith("assets/photos/") || rel.startsWith("assets/photos/web/")) return "";
  const base = rel.slice(rel.lastIndexOf("/") + 1).replace(/\.[^.]*$/, "");
  return base ? `${ASSET_BASE}/assets/photos/web/${base}.webp` : "";
}
