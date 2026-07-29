# CTP Core — Parts Catalogue generator
# Reads the LIVE app database + project images, emits a self-contained,
# print-ready "coffee-table" HTML catalogue (open in browser -> Print -> Save as PDF).
# Clean / customer-safe: CTP SKU + name + photo, diagram section openers. No OEM PNs, no prices.
import os, sys, sqlite3, base64, io, html, datetime

try:
    from PIL import Image
    HAVE_PIL = True
except Exception:
    HAVE_PIL = False

ROOT = r"C:\Users\Rick\Claude\Projects\China Truck Parts ERP"
PUBLIC = os.path.join(ROOT, "app", "public")
DB = os.path.join(os.environ["APPDATA"], "net.chinatruckparts.fleetview", "fleetview.db")
OUT = os.path.join(ROOT, "CTP_Parts_Catalogue.html")

# customer-clean by default; pass --status and/or --notes for an internal version
SHOW_STATUS = ('--status' in sys.argv)
SHOW_NOTES  = ('--notes' in sys.argv)

# functional-group order + display names (matches the 16 JH6 sections)
ORDER = ['BMP','CHX','LGT','SUS','FND','TBX','INT','FWL','DOR','MRR','STP','MUD','WPR','CBY','DEF','ACU']

# "When to replace" service tip per category (keeps the brochure useful + engaging)
TIPS = {
 'BMP': "Replace bumper brackets if you spot cracks, bent mounts, or the bumper sits unevenly after a knock — a misaligned bumper strains the mounts and lights.",
 'CHX': "Check crossmember welds and spring brackets at every service. Cracks, elongated bolt holes or play in the bushings mean it's time to renew.",
 'LGT': "Swap a combination or fog lamp when moisture lingers inside the lens, the housing yellows, or output dims — damp corrodes the contacts fast.",
 'SUS': "A bouncy, noisy ride or a cab sitting low points to tired air springs/shocks. Replace in pairs so the cab sits level.",
 'FND': "Renew fenders and steps when cracked or corroded — a loose step is a safety hazard and an instant roadworthy failure.",
 'TBX': "Re-seal or replace toolbox covers once the seal perishes and water gets in; a warped cover won't latch and rattles on rough roads.",
 'INT': "Interior trim and guards go brittle under UV — replace when clips snap or panels no longer seat flush.",
 'FWL': "If the front wall panel won't stay up or drops slowly, the gas strut has lost pressure and should be replaced.",
 'DOR': "Sagging doors, sticky latches or a slow/noisy window point to worn hinges, limiters or the lift module.",
 'MRR': "Replace a mirror assembly when the glass won't hold adjustment, vibrates, or the heat/electric-fold stops working.",
 'STP': "A bent or cracked step is the #1 daily wear point — replace it immediately; it's a slip risk and inspection fail.",
 'MUD': "Torn or flapping mudguards throw stones and fail inspections — renew the guard and brackets together.",
 'WPR': "Streaking, chatter or missed patches mean new blades. A wiper that parks wrong or stalls needs the linkage or motor checked.",
 'CBY': "Surface rust at panel seams and the floor is the early warning — treat or replace panels before it spreads.",
 'DEF': "A loose or cracked roof deflector whistles at speed and costs fuel — refit or replace promptly.",
 'ACU': "Weak cooling usually means a tired or leaking condenser — replace it to protect the compressor from overload.",
}

# rotating "Did you know" facts
FACTS = [
 "FAW built China's first truck, the Jiefang CA10, in 1956 — 'Jiefang' means 'Liberation'.",
 "A fully loaded heavy truck can weigh 40+ tonnes — over 25 times a typical car.",
 "The JH6 is FAW's flagship heavy-duty long-haul tractor, engineered for high power over long distances.",
 "Greased spring pins and bushings can outlast neglected ones by years — a few minutes of service pays off.",
 "Correct tyre pressure across a fleet can trim fuel use by several percent.",
 "A clean radiator and condenser core can noticeably lower engine temps during summer hauling.",
 "Genuine cross-referenced parts mean the right fit first time — less downtime, fewer returns.",
 "Catching worn brackets early prevents the expensive failures they cause downstream.",
]

def esc(s):
    return html.escape(str(s)) if s is not None else ""

def data_uri(relpath, maxw, as_jpeg=True):
    if not relpath:
        return None
    fp = os.path.join(PUBLIC, relpath.replace('/', os.sep))
    if not os.path.exists(fp):
        return None
    try:
        if HAVE_PIL:
            im = Image.open(fp)
            if im.mode in ('P', 'RGBA', 'LA'):
                bg = Image.new('RGB', im.size, (255, 255, 255))
                im = im.convert('RGBA'); bg.paste(im, mask=im.split()[-1]); im = bg
            else:
                im = im.convert('RGB')
            if im.width > maxw:
                nh = int(im.height * maxw / im.width)
                im = im.resize((maxw, nh), Image.LANCZOS)
            buf = io.BytesIO(); im.save(buf, 'JPEG', quality=82, optimize=True)
            return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()
        else:
            b = open(fp, 'rb').read()
            mime = 'image/png' if fp.lower().endswith('png') else 'image/jpeg'
            return "data:%s;base64,%s" % (mime, base64.b64encode(b).decode())
    except Exception as e:
        print("  img fail", relpath, e)
        return None

def png_uri(relpath, maxw):
    fp = os.path.join(PUBLIC, relpath.replace('/', os.sep))
    if not os.path.exists(fp):
        return None
    try:
        if HAVE_PIL:
            im = Image.open(fp).convert('RGBA')
            if im.width > maxw:
                nh = int(im.height * maxw / im.width)
                im = im.resize((maxw, nh), Image.LANCZOS)
            buf = io.BytesIO(); im.save(buf, 'PNG'); data = buf.getvalue()
        else:
            data = open(fp, 'rb').read()
        return "data:image/png;base64," + base64.b64encode(data).decode()
    except Exception:
        return None

LOGO_LIGHT = png_uri("assets/brand/ctp_logo_light.png", 1100)

con = sqlite3.connect(DB); con.row_factory = sqlite3.Row; cur = con.cursor()
catname = {r['code']: r['name'] for r in cur.execute("SELECT code, name FROM category")}

present = []
for c in ORDER:
    if cur.execute("SELECT 1 FROM part_detail WHERE category_code=? AND sku LIKE 'CTP-%' LIMIT 1", (c,)).fetchone():
        present.append(c)

sections = []
total_parts = 0
total_photos = 0
for c in present:
    opener = cur.execute(
        "SELECT image_path FROM diagram WHERE section_code=? AND drawing_key LIKE 'SEC%' AND deleted_at IS NULL LIMIT 1",
        (c,)).fetchone()
    opener_uri = data_uri(opener['image_path'], 1500) if opener else None
    parts = []
    for r in cur.execute(
        "SELECT sku, name, side, primary_image, match_status, notes FROM part_detail WHERE category_code=? AND sku LIKE 'CTP-%' ORDER BY sku", (c,)):
        uri = data_uri(r['primary_image'], 900)
        if uri: total_photos += 1
        parts.append({'sku': r['sku'], 'name': r['name'], 'side': r['side'], 'img': uri,
                      'status': r['match_status'], 'notes': r['notes']})
        total_parts += 1
    sections.append({'code': c, 'name': catname.get(c, c), 'opener': opener_uri, 'parts': parts})
    print("  section", c, catname.get(c, c), "->", len(parts), "parts")

print("sections:", len(sections), "parts:", total_parts, "photos embedded:", total_photos)

SIDE = {'L': 'Left Hand', 'R': 'Right Hand', 'C': 'Centre', 'B': 'Both Sides'}
today = datetime.date.today().strftime("%B %Y")

CSS = """
@page { size: A4 portrait; margin: 0; }
* { box-sizing: border-box; margin: 0; padding: 0; }
:root { --navy:#0d2148; --blue:#1e3a6e; --red:#c8102e; --ink:#1a2238; --muted:#6a7790; --line:#e2e8f2; --paper:#fcfdff; }
html,body { background:#525a66; }
body { font-family: Georgia, 'Times New Roman', serif; color: var(--ink); -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.page { width:210mm; min-height:297mm; background:var(--paper); margin:0 auto 10mm; position:relative; overflow:hidden;
  page-break-after:always; box-shadow:0 2px 18px rgba(0,0,0,.25); }
.sans { font-family:'Helvetica Neue', Arial, sans-serif; }
.pad { padding: 24mm 22mm; }

/* cover */
.cover { background:var(--navy); color:#fff; height:297mm; display:flex; flex-direction:column; justify-content:center; padding:30mm; }
.cover .mark { font-family:'Helvetica Neue',Arial,sans-serif; letter-spacing:.5em; font-size:12pt; color:#9fb3d6; font-weight:700; }
.coverlogo { height:34mm; width:auto; margin-bottom:10mm; }
.cover h1 { font-family:'Helvetica Neue',Arial,sans-serif; font-weight:800; font-size:54pt; line-height:1.02; margin:10mm 0 6mm; letter-spacing:-.5pt; }
.cover .rule { width:54mm; height:3px; background:var(--red); margin:6mm 0; }
.cover .sub { font-size:16pt; color:#cdd9ec; font-style:italic; }
.cover .meta { margin-top:auto; font-family:'Helvetica Neue',Arial,sans-serif; font-size:10.5pt; letter-spacing:.18em; color:#8ea3c6; text-transform:uppercase; }

/* toc */
.toc h2 { font-family:'Helvetica Neue',Arial,sans-serif; font-size:24pt; color:var(--navy); margin-bottom:2mm; }
.toc .kick { color:var(--red); font-family:'Helvetica Neue',Arial,sans-serif; letter-spacing:.3em; font-size:9pt; font-weight:700; text-transform:uppercase; }
.toc .rule { height:2px; background:var(--navy); margin:5mm 0 8mm; }
.tocrow { display:flex; align-items:baseline; gap:10px; padding:3.4mm 0; border-bottom:1px solid var(--line); }
.tocrow .n { font-family:'Helvetica Neue',Arial,sans-serif; color:var(--red); font-weight:800; width:14mm; font-size:13pt; }
.tocrow .t { font-size:14pt; color:var(--ink); flex:1; }
.tocrow .c { font-family:'Helvetica Neue',Arial,sans-serif; color:var(--muted); font-size:10pt; }

/* section opener */
.opener { background:var(--navy); color:#fff; height:297mm; display:flex; flex-direction:column; padding:26mm; }
.opener .n { font-family:'Helvetica Neue',Arial,sans-serif; font-size:64pt; font-weight:800; color:rgba(255,255,255,.16); line-height:1; }
.opener h2 { font-family:'Helvetica Neue',Arial,sans-serif; font-size:34pt; font-weight:800; margin-top:-6mm; }
.opener .rule { width:46mm; height:3px; background:var(--red); margin:5mm 0; }
.opener .frame { flex:1; margin-top:8mm; background:#fff; border-radius:3px; display:flex; align-items:center; justify-content:center; overflow:hidden; }
.opener .frame img { max-width:100%; max-height:100%; object-fit:contain; }
.opener .cap { font-family:'Helvetica Neue',Arial,sans-serif; font-size:9.5pt; letter-spacing:.16em; text-transform:uppercase; color:#9fb3d6; margin-top:5mm; }

/* parts grid */
.secthead { display:flex; align-items:baseline; gap:8px; border-bottom:2px solid var(--navy); padding-bottom:3mm; margin-bottom:7mm; }
.secthead .code { font-family:'Helvetica Neue',Arial,sans-serif; font-weight:800; color:var(--red); font-size:12pt; }
.secthead .nm { font-family:'Helvetica Neue',Arial,sans-serif; font-weight:700; color:var(--navy); font-size:16pt; }
.secthead .ct { margin-left:auto; color:var(--muted); font-family:'Helvetica Neue',Arial,sans-serif; font-size:9.5pt; }
.grid { display:grid; grid-template-columns:1fr 1fr; gap:10mm 9mm; }
.card { break-inside:avoid; }
.card .imwrap { aspect-ratio:4/3; background:#f3f6fb; border:1px solid var(--line); border-radius:3px;
  display:flex; align-items:center; justify-content:center; overflow:hidden; }
.card .imwrap img { width:100%; height:100%; object-fit:cover; }
.card .ph { color:#aeb8cc; text-align:center; font-family:'Helvetica Neue',Arial,sans-serif; }
.card .ph .mono { font-size:8.5pt; letter-spacing:.2em; }
.card .ph .big { font-size:20pt; font-weight:800; color:#c7d0e0; letter-spacing:.1em; }
.card .sku { font-family:'Helvetica Neue',Arial,sans-serif; font-weight:800; color:var(--navy); font-size:11pt; margin-top:3mm; letter-spacing:.02em; }
.card .nm { font-size:11.5pt; color:var(--ink); margin-top:1mm; line-height:1.25; }
.card .side { display:inline-block; margin-top:1.5mm; font-family:'Helvetica Neue',Arial,sans-serif; font-size:7.5pt;
  letter-spacing:.12em; text-transform:uppercase; color:var(--muted); border:1px solid var(--line); border-radius:10px; padding:1px 7px; }
.cstatus { display:inline-block; margin:1.5mm 0 0 5px; font-family:'Helvetica Neue',Arial,sans-serif; font-size:7.5pt;
  font-weight:700; letter-spacing:.06em; border-radius:9px; padding:1px 7px; }
.cstatus.ok { color:#1c5e38; background:#e8f6ee; }
.cstatus.warn { color:#7a5b00; background:#fef5ec; }
.cnote { margin-top:1.5mm; font-size:8.5pt; font-style:italic; color:#7a5b00; line-height:1.3; }
.foot { position:absolute; bottom:10mm; left:22mm; right:22mm; display:flex; justify-content:space-between;
  font-family:'Helvetica Neue',Arial,sans-serif; font-size:8pt; letter-spacing:.16em; text-transform:uppercase; color:var(--muted); }
.foot .b { color:var(--navy); font-weight:700; }
.introp { display:flex; flex-direction:column; justify-content:center; }
.ikick { color:var(--red); font-family:'Helvetica Neue',Arial,sans-serif; letter-spacing:.3em; font-size:10pt; font-weight:700; text-transform:uppercase; }
.ititle { font-family:'Helvetica Neue',Arial,sans-serif; font-size:30pt; font-weight:800; color:var(--navy); margin-top:3mm; }
.rule2 { width:46mm; height:3px; background:var(--red); margin:6mm 0; }
.ip { font-size:13pt; line-height:1.6; color:#33415c; max-width:150mm; }
.facts3 { display:flex; gap:16mm; margin-top:18mm; }
.f3 .fn { font-family:'Helvetica Neue',Arial,sans-serif; font-size:30pt; font-weight:800; color:var(--navy); }
.f3 .fl { font-size:9.5pt; color:var(--muted); letter-spacing:.04em; text-transform:uppercase; margin-top:1mm; }
.tipstrip { display:grid; grid-template-columns:1fr 1fr; gap:8mm; margin-top:9mm; }
.tipbox, .factbox { border-radius:6px; padding:6mm 7mm; }
.tipbox { background:#fef5ec; border-left:3px solid var(--variant); }
.factbox { background:#eaf1fb; border-left:3px solid var(--blue); }
.tlabel { font-family:'Helvetica Neue',Arial,sans-serif; font-size:8.5pt; font-weight:800; letter-spacing:.1em; text-transform:uppercase; color:var(--navy); margin-bottom:2mm; }
.tipbox .tlabel { color:#b5651d; }
.ttext { font-size:10.5pt; line-height:1.45; color:#33415c; }
@media print { body{background:#fff;} .page{box-shadow:none; margin:0;} }
"""

def card_html(p):
    if p['img']:
        im = '<div class="imwrap"><img src="%s" alt=""></div>' % p['img']
    else:
        im = ('<div class="imwrap"><div class="ph"><div class="big">CTP</div>'
              '<div class="mono">IMAGE TO FOLLOW</div></div></div>')
    side = ('<span class="side">%s</span>' % SIDE.get(p['side'], p['side'])) if p['side'] else ''
    extra = ''
    if SHOW_STATUS and p.get('status'):
        extra += '<span class="cstatus %s">%s</span>' % ('ok' if p['status'] == 'MATCHED' else 'warn', esc(p['status']))
    if SHOW_NOTES and p.get('notes'):
        extra += '<div class="cnote">%s</div>' % esc(p['notes'])
    return ('<div class="card">%s<div class="sku">%s</div><div class="nm">%s</div>%s%s</div>'
            % (im, esc(p['sku']), esc(p['name']), side, extra))

pages = []
# cover
cover_mark = ('<img class="coverlogo" src="%s" alt="China Truck Parts">' % LOGO_LIGHT) if LOGO_LIGHT else '<div class="mark">CHINA TRUCK PARTS</div>'
pages.append('<div class="page cover">' + cover_mark +
             '<h1>Parts<br>Catalogue</h1><div class="rule"></div>'
             '<div class="sub">FAW JH6 6&times;4 &mdash; Heavy-Duty Cab &amp; Body Components</div>'
             '<div class="meta">Shipment 01 &nbsp;&bull;&nbsp; %s</div></div>' % today)

# intro / about page
pages.append(
    '<div class="page"><div class="pad introp">'
    '<div class="ikick">FAW JH6 6&times;4</div>'
    '<h2 class="ititle">Genuine Cab &amp; Body Parts</h2><div class="rule2"></div>'
    '<p class="ip">Every part in this catalogue is logged, photographed and cross-referenced against the '
    'original FAW drawings &mdash; so you get the right part, first time. Find it by our SKU, by the OEM number, '
    'or simply point to the exploded diagram at the start of each section.</p>'
    '<div class="facts3">'
    '<div class="f3"><div class="fn">1953</div><div class="fl">FAW building trucks since</div></div>'
    '<div class="f3"><div class="fn">%d</div><div class="fl">parts catalogued</div></div>'
    '<div class="f3"><div class="fn">%d</div><div class="fl">assemblies, fully diagrammed</div></div>'
    '</div></div></div>' % (total_parts, len(sections)))

# toc
toc_rows = "".join(
    '<div class="tocrow"><span class="n">%02d</span><span class="t">%s</span>'
    '<span class="c">%d parts</span></div>' % (i + 1, esc(s['name']), len(s['parts']))
    for i, s in enumerate(sections))
pages.append('<div class="page"><div class="pad toc"><div class="kick">Contents</div>'
             '<h2>Catalogue Index</h2><div class="rule"></div>%s'
             '<div style="margin-top:10mm;color:var(--muted);font-family:Helvetica Neue,Arial,sans-serif;font-size:9.5pt;">'
             '%d parts across %d functional groups</div></div></div>' % (toc_rows, total_parts, len(sections)))

# sections
for i, s in enumerate(sections):
    if s['opener']:
        frame = '<div class="frame"><img src="%s" alt=""></div>' % s['opener']
    else:
        frame = '<div class="frame" style="background:#0f2a52;"></div>'
    pages.append('<div class="page opener"><div class="n">%02d</div><h2>%s</h2><div class="rule"></div>'
                 '%s<div class="cap">Exploded view &mdash; %s</div></div>'
                 % (i + 1, esc(s['name']), frame, esc(s['name'])))
    cards = "".join(card_html(p) for p in s['parts'])
    tip = TIPS.get(s['code'], '')
    fact = FACTS[i % len(FACTS)]
    strip = '<div class="tipstrip">'
    if tip:
        strip += '<div class="tipbox"><div class="tlabel">&#9888; When to replace</div><div class="ttext">%s</div></div>' % esc(tip)
    strip += '<div class="factbox"><div class="tlabel">&#9733; Did you know</div><div class="ttext">%s</div></div>' % esc(fact)
    strip += '</div>'
    pages.append('<div class="page"><div class="pad"><div class="secthead"><span class="code">%s</span>'
                 '<span class="nm">%s</span><span class="ct">%d parts</span></div>'
                 '<div class="grid">%s</div>%s</div>'
                 '<div class="foot"><span class="b">CHINA TRUCK PARTS</span><span>FAW JH6 &mdash; Parts Catalogue</span></div></div>'
                 % (esc(s['code']), esc(s['name']), len(s['parts']), cards, strip))

doc = ('<!doctype html><html><head><meta charset="utf-8"><title>CTP Parts Catalogue</title>'
       '<style>%s</style></head><body>%s</body></html>' % (CSS, "".join(pages)))
open(OUT, 'w', encoding='utf-8').write(doc)
print("WROTE", OUT, "(%d KB)" % (len(doc.encode('utf-8')) // 1024))
