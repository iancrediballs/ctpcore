#!/usr/bin/env python3
"""CTP Core — add a new make / model / brand from a folder of sheets (docs/13_ADD_A_NEW_MAKE.md).

    python tools/onboard/onboard.py validate  <sheets>                      check the sheets, touch nothing
    python tools/onboard/onboard.py import    <sheets> --batch B            DRY RUN: what CTP would get
    python tools/onboard/onboard.py import    <sheets> --batch B --apply    upload pictures, import into CTP
    python tools/onboard/onboard.py zoho      --batch B [--apply]           create / link the Zoho items
    python tools/onboard/onboard.py images    --batch B [--apply]           part photos onto the Zoho items
    python tools/onboard/onboard.py pricebook --batch B                     price-book preview (never applies)
    python tools/onboard/onboard.py verify    --batch B                     CTP + Zoho, item by item
    python tools/onboard/onboard.py status    --batch B                     what the batch did so far
    python tools/onboard/onboard.py rollback  --batch B [--apply] [--purge] undo: Zoho deactivate, CTP restore

<sheets> is a folder of CSV files (docs/templates/*.csv) or one .xlsx with a tab per sheet.
Every step is idempotent (run it again: nothing doubles) and every step without --apply only reports.
Rules it enforces: Zoho items are never deleted (rollback deactivates them); an existing Zoho item's
price is never changed (it is only linked); an existing part of ANOTHER make is never overwritten.

Needs: Python 3.10+, Pillow, openpyxl (for .xlsx), and the Supabase CLI logged in (npx supabase login)
— the tool fetches the service key itself; or set CTP_SERVICE_KEY.
"""
from __future__ import annotations

import argparse, csv, hashlib, io, json, os, re, subprocess, sys, time, urllib.error, urllib.request
from pathlib import Path

PROJECT = "hkzmydowyiajkbakxfkj"
URL = f"https://{PROJECT}.supabase.co"
BUCKET = "ctp-assets"
REPO = Path(__file__).resolve().parents[2]

SHEETS = {   # sheet -> (required columns, optional columns)
    "profile":        (["code", "make"], ["model", "display_name", "parts_brand_code", "parts_brand_name", "parts_brand_is_oem",
                       "zoho_manufacturer", "zoho_brand", "zoho_sales_account_id", "zoho_purchase_account_id",
                       "zoho_inventory_account_id", "unit", "default_part_type", "rebate_scheme", "pn_pattern", "lookup_url",
                       "description_template", "is_test", "notes"]),
    "vehicles":       (["model"], ["make", "variant", "year_from", "year_to", "engine", "notes"]),
    "sections":       (["code", "name"], []),
    "suppliers":      (["code", "name"], ["contact", "phone", "email", "currency", "lead_time_days", "vat_no", "notes"]),
    "parts":          (["sku", "name", "section_code"], ["part_type", "universal", "make", "model", "catalogue_pn", "mpn", "side",
                       "drawing_no", "diagram_item_no", "description", "uom", "weight_g", "list_price_zar", "supplier", "notes"]),
    "fitment":        (["sku", "model"], ["make", "variant", "year_from", "year_to", "engine", "note"]),
    "xrefs":          (["sku", "xref_number"], ["xref_brand", "xref_type", "confidence"]),
    "part_suppliers": (["sku", "supplier_code"], ["supplier_sku", "cost_zar", "currency", "lead_time_days", "moq", "preferred"]),
    "diagrams":       (["drawing_key", "section_code", "title", "image_file"], ["img_w", "img_h"]),
    "hotspots":       (["drawing_key", "item_no", "sku", "x", "y"], ["radius"]),
    "images":         (["sku", "image_file"], ["is_primary", "sort_order", "caption"]),
    "price_books":    (["scheme", "sku"], []),
}
PART_TYPES = {"OEM", "Aftermarket", "Universal"}
XREF_TYPES = {"oem", "aftermarket", "competitor", "supersession", "alternate"}
SIDES = {"", "L", "R", "C", "B"}
YES = {"y", "yes", "true", "1", "x"}


# ── sheets ────────────────────────────────────────────────────────────────────
def load(src: Path) -> tuple[dict[str, list[dict]], Path]:
    """All sheets as lists of row dicts (blank rows and #comment rows dropped). Files resolve against
    the folder (or the .xlsx's folder)."""
    out: dict[str, list[dict]] = {}
    if src.suffix.lower() == ".xlsx":
        import openpyxl
        wb = openpyxl.load_workbook(src, data_only=True, read_only=True)
        for ws in wb.worksheets:
            name = ws.title.strip().lower()
            if name not in SHEETS: continue
            rows = list(ws.iter_rows(values_only=True))
            if not rows: continue
            head = [str(h or "").strip().lower() for h in rows[0]]
            out[name] = [{h: ("" if v is None else str(v).strip()) for h, v in zip(head, r) if h} for r in rows[1:]]
        base = src.parent
    else:
        for name in SHEETS:
            f = src / f"{name}.csv"
            if f.exists():
                with f.open(encoding="utf-8-sig", newline="") as fh:
                    out[name] = [{(k or "").strip().lower(): (v or "").strip() for k, v in r.items()} for r in csv.DictReader(fh)]
        base = src
    for k in out:
        out[k] = [r for r in out[k] if any(r.values()) and not next(iter(r.values()), "").startswith("#")]
    return out, base


def rands_to_minor(v: str) -> int | None:
    v = (v or "").replace("R", "").replace(" ", "").replace(",", "")
    return None if v == "" else int(round(float(v) * 100))


def yes(v: str) -> bool:
    return (v or "").strip().lower() in YES


def safe_key(s: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "_", s).strip("_")


# ── Supabase ─────────────────────────────────────────────────────────────────
_KEY: str | None = None
def key() -> str:
    global _KEY
    if _KEY: return _KEY
    _KEY = os.environ.get("CTP_SERVICE_KEY")
    if not _KEY:
        npx = "npx.cmd" if os.name == "nt" else "npx"
        r = subprocess.run([npx, "supabase", "projects", "api-keys", "--project-ref", PROJECT, "-o", "json"],
                           capture_output=True, text=True, cwd=REPO)
        try: _KEY = next(k["api_key"] for k in json.loads(r.stdout) if k["name"] == "service_role")
        except Exception: sys.exit("Could not read the service key: run `npx supabase login` first (or set CTP_SERVICE_KEY).")
    return _KEY


def http(method: str, url: str, body: bytes | None = None, headers: dict | None = None, timeout: int = 150) -> tuple[int, bytes]:
    h = {"Authorization": f"Bearer {key()}", "apikey": key(), **(headers or {})}
    req = urllib.request.Request(url, data=body, method=method, headers=h)
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r: return r.status, r.read()
        except urllib.error.HTTPError as e: return e.code, e.read()
        except (urllib.error.URLError, TimeoutError):
            if attempt == 3: raise
            time.sleep(3 * (attempt + 1))
    raise RuntimeError("unreachable")


def rest(method: str, path: str, body=None) -> object:
    s, b = http(method, f"{URL}/rest/v1/{path}", json.dumps(body).encode() if body is not None else None,
                {"Content-Type": "application/json", "Accept": "application/json"})
    if s >= 300: sys.exit(f"Supabase {method} {path} → {s}: {b[:500].decode(errors='replace')}")
    return json.loads(b or b"null")


def fn(name: str, body: dict) -> dict:
    s, b = http("POST", f"{URL}/functions/v1/{name}", json.dumps(body).encode(), {"Content-Type": "application/json"}, timeout=400)
    try: return json.loads(b)
    except Exception: return {"ok": False, "error": f"{s} {b[:300]!r}"}


def sql(q: str) -> list[dict]:
    """Read-only server-side query through the Supabase CLI (used for the price-book preview, whose call
    stays inside the database like the 10-minute cron: no secret leaves it)."""
    npx = "npx.cmd" if os.name == "nt" else "npx"
    tmp = REPO / ".onboard_q.sql"
    tmp.write_text(q, encoding="utf-8")
    try:
        r = subprocess.run([npx, "supabase", "db", "query", "--linked", "-f", str(tmp)], capture_output=True, text=True, cwd=REPO, encoding="utf-8")
    finally:
        tmp.unlink(missing_ok=True)
    t = r.stdout
    try: return json.loads(t[t.index("{"):]).get("rows", [])
    except Exception: sys.exit(f"query failed: {r.stderr[-500:] or t[-500:]}")


# ── validation → payload ─────────────────────────────────────────────────────
class Report:
    def __init__(self): self.errors: list[str] = []; self.warnings: list[str] = []
    def err(self, m): self.errors.append(m)
    def warn(self, m): self.warnings.append(m)


def image_size(p: Path) -> tuple[int, int] | None:
    try:
        from PIL import Image
        with Image.open(p) as im: return im.size
    except Exception: return None


def build(sheets: dict, base: Path, rep: Report, existing: dict | None = None) -> dict:
    for name, rows in sheets.items():
        req, opt = SHEETS[name]
        cols = set(rows[0].keys()) if rows else set()
        for c in req:
            if rows and c not in cols: rep.err(f"{name}: column '{c}' is missing")
        for c in cols - set(req) - set(opt): rep.warn(f"{name}: column '{c}' is not used")
        for i, r in enumerate(rows, 2):
            for c in req:
                if c in cols and not r.get(c): rep.err(f"{name} row {i}: '{c}' is empty")
    if "profile" not in sheets or len(sheets["profile"]) != 1: rep.err("profile: exactly one row is needed"); return {}
    if "parts" not in sheets: rep.err("parts: the sheet is missing"); return {}
    pr = dict(sheets["profile"][0])
    make, model = pr.get("make", ""), pr.get("model", "")
    if not re.fullmatch(r"[A-Z0-9_]{2,20}", pr.get("code", "")): rep.err("profile: code must be 2-20 capitals/digits/_ (e.g. SINOTRUK_C7H)")
    if pr.get("zoho_manufacturer") and pr["zoho_manufacturer"] != make:
        rep.err(f"profile: zoho_manufacturer '{pr['zoho_manufacturer']}' ≠ make '{make}' — Zoho's Manufacturer is copied back into CTP's make, so they must match")
    if not pr.get("zoho_brand"): rep.err("profile: zoho_brand is empty — Zoho requires a Brand on every item (universal parts: model and zoho_brand 'All models')")
    if not pr.get("zoho_manufacturer"): rep.err("profile: zoho_manufacturer is empty — set it to the make")
    if pr.get("zoho_brand", "") != model and pr.get("zoho_brand"):
        rep.err(f"profile: zoho_brand '{pr['zoho_brand']}' ≠ model '{model}' — Zoho's Brand is copied back into CTP's model")
    if pr.get("default_part_type") and pr["default_part_type"] not in PART_TYPES: rep.err(f"profile: default_part_type must be one of {sorted(PART_TYPES)}")
    for k in ("zoho_sales_account_id", "zoho_purchase_account_id", "zoho_inventory_account_id"):
        if not pr.get(k): rep.warn(f"profile: {k} empty — CTP import works, the Zoho step will refuse until it is filled (onboard.py accounts lists them)")
    pn_re = re.compile(pr["pn_pattern"]) if pr.get("pn_pattern") else None
    ex_parts = (existing or {}).get("parts", {})
    ex_sections = (existing or {}).get("sections", set())

    sections = {r["code"]: r["name"] for r in sheets.get("sections", [])}
    for c in sections:
        if not re.fullmatch(r"[A-Z0-9]{2,12}", c): rep.err(f"sections: code '{c}' must be 2-12 capitals/digits")
    known_sections = set(sections) | ex_sections

    parts, skus = [], set()
    for i, r in enumerate(sheets["parts"], 2):
        sku = r.get("sku", "")
        if not sku: continue
        if sku.upper() in skus: rep.err(f"parts row {i}: SKU {sku} twice")
        skus.add(sku.upper())
        if re.search(r"\s", sku): rep.err(f"parts row {i}: SKU '{sku}' has a space")
        if pn_re and not pn_re.search(sku) and not yes(r.get("universal", "")): rep.warn(f"parts row {i}: {sku} does not look like a {make} part number ({pr['pn_pattern']})")
        pt = r.get("part_type") or pr.get("default_part_type", "")
        if pt and pt not in PART_TYPES: rep.err(f"parts row {i}: part_type '{pt}' — use {sorted(PART_TYPES)}")
        if (r.get("side") or "").upper() not in SIDES: rep.err(f"parts row {i}: side '{r['side']}' — use L, R, C, B or blank")
        if r.get("section_code") and r["section_code"] not in known_sections: rep.err(f"parts row {i}: section {r['section_code']} is not in sections and not in CTP")
        try: price = rands_to_minor(r.get("list_price_zar", ""))
        except ValueError: rep.err(f"parts row {i}: list_price_zar '{r['list_price_zar']}' is not a number"); price = None
        if price is None and sku.upper() not in ex_parts: rep.warn(f"parts row {i}: {sku} has no list price — its new Zoho item would get rate 0")
        ex = ex_parts.get(sku.upper())
        if ex and (ex.get("make") or "") != (r.get("make") or make):
            rep.err(f"parts row {i}: {sku} already exists in CTP as a {ex.get('make') or 'no-make'} part — never overwritten; use another SKU")
        universal = yes(r.get("universal", "")) or pt == "Universal"
        parts.append({"sku": sku, "name": r["name"], "section_code": r.get("section_code", ""), "part_type": pt, "universal": universal,
                      "make": r.get("make") or make, "model": r.get("model") or model,
                      "catalogue_pn": r.get("catalogue_pn", ""), "mpn": r.get("mpn", ""), "side": (r.get("side") or "").upper(),
                      "drawing_no": r.get("drawing_no", ""), "diagram_item_no": r.get("diagram_item_no", ""), "description": r.get("description", ""),
                      "uom": r.get("uom", ""), "weight_g": r.get("weight_g", ""), "list_price_minor": "" if price is None else str(price),
                      "supplier": r.get("supplier", ""), "notes": r.get("notes", "")})
    all_skus = skus | set(ex_parts)

    vehicles = [{"make": v.get("make") or make, "model": v["model"], "variant": v.get("variant", ""), "year_from": v.get("year_from", ""),
                 "year_to": v.get("year_to", ""), "engine": v.get("engine", ""), "notes": v.get("notes", "")} for v in sheets.get("vehicles", [])]
    vkeys = {(v["make"], v["model"], v["variant"]) for v in vehicles}
    fitment = []
    for i, f in enumerate(sheets.get("fitment", []), 2):
        k = (f.get("make") or make, f["model"], f.get("variant", ""))
        if k not in vkeys: rep.err(f"fitment row {i}: {' '.join(k).strip()} is not in vehicles")
        if f["sku"].upper() not in all_skus: rep.err(f"fitment row {i}: SKU {f['sku']} not in parts")
        fitment.append({"sku": f["sku"], "make": k[0], "model": k[1], "variant": k[2], "year_from": f.get("year_from", ""),
                        "year_to": f.get("year_to", ""), "engine": f.get("engine", ""), "note": f.get("note", "")})
    # a make-specific part with no fitment row fits the profile's own model (as every FAW part fits the JH6)
    fitted = {f["sku"].upper() for f in fitment}
    for p in parts:
        if not p["universal"] and p["sku"].upper() not in fitted and model:
            if (make, model, "") not in vkeys:
                vehicles.append({"make": make, "model": model, "variant": "", "year_from": "", "year_to": "", "engine": "", "notes": ""}); vkeys.add((make, model, ""))
            fitment.append({"sku": p["sku"], "make": make, "model": model, "variant": "", "year_from": "", "year_to": "", "engine": "", "note": "default: the profile's model"})

    xrefs = []
    for i, x in enumerate(sheets.get("xrefs", []), 2):
        t = (x.get("xref_type") or "aftermarket").lower()
        if t not in XREF_TYPES: rep.err(f"xrefs row {i}: xref_type '{t}' — use {sorted(XREF_TYPES)}")
        if x["sku"].upper() not in all_skus: rep.err(f"xrefs row {i}: SKU {x['sku']} not in parts")
        xrefs.append({"sku": x["sku"], "xref_number": x["xref_number"], "xref_brand": x.get("xref_brand", ""), "xref_type": t, "confidence": x.get("confidence", "")})

    suppliers = sheets.get("suppliers", [])
    sup_codes = {s["code"] for s in suppliers} | (existing or {}).get("suppliers", set())
    part_sup = []
    for i, s in enumerate(sheets.get("part_suppliers", []), 2):
        if s["supplier_code"] not in sup_codes: rep.err(f"part_suppliers row {i}: supplier {s['supplier_code']} not in suppliers or CTP")
        if s["sku"].upper() not in all_skus: rep.err(f"part_suppliers row {i}: SKU {s['sku']} not in parts")
        try: cost = rands_to_minor(s.get("cost_zar", ""))
        except ValueError: rep.err(f"part_suppliers row {i}: cost_zar '{s['cost_zar']}' is not a number"); cost = None
        part_sup.append({"sku": s["sku"], "supplier_code": s["supplier_code"], "supplier_sku": s.get("supplier_sku", ""),
                         "cost_minor": "" if cost is None else str(cost), "currency": s.get("currency", ""), "lead_time_days": s.get("lead_time_days", ""),
                         "moq": s.get("moq", ""), "is_preferred": yes(s.get("preferred", ""))})
    per_sku: dict[str, int] = {}
    for s in part_sup:
        if s["is_preferred"]: per_sku[s["sku"].upper()] = per_sku.get(s["sku"].upper(), 0) + 1
    for k, n in per_sku.items():
        if n > 1: rep.err(f"part_suppliers: {k} has {n} preferred suppliers — mark one")

    files: list[dict] = []   # {local, key} to upload
    def stage(rel: str, folder: str, stem: str) -> str | None:
        p = (base / rel).resolve()
        if not p.exists(): rep.err(f"file not found: {rel}"); return None
        if image_size(p) is None: rep.err(f"not a readable picture: {rel}"); return None
        h = hashlib.sha256(p.read_bytes()).hexdigest()[:8]
        k = f"{folder}/{safe_key(stem)}_{h}{p.suffix.lower()}"
        files.append({"local": str(p), "key": k}); return k

    diagrams, dsize = [], {}
    for i, d in enumerate(sheets.get("diagrams", []), 2):
        if d["section_code"] not in known_sections: rep.err(f"diagrams row {i}: section {d['section_code']} unknown")
        if re.fullmatch(r"SEC\d+", d["drawing_key"]): rep.err(f"diagrams row {i}: SEC<number> keys are FAW JH6's — use e.g. {pr.get('code')}-{d['section_code']}")
        k = stage(d["image_file"], f"assets/diagrams/{safe_key(pr.get('code', 'x')).lower()}", d["drawing_key"])
        sz = image_size((base / d["image_file"]).resolve()) if k else None
        w, h = int(d.get("img_w") or (sz[0] if sz else 0)), int(d.get("img_h") or (sz[1] if sz else 0))
        dsize[d["drawing_key"]] = (w, h)
        diagrams.append({"drawing_key": d["drawing_key"], "section_code": d["section_code"], "title": d["title"], "image_path": k or "", "img_w": str(w), "img_h": str(h)})
    hotspots = []
    for i, h in enumerate(sheets.get("hotspots", []), 2):
        if h["drawing_key"] not in dsize: rep.err(f"hotspots row {i}: drawing {h['drawing_key']} not in diagrams")
        if h["sku"].upper() not in all_skus: rep.err(f"hotspots row {i}: SKU {h['sku']} not in parts")
        try:
            x, y = float(h["x"]), float(h["y"]); w, hh = dsize.get(h["drawing_key"], (0, 0))
            if w and not (0 <= x <= w and 0 <= y <= hh): rep.err(f"hotspots row {i}: ({x:.0f}, {y:.0f}) is outside the {w}×{hh} drawing")
        except ValueError: rep.err(f"hotspots row {i}: x/y must be numbers (pixels on the drawing)")
        hotspots.append({"drawing_key": h["drawing_key"], "item_no": h["item_no"], "sku": h["sku"], "x": h["x"], "y": h["y"], "radius": h.get("radius", "")})
    images, prim = [], {}
    for i, im in enumerate(sheets.get("images", []), 2):
        if im["sku"].upper() not in all_skus: rep.err(f"images row {i}: SKU {im['sku']} not in parts")
        k = stage(im["image_file"], "assets/photos/master", im["sku"])
        if k: images.append({"sku": im["sku"], "path": k, "is_primary": yes(im.get("is_primary", "")), "sort_order": im.get("sort_order", ""),
                             "caption": im.get("caption", ""), "_local": str((base / im["image_file"]).resolve())})
    for im in images: prim.setdefault(im["sku"].upper(), []).append(im)
    for s, lst in prim.items():
        if not any(x["is_primary"] for x in lst): lst[0]["is_primary"] = True   # first photo is the main one
    for p in parts:
        if p["sku"].upper() not in prim and p["sku"].upper() not in ex_parts: rep.warn(f"parts: {p['sku']} has no photo")
    schemes = [{"scheme": r["scheme"], "sku": r["sku"]} for r in sheets.get("price_books", [])]
    for i, r in enumerate(schemes, 2):
        if r["sku"].upper() not in all_skus: rep.err(f"price_books row {i}: SKU {r['sku']} not in parts")

    profile = {k: pr.get(k, "") for k in SHEETS["profile"][0] + SHEETS["profile"][1] if not k.startswith("parts_brand_") or k == "parts_brand_code"}
    return {"is_test": yes(pr.get("is_test", "")), "profile": profile,
            "brand": {"code": pr.get("parts_brand_code", ""), "name": pr.get("parts_brand_name", ""), "is_oem": 1 if yes(pr.get("parts_brand_is_oem", "")) else 0},
            "vehicles": vehicles, "sections": [{"code": c, "name": n} for c, n in sections.items()], "suppliers": suppliers,
            "parts": parts, "fitment": fitment, "xrefs": xrefs, "part_suppliers": part_sup, "diagrams": diagrams,
            "hotspots": hotspots, "images": images, "scheme_skus": schemes, "_files": files}


def existing_state(skus: list[str]) -> dict:
    ex: dict = {"parts": {}, "sections": set(), "suppliers": set()}
    for i in range(0, len(skus), 80):
        chunk = ",".join('"' + s.replace('"', "") + '"' for s in skus[i:i + 80])
        for r in rest("GET", f"part?select=sku,make,model,deleted_at&deleted_at=is.null&sku=in.({urllib.request.quote(chunk)})") or []:
            ex["parts"][r["sku"].upper()] = r
    ex["sections"] = {r["code"] for r in rest("GET", "category?select=code&deleted_at=is.null") or []}
    ex["suppliers"] = {r["code"] for r in rest("GET", "supplier?select=code&deleted_at=is.null") or []}
    return ex


def prepare(src: Path, online: bool = True) -> tuple[dict, Report]:
    sheets, base = load(src)
    rep = Report()
    ex = existing_state([r["sku"] for r in sheets.get("parts", []) if r.get("sku")]) if online else None
    payload = build(sheets, base, rep, ex)
    if ex and payload:
        new = [p["sku"] for p in payload["parts"] if p["sku"].upper() not in ex["parts"]]
        upd = [p["sku"] for p in payload["parts"] if p["sku"].upper() in ex["parts"]]
        rep.warn(f"{len(new)} new part(s), {len(upd)} already in CTP (updated, prices left alone)") if upd else None
    return payload, rep


def show(rep: Report) -> None:
    for w in rep.warnings: print("  warning:", w)
    for e in rep.errors: print("  ERROR:  ", e)
    print(f"  → {len(rep.errors)} error(s), {len(rep.warnings)} warning(s)")


# ── pictures ─────────────────────────────────────────────────────────────────
def web_variant(local: str) -> bytes:
    """The app's thumbnail: content cropped, square, white, ≤1200 px, WebP (as server/upload_web_variants.py)."""
    from PIL import Image, ImageChops, ImageOps
    im = ImageOps.exif_transpose(Image.open(local))
    if im.mode in ("RGBA", "LA", "P"):
        im = im.convert("RGBA"); bg = Image.new("RGBA", im.size, (255, 255, 255, 255)); bg.alpha_composite(im); im = bg
    im = im.convert("RGB")
    diff = ImageChops.difference(im, Image.new("RGB", im.size, (255, 255, 255))).convert("L").point(lambda v: 255 if v > 18 else 0)
    box = diff.getbbox() or (0, 0, *im.size)
    im = im.crop(box); s = int(max(im.size) * 1.08)
    sq = Image.new("RGB", (s, s), (255, 255, 255)); sq.paste(im, ((s - im.size[0]) // 2, (s - im.size[1]) // 2))
    if s > 1200: sq = sq.resize((1200, 1200), Image.LANCZOS)
    b = io.BytesIO(); sq.save(b, "WEBP", quality=82); return b.getvalue()


def upload(key_: str, data: bytes, ctype: str) -> str:
    s, b = http("POST", f"{URL}/storage/v1/object/{BUCKET}/{key_}", data, {"Content-Type": ctype, "x-upsert": "false", "cache-control": "max-age=31536000"})
    if s in (200, 201): return "uploaded"
    if s in (400, 409) and b"exists" in b.lower(): return "already there"   # same content hash = same file
    sys.exit(f"upload {key_} → {s} {b[:200]!r}")


def upload_all(payload: dict) -> list[str]:
    done, keys = [], []
    ctype = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif"}
    for f in payload["_files"]:
        ext = Path(f["local"]).suffix.lower()
        done.append(f"{upload(f['key'], Path(f['local']).read_bytes(), ctype.get(ext, 'application/octet-stream'))}: {f['key']}"); keys.append(f["key"])
        if f["key"].startswith("assets/photos/master/"):
            wk = "assets/photos/web/" + Path(f["key"]).stem + ".webp"
            done.append(f"{upload(wk, web_variant(f['local']), 'image/webp')}: {wk}"); keys.append(wk)
    return done


# ── commands ─────────────────────────────────────────────────────────────────
def cmd_validate(a):
    payload, rep = prepare(Path(a.sheets), online=not a.offline)
    if payload: print(f"  {len(payload['parts'])} parts · {len(payload['fitment'])} fitment · {len(payload['xrefs'])} xrefs · "
                      f"{len(payload['part_suppliers'])} part suppliers · {len(payload['diagrams'])} drawings · {len(payload['hotspots'])} hotspots · "
                      f"{len(payload['images'])} photos · {len(payload['scheme_skus'])} price-book rows")
    show(rep); return 1 if rep.errors else 0


def cmd_import(a):
    payload, rep = prepare(Path(a.sheets))
    show(rep)
    if rep.errors: print("Fix the errors first — nothing was imported."); return 1
    p = {k: v for k, v in payload.items() if not k.startswith("_")}
    p["images"] = [{k: v for k, v in i.items() if not k.startswith("_")} for i in p["images"]]
    p["batch"] = a.batch
    if a.apply:
        print(f"Uploading {len(payload['_files'])} picture(s) (+ web thumbnails for photos) …")
        for line in upload_all(payload): print("  ", line)
    else:
        print(f"(dry run: {len(payload['_files'])} picture(s) would be uploaded)")
    r = rest("POST", "rpc/onboard_import", {"p": p, "p_dry_run": not a.apply})
    print(json.dumps(r, indent=2, ensure_ascii=False))
    if a.apply and r.get("ok"):
        rest("PATCH", f"import_batch?code=eq.{a.batch}", {"summary": {**r, "uploads": [f["key"] for f in payload["_files"]]}})
    if not r.get("ok"): print("NOT imported (errors above; CTP unchanged)." if a.apply else "Dry run found errors."); return 1
    print("Imported into CTP." if a.apply else "Dry run OK — nothing was written. Run again with --apply.")
    return 0


def loop_fn(name: str, body: dict, key_left: str = "left") -> list[dict]:
    outs = []
    while True:
        r = fn(name, body); outs.append(r)
        print(json.dumps(r, indent=2, ensure_ascii=False))
        if not r.get("ok", True) or not body.get("apply") or not r.get(key_left): return outs


def cmd_zoho(a):
    outs = loop_fn("zoho-onboard", {"action": "items", "batch": a.batch, "apply": a.apply})
    return 0 if all(o.get("ok") and not o.get("failed") for o in outs) else 1


def batch_skus(batch: str) -> list[str]:
    rows = rest("GET", f"import_batch_row?select=row_key&batch_code=eq.{batch}&entity=eq.part&action=in.(created,updated)") or []
    return sorted({r["row_key"] for r in rows})


def cmd_images(a):
    skus = batch_skus(a.batch)
    r = fn("zoho-auth", {"action": "item_images", "skus": skus, "dry_run": not a.apply, "limit": 60})
    print(json.dumps(r, indent=2, ensure_ascii=False)); return 0 if r.get("ok") else 1


def cmd_pricebook(a):
    """Preview only. Building the book changes prices customers see in Zoho: Ian decides, then an admin
    runs zoho-push rebate_book with apply (docs/13 step 8)."""
    rows = rest("GET", f"import_batch?select=profile_code&code=eq.{a.batch}") or []
    if not rows: sys.exit("no such batch")
    prof = (rest("GET", f"make_profile?select=rebate_scheme_id,code&code=eq.{rows[0]['profile_code']}") or [{}])[0]
    names = [r["name"] for r in rest("GET", "rebate_scheme?select=id,name") or [] if r["id"] == prof.get("rebate_scheme_id")]
    srows = rest("GET", f"rebate_scheme_sku?select=scheme_id,sku&source=eq.{urllib.request.quote('onboard ' + a.batch)}") or []
    ids = {r["scheme_id"] for r in srows}
    names += [r["name"] for r in rest("GET", "rebate_scheme?select=id,name") or [] if r["id"] in ids and r["name"] not in names]
    if not names: print("This batch adds no SKUs to a price-book scheme and its profile names none — nothing to preview."); return 0
    for n in names:
        body = json.dumps({"action": "rebate_book", "scheme": n}).replace("'", "''")
        req = sql(f"""select net.http_post(url := '{URL}/functions/v1/zoho-push',
          headers := jsonb_build_object('Content-Type','application/json',
            'Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name='ctp_anon_key'),
            'x-sync-token', (select decrypted_secret from vault.decrypted_secrets where name='zoho_sync_token')),
          body := '{body}'::jsonb, timeout_milliseconds := 120000) as id""")[0]["id"]
        for _ in range(40):
            time.sleep(5)
            got = sql(f"select status_code, content::text c, error_msg from net._http_response where id = {int(req)}")
            if got: break
        if not got: print(f"{n}: no answer yet (request {req})"); continue
        d = json.loads(got[0]["c"] or "{}")
        mine = {s.upper() for s in batch_skus(a.batch)}
        print(f"\nPrice book '{n}' — PREVIEW (nothing changed): {d.get('parts_in_scheme')} SKUs in the scheme, {d.get('in_book')} would be in the book, tiers {d.get('tiers')}")
        for r in d.get("rows", []):
            if r.get("sku", "").upper() in mine: print(f"   {r['sku']}: Zoho rate {r.get('zoho_rate')} cost {r.get('cost')} → rebate {r.get('rebate_pct')} = {r.get('rebate_price')} {r.get('flag', '')}")
        for f in d.get("flags", []):
            if f.split(":")[0].upper() in mine: print("   flag:", f)
        if d.get("error"): print("   error:", d["error"])
    return 0


def cmd_verify(a):
    skus = batch_skus(a.batch)
    print(f"CTP: {len(skus)} part(s) in batch {a.batch}")
    r = fn("zoho-onboard", {"action": "verify", "batch": a.batch})
    print(json.dumps(r, indent=2, ensure_ascii=False)); return 0 if r.get("ok") else 1


def cmd_status(a):
    b = rest("GET", f"import_batch?code=eq.{a.batch}") or []
    if not b: print("no such batch"); return 1
    rows = rest("GET", f"import_batch_row?select=entity,action&batch_code=eq.{a.batch}") or []
    agg: dict[str, int] = {}
    for r in rows: agg[f"{r['entity']}:{r['action']}"] = agg.get(f"{r['entity']}:{r['action']}", 0) + 1
    print(json.dumps({"batch": b[0], "rows": agg}, indent=2, ensure_ascii=False)); return 0


def cmd_rollback(a):
    print("1. Zoho: deactivate the items this batch CREATED (items it only linked are left as they were)")
    z = fn("zoho-onboard", {"action": "deactivate", "batch": a.batch, "apply": a.apply})
    print(json.dumps(z, indent=2, ensure_ascii=False))
    if a.apply and (not z.get("ok") or z.get("failed")): print("Zoho step failed — CTP left as it is."); return 1
    print("2. CTP: restore updated rows, " + ("DELETE" if a.purge else "soft-delete") + " created rows")
    r = rest("POST", "rpc/onboard_rollback", {"p_batch": a.batch, "p_purge": a.purge, "p_dry_run": not a.apply})
    print(json.dumps(r, indent=2, ensure_ascii=False))
    if a.apply and a.purge:
        b = (rest("GET", f"import_batch?select=summary&code=eq.{a.batch}") or [{}])[0]
        ups = (b.get("summary") or {}).get("uploads", [])
        keys = ups + ["assets/photos/web/" + Path(k).stem + ".webp" for k in ups if k.startswith("assets/photos/master/")]
        still = [k for k in keys if rest("GET", f"part_image?select=id&path=eq.{urllib.request.quote(k)}") or rest("GET", f"diagram?select=id&image_path=eq.{urllib.request.quote(k)}")]
        gone = [k for k in keys if k not in still]
        if gone:
            s, bb = http("DELETE", f"{URL}/storage/v1/object/{BUCKET}", json.dumps({"prefixes": gone}).encode(), {"Content-Type": "application/json"})
            print(f"3. Storage: removed {len(gone)} picture(s) of this TEST batch ({s})" + (f"; kept {len(still)} still in use" if still else ""))
    if not a.apply: print("(dry run — nothing changed. Run again with --apply.)")
    return 0


def cmd_accounts(a):
    r = fn("zoho-onboard", {"action": "accounts"}); print(json.dumps(r, indent=2, ensure_ascii=False)); return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    v = sub.add_parser("validate"); v.add_argument("sheets"); v.add_argument("--offline", action="store_true", help="skip the CTP lookups")
    i = sub.add_parser("import"); i.add_argument("sheets"); i.add_argument("--batch", required=True); i.add_argument("--apply", action="store_true")
    for n in ("zoho", "images"):
        s = sub.add_parser(n); s.add_argument("--batch", required=True); s.add_argument("--apply", action="store_true")
    for n in ("pricebook", "verify", "status"):
        s = sub.add_parser(n); s.add_argument("--batch", required=True)
    r = sub.add_parser("rollback"); r.add_argument("--batch", required=True); r.add_argument("--apply", action="store_true")
    r.add_argument("--purge", action="store_true", help="TEST batches only: delete instead of soft-delete, and remove their pictures")
    sub.add_parser("accounts")
    a = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")
    return {"validate": cmd_validate, "import": cmd_import, "zoho": cmd_zoho, "images": cmd_images, "pricebook": cmd_pricebook,
            "verify": cmd_verify, "status": cmd_status, "rollback": cmd_rollback, "accounts": cmd_accounts}[a.cmd](a)


if __name__ == "__main__":
    sys.exit(main())
