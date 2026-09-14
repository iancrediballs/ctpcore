#!/usr/bin/env python3
r"""
WEB — put the catalogue's web-sized part photos in the bucket, at NEW keys.

WHY THIS EXISTS
    The masters under assets/photos/master/ are full frames — a 1600x1067
    photograph in which the part may occupy 60 px. The app scales the frame
    down to a thumbnail and the part vanishes. The web variants are the same
    photographs cropped to their content (8% breathing room, square, white,
    longest side 1200 px, WebP q85): the whole catalogue is 3 MB, a median of
    13 KB per part. They live at

        assets/photos/web/<master basename>.webp

    so the app can derive the web key from the master path it already has,
    with no database change. A missing web key simply falls back to the
    master. Nothing here touches a master, and nothing here overwrites: the
    upload is x-upsert:false, so a key that already exists is REFUSED, not
    replaced (the CDN caches for a year; a changed photo gets a new key).

    2026-09-14: 156 files, built from the Drive masters in Master_Cutouts_White
    and approved by Ian from a contact sheet before this ran.

WHAT IT REFUSES TO DO
    - Upload a file that does not decode as WebP, square, ≤ 1200 px.
    - Upload onto a key that already exists in the bucket.
    - Run without CTP_SERVICE_KEY in the environment. The key stays in the
      operator's shell and never in a file, a chat, or the repo.

VERIFY
    After each upload it fetches the PUBLIC url of the key, unconditionally,
    and checks Content-Type is image/webp and the bytes are identical to what
    was sent. At the end it lists the prefix and prints the count that landed.

USAGE (in your own terminal, with the key in your own shell)
    PowerShell:  $env:CTP_SERVICE_KEY = '<service_role key>'
                 py server\upload_web_variants.py --src C:\Users\Administrator\Desktop\CTP\image-review\web_variants
    Add --dry-run to see the plan and change nothing (no key needed).
"""
import argparse, io, json, os, sys, urllib.error, urllib.parse, urllib.request
from PIL import Image

SUPABASE_URL = "https://hkzmydowyiajkbakxfkj.supabase.co"
BUCKET = "ctp-assets"
PREFIX = "assets/photos/web/"
PUBLIC = f"{SUPABASE_URL}/storage/v1/object/public/{BUCKET}/"


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


def existing(key):
    names, offset = set(), 0
    while True:
        payload = json.dumps({"prefix": PREFIX.rstrip("/"), "limit": 1000, "offset": offset}).encode()
        status, body = api(f"/storage/v1/object/list/{BUCKET}", key, "POST", payload,
                           {"Content-Type": "application/json"})
        if status != 200:
            sys.exit(f"ERROR: could not list {PREFIX}: {status} {body[:200]!r} — is CTP_SERVICE_KEY the service_role key?")
        rows = json.loads(body)
        names |= {r["name"] for r in rows if r.get("name")}
        if len(rows) < 1000:
            return names
        offset += 1000


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True, help="folder of <name>.webp files")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    key = os.environ.get("CTP_SERVICE_KEY", "").strip()
    if not a.dry_run and not key:
        print("ERROR: CTP_SERVICE_KEY is not set. Set it in THIS shell and re-run:\n"
              "  PowerShell:  $env:CTP_SERVICE_KEY = '<service_role key>'", file=sys.stderr)
        sys.exit(2)

    files = sorted(f for f in os.listdir(a.src) if f.lower().endswith(".webp"))
    if not files:
        sys.exit(f"ERROR: no .webp files in {a.src}")
    have = set() if a.dry_run else existing(key)

    print(f"{'key':56} {'KB':>6}  status")
    ok = fail = 0
    for name in files:
        rel = PREFIX + name
        with open(os.path.join(a.src, name), "rb") as f:
            body = f.read()
        try:
            with Image.open(io.BytesIO(body)) as im:
                im.load(); fmt, sz = im.format, im.size
        except Exception as e:
            fmt, sz = f"unreadable ({e})", (0, 0)
        if fmt != "WEBP" or sz[0] != sz[1] or sz[0] > 1200:
            print(f"{rel:56} {'':>6}  REFUSED: {fmt} {sz}"); fail += 1; continue
        if name in have:
            print(f"{rel:56} {'':>6}  REFUSED: key already exists (no overwrites)"); fail += 1; continue
        if a.dry_run:
            print(f"{rel:56} {len(body)/1024:6.0f}  would upload {sz[0]}px"); ok += 1; continue

        status, resp = api(f"/storage/v1/object/{BUCKET}/{urllib.parse.quote(rel)}", key, "POST", body,
                           {"Content-Type": "image/webp", "x-upsert": "false",
                            "Cache-Control": "public, max-age=31536000, immutable"})
        if status not in (200, 201):
            print(f"{rel:56} {'':>6}  FAILED {status}: {resp[:120].decode('utf-8','replace')}"); fail += 1; continue

        try:
            r = urllib.request.urlopen(PUBLIC + rel, timeout=120)
            ct = r.headers.get("Content-Type", "?"); got = r.read()
            if ct.startswith("image/webp") and got == body:
                print(f"{rel:56} {len(got)/1024:6.0f}  OK  {ct}"); ok += 1
            else:
                print(f"{rel:56} {'':>6}  UPLOADED BUT READ-BACK WRONG: ct={ct} bytes={len(got)} vs {len(body)}"); fail += 1
        except Exception as e:
            print(f"{rel:56} {'':>6}  UPLOADED BUT READ-BACK FAILED: {e}"); fail += 1

    if not a.dry_run:
        landed = existing(key)
        print(f"\nbucket now holds {len(landed)} objects under {PREFIX}")
    print(f"{ok} ok, {fail} failed, {len(files)} files in {a.src}")
    sys.exit(1 if fail else 0)


if __name__ == "__main__":
    main()
