# Reconcile the corrected master into the LIVE app database, in place.
# Matches by Item # -> part id (1000+#). Only updates non-blank changed fields.
# Preserves images, hotspots, locator, catalogue_pn (reorder ref). Idempotent.
import json, os, sqlite3, time

ROOT = r"C:\Users\Rick\Claude\Projects\China Truck Parts ERP"
DB = os.path.join(os.environ["APPDATA"], "net.chinatruckparts.fleetview", "fleetview.db")
parts = json.load(open(os.path.join(ROOT, "data", "master_parts.json"), encoding="utf-8"))

SIDE = {'L/H': 'L', 'R/H': 'R', 'CENTRE': 'C', 'BOTH': 'B', '-': 'C'}
def clean(x):
    if x is None: return None
    s = str(x).strip()
    return s if s and s.lower() != 'none' else None

con = sqlite3.connect(DB)
con.execute("PRAGMA busy_timeout=8000")
con.row_factory = sqlite3.Row
cur = con.cursor()

rep = {'name': 0, 'inv': 0, 'side': 0, 'match': 0, 'notes': 0, 'bin': 0, 'qty': 0, 'missing': 0}
changes = []
for p in parts:
    pid = 1000 + int(p['num'])
    row = cur.execute("SELECT id,name,side,inventory_pn,match_status,notes FROM part WHERE id=?", (pid,)).fetchone()
    if not row:
        rep['missing'] += 1; continue
    sets, vals = [], []
    nm = clean(p['name'])
    if nm and nm != row['name']:
        sets.append("name=?"); vals.append(nm); rep['name'] += 1; changes.append(('name', pid, row['name'], nm))
    sd = SIDE.get(str(p['side']).strip()) if p['side'] is not None else None
    if sd and sd != row['side']:
        sets.append("side=?"); vals.append(sd); rep['side'] += 1
    inv = clean(p['inv_pn'])
    if inv and inv != row['inventory_pn']:
        sets.append("inventory_pn=?"); vals.append(inv); rep['inv'] += 1; changes.append(('inv', pid, row['inventory_pn'], inv))
    ms = clean(p['status'])
    if ms and ms != row['match_status']:
        sets.append("match_status=?"); vals.append(ms); rep['match'] += 1
    nt = clean(p['notes'])
    if nt is not None and nt != (row['notes'] or None):
        sets.append("notes=?"); vals.append(nt); rep['notes'] += 1
    if sets:
        sets += ["rev=rev+1", "updated_at=datetime('now')"]
        cur.execute("UPDATE part SET %s WHERE id=?" % ",".join(sets), (*vals, pid))
    # warehouse bin
    wh = clean(p['wh_loc'])
    if wh:
        ex = cur.execute("SELECT bin FROM stock_policy WHERE part_id=? AND location_id=10", (pid,)).fetchone()
        if ex and ex['bin'] != wh:
            cur.execute("UPDATE stock_policy SET bin=?,rev=rev+1,updated_at=datetime('now') WHERE part_id=? AND location_id=10", (wh, pid)); rep['bin'] += 1
        elif not ex:
            cur.execute("INSERT INTO stock_policy(part_id,location_id,bin) VALUES(?,10,?)", (pid, wh)); rep['bin'] += 1
    # qty correction -> idempotent adjustment to reach master qty
    try: newq = int(float(p['qty']))
    except (TypeError, ValueError): newq = None
    if newq is not None:
        oh = cur.execute("SELECT COALESCE(SUM(delta),0) FROM stock_movement WHERE part_id=?", (pid,)).fetchone()[0]
        delta = newq - oh
        if delta != 0:
            uuid = "reconcile-qty-%d-%d" % (pid, newq)
            n = cur.execute("INSERT OR IGNORE INTO stock_movement(part_id,location_id,delta,reason,ref_type,client_uuid) VALUES(?,10,?,?,?,?)",
                            (pid, delta, 'adjustment', 'reconcile', uuid)).rowcount
            if n: rep['qty'] += 1; changes.append(('qty', pid, oh, newq))

con.commit()
print("RECONCILE REPORT:", rep)
print("--- changes applied ---")
for c in changes: print("  ", c)
con.close()
