#!/usr/bin/env python3
r"""
WEB — upload re-encoded WebP images to the bucket AT THEIR EXISTING KEYS.

WHY THIS EXISTS
    The catalogue photos are photographs of parts on white, stored as PNG — a
    format for line art. The largest is 1.8 MB for 1400x1400 pixels. The same
    pixels as WebP q82 are 30-50 KB, visually indistinguishable at 1:1. On the
    connection this app is used from, that is the difference between a part
    photo arriving in under a second and not arriving at all.

    Same object key, same URL, correct Content-Type. No database row changes,
    no path changes, no code changes. A browser renders <img> by content, not
    by the extension in the URL.

WHAT IT REFUSES TO DO
    - Upload anything for which the ORIGINAL has not first been downloaded to
      --originals and verified to open. The originals folder is the undo.
    - Upload anything that does not decode as WebP at the same pixel size as
      its original.
    - Run without CTP_SERVICE_KEY in the environment. The key stays in the
      operator's shell and never in a file, a chat, or the repo.

VERIFY
    After each upload it fetches the PUBLIC url of that key, unconditionally,
    and checks the Content-Type header is image/webp and the bytes decode as
    WebP. An upload that cannot be read back the way a browser will read it is
    reported as a failure, not a success.

USAGE (in your own terminal, with the key in your own shell)
    PowerShell:  $env:CTP_SERVICE_KEY = '<service_role key>'
                 python server/upload_webp_batch.py --manifest D:\ctpbuild\image_webp\manifest_eight.json
    Add --dry-run to see the plan and change nothing.
"""
import argparse, hashlib, io, json, os, sys, urllib.error, urllib.parse, urllib.request
from PIL import Image

SUPABASE_URL = "https://hkzmydowyiajkbakxfkj.supabase.co"
BUCKET = "ctp-assets"
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", required=True, help="manifest json written by the staging step")
    ap.add_argument("--originals", default=r"D:\ctpbuild\image_originals")
    ap.add_argument("--staged", default=r"D:\ctpbuild\image_webp")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    key = os.environ.get("CTP_SERVICE_KEY", "").strip()
    if not a.dry_run and not key:
        print("ERROR: CTP_SERVICE_KEY is not set. Set it in THIS shell and re-run:\n"
              "  PowerShell:  $env:CTP_SERVICE_KEY = '<service_role key>'", file=sys.stderr)
        sys.exit(2)

    with open(a.manifest) as f:
        items = json.load(f)

    print(f"{'part':7} {'key':44} {'orig KB':>8} {'webp KB':>8}  status")
    ok = fail = 0
    for it in items:
        rel = it["key"]
        orig = os.path.join(a.originals, rel.replace("/", os.sep))
        staged = os.path.join(a.staged, rel.replace("/", os.sep))

        # ── refuse without a verified original ───────────────────────────────
        if not os.path.exists(orig):
            print(f"{str(it.get('part', it.get('kind','?'))):<7} {rel:44} {'':>8} {'':>8}  REFUSED: no original backed up"); fail += 1; continue
        with open(orig, "rb") as f:
            if hashlib.sha256(f.read()).hexdigest() != it["orig_sha256"]:
                print(f"{str(it.get('part', it.get('kind','?'))):<7} {rel:44} {'':>8} {'':>8}  REFUSED: original hash mismatch"); fail += 1; continue
        with Image.open(orig) as im:
            im.load(); osz = im.size

        # ── refuse a staged file that is not what it claims ─────────────────
        with open(staged, "rb") as f:
            body = f.read()
        with Image.open(io.BytesIO(body)) as im:
            im.load()
            if im.format != "WEBP" or im.size != osz:
                print(f"{str(it.get('part', it.get('kind','?'))):<7} {rel:44} {'':>8} {'':>8}  REFUSED: staged is {im.format} {im.size}, original {osz}"); fail += 1; continue

        if a.dry_run:
            print(f"{str(it.get('part', it.get('kind','?'))):<7} {rel:44} {it['orig_bytes']/1024:8.0f} {len(body)/1024:8.0f}  would upload"); ok += 1; continue

        # ── upload, same key, correct type, immutable cache header ───────────
        status, resp = api(f"/storage/v1/object/{BUCKET}/{urllib.parse.quote(rel)}", key, "POST", body,
                           {"Content-Type": "image/webp", "x-upsert": "true",
                            "Cache-Control": "public, max-age=31536000, immutable"})
        if status not in (200, 201):
            print(f"{str(it.get('part', it.get('kind','?'))):<7} {rel:44} {'':>8} {'':>8}  FAILED {status}: {resp[:120].decode('utf-8','replace')}"); fail += 1; continue

        # ── verify the way a browser will see it: public url, no auth ───────
        try:
            r = urllib.request.urlopen(PUBLIC + rel, timeout=120)
            ct = r.headers.get("Content-Type", "?"); got = r.read()
            with Image.open(io.BytesIO(got)) as im:
                im.load(); fmt, sz = im.format, im.size
            if ct.startswith("image/webp") and fmt == "WEBP" and sz == osz and len(got) == len(body):
                print(f"{str(it.get('part', it.get('kind','?'))):<7} {rel:44} {it['orig_bytes']/1024:8.0f} {len(got)/1024:8.0f}  OK  {ct}"); ok += 1
            else:
                print(f"{str(it.get('part', it.get('kind','?'))):<7} {rel:44} {'':>8} {'':>8}  UPLOADED BUT READ-BACK WRONG: ct={ct} fmt={fmt} size={sz} bytes={len(got)}"); fail += 1
        except Exception as e:
            print(f"{str(it.get('part', it.get('kind','?'))):<7} {rel:44} {'':>8} {'':>8}  UPLOADED BUT READ-BACK FAILED: {e}"); fail += 1

    print(f"\n{ok} ok, {fail} failed.  Originals (the undo) are in {a.originals}")
    sys.exit(1 if fail else 0)


if __name__ == "__main__":
    main()
