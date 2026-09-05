// Pull every object in the Supabase `ctp-assets` bucket down into app/public/assets/.
//
// The bucket is the system of record for catalogue images; this is the missing
// counterpart to server/sync_assets.py, which only ever pushed the other way. After
// moving the project to a new machine, this is what puts the pictures back.
//
//   node tools/pull_assets.mjs            # fetch anything missing or truncated
//   node tools/pull_assets.mjs --force    # re-fetch everything
//
// Reads tools/manifest.txt for the object list, because the bucket's list API is
// restricted to staff logins while the objects themselves are publicly readable.
// Supabase credentials come out of app/src/sync/config.ts, so there is nothing to
// configure and no key to paste anywhere.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const DEST = path.join(ROOT, "app", "public", "assets");
const BUCKET = "ctp-assets";
const FORCE = process.argv.includes("--force");
const CONCURRENCY = 8;

const cfg = fs.readFileSync(path.join(ROOT, "app", "src", "sync", "config.ts"), "utf8");
const SUPABASE_URL = (cfg.match(/SUPABASE_URL\s*=\s*"([^"]+)"/) || [])[1];
if (!SUPABASE_URL) throw new Error("could not read SUPABASE_URL from app/src/sync/config.ts");

const keys = fs
  .readFileSync(path.join(HERE, "manifest.txt"), "utf8")
  .split("\n")
  .map((l) => l.trim())
  .filter(Boolean);

const human = (b) =>
  b >= 1 << 20 ? `${(b / (1 << 20)).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} kB`;

console.log(`${keys.length} objects listed in the manifest.`);

let done = 0, skipped = 0, failed = 0, bytes = 0;
const failures = [];

async function fetchOne(key) {
  // Objects live under assets/<kind>/<file>; app/public/assets IS that root locally,
  // so strip the leading segment rather than nesting a second "assets" folder.
  const dest = path.join(DEST, key.replace(/^assets\//, ""));

  if (!FORCE && fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    skipped++;
    return;
  }

  const url = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${key
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;

  // Three attempts with backoff — the link to eu-central-1 drops often enough that a
  // single transient failure should not cost a picture.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) throw new Error("empty body");
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      // Write to a temp name and rename, so an interrupted run never leaves a
      // half-written file that the next run would mistake for complete.
      const tmp = `${dest}.part`;
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, dest);
      done++;
      bytes += buf.length;
      if (done % 40 === 0) console.log(`  …${done} downloaded (${human(bytes)})`);
      return;
    } catch (e) {
      if (attempt === 3) {
        failed++;
        failures.push(`${key}: ${e.message}`);
      } else {
        await new Promise((r) => setTimeout(r, 400 * attempt));
      }
    }
  }
}

// A small fixed pool rather than 421 parallel requests, which the CDN throttles.
const queue = [...keys];
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    for (;;) {
      const key = queue.shift();
      if (!key) return;
      await fetchOne(key);
    }
  })
);

console.log(
  `\nDownloaded ${done} (${human(bytes)}) · already present ${skipped} · failed ${failed}`
);
if (failures.length) {
  console.log("\nFailures:");
  for (const f of failures.slice(0, 20)) console.log("  " + f);
}
process.exit(failed ? 1 : 0);
