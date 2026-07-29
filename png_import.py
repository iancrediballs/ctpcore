# Import cleaned white-background PNGs as PRIMARY part photos.
# Fixes labels: strips processed_ / .CR2 / trailing seq, normalizes, matches by OEM PN.
# Idempotent (re-run safe). Demotes raws to secondary; lists anything unmatched.
import os, re, sqlite3, sys
from collections import defaultdict
from PIL import Image

PNGDIR = r"C:\Users\Rick\OneDrive\Desktop\China Truck Parts\Raw  Photo's\PNG's"
ROOT   = r"C:\Users\Rick\Claude\Projects\China Truck Parts ERP"
PHOTOS = os.path.join(ROOT, "app", "public", "assets", "photos")
DB     = os.path.join(os.environ["APPDATA"], "net.chinatruckparts.fleetview", "fleetview.db")
os.makedirs(PHOTOS, exist_ok=True)

def norm(s): return re.sub(r'[^a-z0-9]', '', (s or '').lower())
def stem(f):
    s = f
    s = re.sub(r'^processed[_\- ]*', '', s, flags=re.I)
    s = re.sub(r'\.png$', '', s, flags=re.I)
    s = re.sub(r'\.cr2.*$', '', s, flags=re.I)   # drop .CR2 and trailing junk
    s = re.sub(r'[-_ ]\d{1,2}$', '', s)           # drop a SEPARATED sequence (-01/_2), keep glued PN digits
    return s

# label fixes: mistyped filename  ->  correct part number
ALIASES = {
    "510362AB83": "5103162AB83",
}

pngs = [f for f in os.listdir(PNGDIR) if f.lower().endswith('.png') and os.path.isfile(os.path.join(PNGDIR, f))]
idx = defaultdict(list)
for f in pngs:
    idx[norm(stem(f))].append(f)
# apply aliases (register the bad key's files under the correct PN too)
for bad, good in ALIASES.items():
    kb, kg = norm(bad), norm(good)
    if kb in idx:
        idx[kg].extend(idx[kb])

con = sqlite3.connect(DB); con.execute("PRAGMA busy_timeout=8000"); cur = con.cursor()
parts = cur.execute("SELECT id,inventory_pn,catalogue_pn,name FROM part WHERE sku LIKE 'CTP-%'").fetchall()

def convert(src, dst, maxw=1400):
    im = Image.open(src)
    if im.mode in ("P", "LA"): im = im.convert("RGBA")
    if im.width > maxw:
        im = im.resize((maxw, int(im.height * maxw / im.width)), Image.LANCZOS)
    im.save(dst, "PNG", optimize=True)

matched_keys = set()
done = skip = 0
for pid, inv, cat, name in parts:
    hit = None
    for k in (norm(inv), norm(cat)):
        if k and k in idx: hit = (k, idx[k]); break
    if not hit:
        continue
    key, files = hit
    matched_keys.add(key)
    chosen = sorted(files, key=lambda n: (len(n), n))[0]   # cleanest filename
    rel = "assets/photos/png_%d.png" % pid
    try:
        convert(os.path.join(PNGDIR, chosen), os.path.join(PHOTOS, "png_%d.png" % pid))
    except Exception as e:
        print("FAIL", pid, chosen, e); sys.stdout.flush(); continue
    # make it the primary, demote everything else for this part
    cur.execute("UPDATE part_image SET is_primary=0 WHERE part_id=?", (pid,))
    row = cur.execute("SELECT id FROM part_image WHERE part_id=? AND path=?", (pid, rel)).fetchone()
    if row:
        cur.execute("UPDATE part_image SET is_primary=1, deleted_at=NULL, kind='photo' WHERE id=?", (row[0],))
        skip += 1
    else:
        cur.execute("INSERT INTO part_image(part_id,path,kind,is_primary,sort_order) VALUES(?,?,?,1,0)", (pid, rel, 'photo'))
        done += 1
con.commit()

unmatched = sorted(k for k in idx if k not in matched_keys)
print("PNG files: %d | parts matched (new): %d | refreshed: %d" % (len(pngs), done, skip))
print("unmatched png groups: %d" % len(unmatched))
for k in unmatched[:25]:
    print("   ?", idx[k][0])
con.close()
