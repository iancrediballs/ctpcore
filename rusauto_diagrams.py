# Seed rusauto exploded-view diagrams into the LIVE app DB, hotlinked.
# Each assembly NODE = one rusauto catalog page -> one exploded .gif + numbered
# callouts -> FAW part numbers. We insert the gif as a `diagram` row (image_path
# = full https URL, loaded live by the app) and link Ian's parts to it via
# part_diagram_callout at is_primary=0 (SECONDARY/supplier reference). Ian's own
# drawings sit at is_primary=1, so HIS diagram wins in the PART PANEL
# (part_detail picks MAX is_primary); rusauto only shows when a part has no own
# drawing. The supplier exploded view is still reachable as a reference link.
#
# Matching is by the 7-digit FAW BASE number (leading digit run), because Ian's
# SKUs and rusauto's often share the base but differ by trim/config suffix
# (e.g. 5704111CB45 vs 5704111-B45) — same assembly drawing either way.
# A part keeps its FIRST rusauto assignment (most specific), so re-runs/extra
# nodes won't bounce a part between drawings. Idempotent. Add nodes + re-run.
import os, re, sqlite3
from collections import defaultdict

DB = os.path.join(os.environ["APPDATA"], "net.chinatruckparts.fleetview", "fleetview.db")
GIF = "https://rusauto43.ru/upload/Autocat/Pictures/faw/ca4250/{}.gif"
NODE = "https://rusauto43.ru/catalog/1/146/4108/{}"

# node_id: {title, gif (NNN in /ca4250/NNN.gif), section, callouts {item_no: pn}}
NODES = {
    164: {"title": "Front Bumper Logic Assembly", "gif": "151", "section": "BMP",
        "callouts": {3:"2803645",5:"2803035",7:"2803040",8:"2803722",9:"2803721",
            10:"2803650",12:"2803010",13:"2803031",14:"2803032",15:"2803015",
            16:"2803731",17:"2803821",18:"2803052",19:"2803091",20:"2803018",
            29:"2803381",30:"2803831",32:"2803761",33:"2803762",34:"2803763",35:"2803382"}},
    335: {"title": "Top Cover Air Deflector Module", "gif": "307", "section": "DEF",
        "callouts": {1:"5704111",5:"5704130",8:"5704116",11:"5704145",12:"5704150",
            15:"5704232",17:"5704251",18:"5704211",19:"5704212",20:"5704231",
            22:"5704221",23:"5704222",24:"5704241"}},
    294: {"title": "Fender, Upper Mudguard & 2/3 Pedal Logic Assembly", "gif": "271", "section": "FND",
        "callouts": {1:"5103125",5:"5103130",8:"5103121",9:"5103122",10:"5103161",
            15:"5103211",16:"5103162",20:"5103135",22:"5103191",23:"5103181"}},
    293: {"title": "Rear Mudguard Logic Assembly", "gif": "270", "section": "MUD",
        "callouts": {1:"5103361",2:"5103362",3:"5103373",4:"5103374",5:"5103510"}},
    323: {"title": "Side Toolbox Module", "gif": "297", "section": "TBX",
        "callouts": {1:"5407020",11:"5407015",13:"5407086"}},
    337: {"title": "Front Door Basic Components Logic Assembly", "gif": "308", "section": "DOR",
        "callouts": {15:"6100032",16:"6102152",17:"6101590",27:"6101585",
            34:"6102151",36:"6100031",39:"6109015"}},
    341: {"title": "Front Door Electric Components Module", "gif": "312", "section": "DOR",
        "callouts": {1:"6102015",7:"6102020",12:"6104015",21:"6104020",
            26:"6105025",27:"6105030"}},
    307: {"title": "Front Wall Outer Panel Assembly", "gif": "282", "section": "FWL",
        "callouts": {1:"5302010",4:"5302621",6:"5302155",9:"5302221",15:"5302160",
            16:"5302622",18:"5302420",20:"5302415",24:"5302801",25:"5302410",
            26:"5302350",29:"5302140",31:"5302172",33:"5302311",35:"5302500",
            37:"5302300",38:"5302171",39:"5302135",45:"5302715",46:"5302720",57:"5302530"}},
    216: {"title": "Front Combination Lamp Assembly", "gif": "197", "section": "LGT",
        "callouts": {4:"3711015",5:"3711020"}},
    363: {"title": "Outside Rearview Mirror Logic Assembly", "gif": "328", "section": "MRR",
        "callouts": {1:"8202015",6:"8202061",7:"8202020",9:"8202062"}},
    366: {"title": "Lower View Mirror Assembly", "gif": "331", "section": "MRR",
        "callouts": {1:"8219010",4:"8219020"}},
    302: {"title": "Wiper Assembly", "gif": "278", "section": "WPR",
        "callouts": {4:"5205010"}},
    304: {"title": "Washer Assembly", "gif": "280", "section": "WPR",
        "callouts": {1:"5207010"}},
    291: {"title": "Level 1 Pedal & Decorative Cover Assembly", "gif": "268", "section": "STP",
        "callouts": {1:"5103010",6:"5103022",7:"5103031",8:"5103053",
            9:"5103052",12:"5103061",13:"5103021"}},
    273: {"title": "Cab Assembly - Painted (Doors, Floor, Panels, Roof)", "gif": "251", "section": "CBY",
        "callouts": {1:"6100015",3:"6106015",4:"6106055",10:"6100020",11:"6106020",
            12:"6106060",16:"5600010",19:"5100010",28:"5201010",31:"5700010",
            44:"5400015",50:"5400020",52:"5401085",59:"5401090"}},
    246: {"title": "Front Fog Lamp Assembly", "gif": "227", "section": "LGT",
        "callouts": {4:"3732020",5:"3732015"}},
    292: {"title": "Engine Side Guard Assembly", "gif": "269", "section": "FND",
        "callouts": {1:"5103612",2:"5103611"}},
    306: {"title": "Front Wall Inner Plate Assembly", "gif": "281", "section": "FWL",
        "callouts": {1:"5300010"}},
    158: {"title": "Frame Logic Assembly", "gif": "145", "section": "CHX",
        "callouts": {27:"2801070",49:"2801090"}},
    334: {"title": "Top Cover Exterior Armour Module", "gif": "306", "section": "DEF",
        "callouts": {3:"5704011",5:"5704021",6:"5704031",10:"5704082",12:"5704081"}},
    361: {"title": "Chassis Air Conditioner Module", "gif": "326", "section": "ACU",
        "callouts": {2:"8105010",14:"8103020"}},
    296: {"title": "Carpet & Threshold Pressing Strip Assembly", "gif": "273", "section": "FND",
        "callouts": {4:"5109111",5:"5109112"}},
}

def base(pn):
    m = re.match(r"\d+", pn or "")
    return m.group(0) if m else None

con = sqlite3.connect(DB)
con.execute("PRAGMA busy_timeout=8000")
con.row_factory = sqlite3.Row
cur = con.cursor()

# base number -> [part ids]  (a base can map to several SKUs: L/R, variants)
bmap = defaultdict(list)
for p in cur.execute("SELECT id,catalogue_pn,inventory_pn FROM part WHERE deleted_at IS NULL"):
    b = base(p["catalogue_pn"]) or base(p["inventory_pn"])
    if b:
        bmap[b].append(p["id"])

# parts already assigned to a rusauto drawing keep that drawing
already = set(r[0] for r in cur.execute(
    "SELECT DISTINCT pdc.part_id FROM part_diagram_callout pdc "
    "JOIN diagram d ON d.id=pdc.diagram_id WHERE d.drawing_key LIKE 'RU%'"))

linked = 0; dia = 0
for node_id, n in NODES.items():
    key = f"RU{node_id}"
    cur.execute(
        "INSERT INTO diagram(drawing_key,title,section_code,make,model,image_path,source) "
        "VALUES(?,?,?,?,?,?,?) ON CONFLICT(drawing_key) DO UPDATE SET title=excluded.title, "
        "section_code=excluded.section_code, image_path=excluded.image_path, "
        "source=excluded.source, updated_at=datetime('now')",
        (key, n["title"], n["section"], "FAW", "JH6", GIF.format(n["gif"]),
         "rusauto43.ru " + NODE.format(node_id)))
    did = cur.execute("SELECT id FROM diagram WHERE drawing_key=?", (key,)).fetchone()["id"]
    dia += 1
    for item_no, pn in n["callouts"].items():
        for pid in bmap.get(base(pn), []):
            if pid in already:
                continue
            cur.execute(
                "INSERT INTO part_diagram_callout(part_id,diagram_id,item_no,is_primary) "
                "VALUES(?,?,?,0) ON CONFLICT(part_id,diagram_id) DO UPDATE SET "
                "item_no=excluded.item_no, is_primary=0, updated_at=datetime('now')",
                (pid, did, item_no))
            already.add(pid); linked += 1

con.commit()
tot = cur.execute("SELECT COUNT(*) FROM part WHERE deleted_at IS NULL").fetchone()[0]
covered = cur.execute("SELECT COUNT(DISTINCT pdc.part_id) FROM part_diagram_callout pdc "
    "JOIN diagram d ON d.id=pdc.diagram_id WHERE d.drawing_key LIKE 'RU%'").fetchone()[0]
print(f"diagrams in catalog : {dia}")
print(f"newly linked        : {linked}")
print(f"total parts covered : {covered} of {tot}")
con.close()
