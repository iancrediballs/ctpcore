#!/usr/bin/env python3
"""
Push the catalogue's images to the Supabase Storage bucket `ctp-assets`.

WHY
    The database stores relative paths like "assets/photos/raw_1001.jpg", which
    resolve against app/public/ on the desktop. A hosted PWA has no public/ —
    that folder is not in the deployed bundle — so every image 404s until the
    files live somewhere a browser can reach. This puts them there, under the
    SAME relative keys, so not one database row changes.

WHAT IT UPLOADS
    Only what the database actually references. It asks Postgres for every live
    part_image.path, diagram.image_path and part_model.glb_path, then looks for
    each under app/public/assets. Unreferenced files on disk are ignored, and
    anything referenced but missing is reported rather than silently skipped.

    3D models are skipped by default (--include-models to override). The one
    .glb in the catalogue is 37MB; see supportsModels in app/src/assets.ts.

    Big images are downscaled to --max-width and re-encoded before upload. The
    format is NEVER changed — a .png stays a .png — so the key in Storage always
    matches the path in the database. The section diagrams are the reason: they
    ship at up to 3MB each, which is a poor thing to hand a phone on mobile data.

USAGE
    set CTP_SERVICE_KEY=<service_role key from Supabase -> Settings -> API Keys>
    python server/sync_assets.py                 # upload what is missing
    python server/sync_assets.py --dry-run       # show the plan, change nothing
    python server/sync_assets.py --force         # re-upload everything
    python server/sync_assets.py --include-models

    The service_role key bypasses RLS. Keep it in the environment, never in a
    file, and never in the repo. This script is the only thing that needs it —
    the app itself ships the publishable key.

Requires: Pillow (already installed for catalogue_gen.py). Everything else is
standard library, so there is nothing to install.
"""
import argparse
import io
import json
import mimetypes
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

SUPABASE_URL = "https://hkzmydowyiajkbakxfkj.supabase.co"
BUCKET = "ctp-assets"

HERE = os.path.dirname(os.path.abspath(__file__))
ASSET_ROOT = os.path.normpath(os.path.join(HERE, "..", "app", "public"))

EXT_MIME = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
    ".glb": "model/gltf-binary",
}


def die(msg, code=1):
    print(f"\nERROR: {msg}", file=sys.stderr)
    sys.exit(code)


def api(path, key, method="GET", data=None, headers=None):
    req = urllib.request.Request(
        f"{SUPABASE_URL}{path}", method=method, data=data,
        headers={"apikey": key, "Authorization": f"Bearer {key}", **(headers or {})},
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def referenced_paths(key):
    """Every asset path the live database points at, deduped."""
    queries = [
        ("/rest/v1/part_image?select=path&deleted_at=is.null", "path"),
        ("/rest/v1/diagram?select=image_path&deleted_at=is.null&image_path=not.is.null", "image_path"),
        ("/rest/v1/part_model?select=glb_path&deleted_at=is.null&glb_path=not.is.null", "glb_path"),
    ]
    out = set()
    for q, col in queries:
        status, body = api(q, key, headers={"Accept": "application/json"})
        if status != 200:
            die(f"reading {col} failed ({status}): {body[:400].decode('utf-8', 'replace')}\n"
                f"       Is CTP_SERVICE_KEY the service_role key?")
        for row in json.loads(body):
            v = row.get(col)
            # Absolute URLs (some diagrams point at rusauto) are not ours to host.
            if v and not v.lower().startswith(("http://", "https://")):
                out.add(v.lstrip("/"))
    return sorted(out)


def existing_keys(key):
    """What is already in the bucket, so a re-run is cheap."""
    found, prefixes = {}, [""]
    while prefixes:
        prefix = prefixes.pop()
        offset = 0
        while True:
            payload = json.dumps({
                "prefix": prefix, "limit": 1000, "offset": offset,
                "sortBy": {"column": "name", "order": "asc"},
            }).encode()
            status, body = api(f"/storage/v1/object/list/{BUCKET}", key, "POST", payload,
                               {"Content-Type": "application/json"})
            if status != 200:
                return found  # bucket empty or unreadable; treat as "upload everything"
            rows = json.loads(body)
            if not rows:
                break
            for r in rows:
                name = f"{prefix}{r['name']}"
                if r.get("id") is None:          # a folder
                    prefixes.append(f"{name}/")
                else:
                    found[name] = (r.get("metadata") or {}).get("size")
            if len(rows) < 1000:
                break
            offset += len(rows)
    return found


def prepare(abspath, max_width):
    """Bytes to upload. Downscales oversized images; never changes format."""
    ext = os.path.splitext(abspath)[1].lower()
    raw = open(abspath, "rb").read()
    if ext not in (".png", ".jpg", ".jpeg") or max_width <= 0:
        return raw, False
    try:
        from PIL import Image
    except ImportError:
        die("Pillow is needed to downscale images.\n"
            "       pip install pillow      (or run with --max-width 0 to upload as-is)")
    try:
        im = Image.open(io.BytesIO(raw))
        if im.width <= max_width:
            return raw, False
        im = im.resize((max_width, round(im.height * max_width / im.width)), Image.LANCZOS)
        buf = io.BytesIO()
        if ext == ".png":
            if im.mode in ("P", "LA"):
                im = im.convert("RGBA")
            im.save(buf, "PNG", optimize=True)
        else:
            if im.mode not in ("RGB", "L"):
                im = im.convert("RGB")
            im.save(buf, "JPEG", quality=85, optimize=True, progressive=True)
        out = buf.getvalue()
        # Only keep the resize if it actually helped.
        return (out, True) if len(out) < len(raw) else (raw, False)
    except Exception as e:                                   # noqa: BLE001
        print(f"    (could not downscale, uploading original: {e})")
        return raw, False


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true", help="show the plan, upload nothing")
    ap.add_argument("--force", action="store_true", help="re-upload even if already present")
    ap.add_argument("--include-models", action="store_true", help="also upload .glb files")
    ap.add_argument("--max-width", type=int, default=1600,
                    help="downscale wider images before upload (0 = never)")
    args = ap.parse_args()

    key = os.environ.get("CTP_SERVICE_KEY", "").strip()
    if not key:
        die("CTP_SERVICE_KEY is not set.\n"
            "       Supabase dashboard -> Project Settings -> API Keys -> service_role.\n"
            "         PowerShell:  $env:CTP_SERVICE_KEY = '<key>'\n"
            "         cmd:         set CTP_SERVICE_KEY=<key>")
    if not os.path.isdir(os.path.join(ASSET_ROOT, "assets")):
        die(f"no assets folder under {ASSET_ROOT}")

    print(f"bucket      {BUCKET}  ({SUPABASE_URL})")
    print(f"local root  {ASSET_ROOT}")

    paths = referenced_paths(key)
    if not args.include_models:
        models = [p for p in paths if p.lower().endswith(".glb")]
        paths = [p for p in paths if not p.lower().endswith(".glb")]
        if models:
            print(f"skipping    {len(models)} 3D model(s) — desktop only (--include-models to send)")
    print(f"referenced  {len(paths)} file(s) in the database")

    have = {} if args.force else existing_keys(key)
    if have:
        print(f"in bucket   {len(have)} object(s) already")

    missing, uploaded, skipped, failed, shrunk = [], 0, 0, [], 0
    sent_bytes = 0

    for rel in paths:
        abspath = os.path.join(ASSET_ROOT, rel.replace("/", os.sep))
        if not os.path.isfile(abspath):
            missing.append(rel)
            continue
        if rel in have and not args.force:
            skipped += 1
            continue

        body, was_shrunk = prepare(abspath, args.max_width)
        shrunk += 1 if was_shrunk else 0
        note = "  (downscaled)" if was_shrunk else ""
        size_kb = len(body) / 1024

        if args.dry_run:
            print(f"  would upload  {rel}  {size_kb:.0f}KB{note}")
            uploaded += 1
            sent_bytes += len(body)
            continue

        mime = EXT_MIME.get(os.path.splitext(rel)[1].lower()) \
            or mimetypes.guess_type(rel)[0] or "application/octet-stream"
        quoted = urllib.parse.quote(rel)
        status, resp = api(f"/storage/v1/object/{BUCKET}/{quoted}", key, "POST", body,
                           {"Content-Type": mime, "x-upsert": "true",
                            "Cache-Control": "public, max-age=31536000, immutable"})
        if status in (200, 201):
            uploaded += 1
            sent_bytes += len(body)
            print(f"  uploaded  {rel}  {size_kb:.0f}KB{note}")
        else:
            failed.append((rel, status, resp[:200].decode("utf-8", "replace")))
            print(f"  FAILED    {rel}  ({status})")

    print("\n" + "-" * 62)
    verb = "would upload" if args.dry_run else "uploaded"
    print(f"{verb:>14}  {uploaded}   ({sent_bytes / 1048576:.1f} MB, {shrunk} downscaled)")
    print(f"{'already there':>14}  {skipped}")
    print(f"{'missing on disk':>14}  {len(missing)}")
    print(f"{'failed':>14}  {len(failed)}")

    if missing:
        print("\nReferenced by the database but NOT on disk — these will be broken "
              "images on every surface, not just mobile:")
        for m in missing[:40]:
            print(f"  {m}")
        if len(missing) > 40:
            print(f"  ... and {len(missing) - 40} more")

    if failed:
        print("\nFailures:")
        for rel, status, msg in failed[:20]:
            print(f"  {rel}  [{status}]  {msg}")

    if not args.dry_run and not failed and not missing:
        print(f"\nAll referenced assets are live. Spot-check one in a browser:")
        if paths:
            print(f"  {SUPABASE_URL}/storage/v1/object/public/{BUCKET}/{paths[0]}")

    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
