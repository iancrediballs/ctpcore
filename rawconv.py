# Convert matched Canon RAW (.CR2) shots -> compressed web JPEGs, attach to parts.
# Idempotent: a part that already has assets/photos/raw_<id>.jpg is skipped.
# Existing (cropped) photos stay primary; raws fill parts that have none.
import os, sqlite3, re, sys
from collections import defaultdict
import rawpy
from PIL import Image

RAW = r"C:\Users\Rick\OneDrive\Desktop\China Truck Parts\Raw  Photo's\Raw images"
ROOT = r"C:\Users\Rick\Claude\Projects\China Truck Parts ERP"
PHOTOS = os.path.join(ROOT, "app", "public", "assets", "photos")
DB = os.path.join(os.environ["APPDATA"], "net.chinatruckparts.fleetview", "fleetview.db")
os.makedirs(PHOTOS, exist_ok=True)

def norm(s): return re.sub(r'[^a-z0-9]', '', (s or '').lower())
def stem(f):
    s = re.sub(r'\.cr2.*$', '', f, flags=re.I)
    s = re.sub(r'[-_ ]?\d{1,2}$', '', s)
    return s

raws = [f for f in os.listdir(RAW) if f.lower().endswith('.cr2')]
idx = defaultdict(list)
for f in raws:
    idx[norm(stem(f))].append(f)

con = sqlite3.connect(DB); con.execute("PRAGMA busy_timeout=8000"); cur = con.cursor()
parts = cur.execute("SELECT id,inventory_pn,catalogue_pn FROM part WHERE sku LIKE 'CTP-%' ORDER BY id").fetchall()

def convert(src, dst, maxw=1400):
    with rawpy.imread(src) as r:
        rgb = r.postprocess(use_camera_wb=True, half_size=True, no_auto_bright=False)
    im = Image.fromarray(rgb)
    if im.width > maxw:
        im = im.resize((maxw, int(im.height * maxw / im.width)), Image.LANCZOS)
    im.save(dst, 'JPEG', quality=82, optimize=True)

done = skip = fail = 0
for pid, inv, cat in parts:
    rel = "assets/photos/raw_%d.jpg" % pid
    if cur.execute("SELECT 1 FROM part_image WHERE part_id=? AND path=?", (pid, rel)).fetchone():
        skip += 1; continue
    hit = None
    for k in (norm(inv), norm(cat)):
        if k and k in idx: hit = idx[k]; break
    if not hit:
        continue
    chosen = sorted(hit, key=lambda n: (len(n), n))[0]
    try:
        convert(os.path.join(RAW, chosen), os.path.join(PHOTOS, "raw_%d.jpg" % pid))
    except Exception as e:
        fail += 1; print("FAIL", pid, chosen, e); sys.stdout.flush(); continue
    has = cur.execute("SELECT COUNT(*) FROM part_image WHERE part_id=? AND deleted_at IS NULL", (pid,)).fetchone()[0]
    cur.execute("INSERT INTO part_image(part_id,path,kind,is_primary,sort_order) VALUES(?,?,?,?,?)",
                (pid, rel, 'raw', 1 if has == 0 else 0, 50))
    con.commit()
    done += 1
    if done % 10 == 0:
        print("...converted", done); sys.stdout.flush()
print("DONE converted=%d skipped=%d failed=%d" % (done, skip, fail))
