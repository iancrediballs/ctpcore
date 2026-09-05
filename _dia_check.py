import os, sqlite3
DB = os.path.join(os.environ["APPDATA"], "net.chinatruckparts.fleetview", "fleetview.db")
ASSET = os.path.join(os.path.dirname(os.path.abspath(__file__)), "app", "public", "assets", "diagrams")
con = sqlite3.connect(DB); con.row_factory = sqlite3.Row; cur = con.cursor()
print("=== part_detail diagram resolution (sample) ===")
rows = cur.execute("SELECT sku, diagram_image, diagram_item FROM part_detail WHERE diagram_image IS NOT NULL ORDER BY sku LIMIT 12").fetchall()
for r in rows:
    p = r["diagram_image"] or ""
    fn = os.path.basename(p)
    exists = os.path.exists(os.path.join(ASSET, fn)) if fn else False
    print(f'  {r["sku"]:<15} item={r["diagram_item"]}  {p}   file_exists={exists}')
print("\n=== source breakdown across ALL parts ===")
own = cur.execute("SELECT COUNT(*) FROM part_detail WHERE diagram_image LIKE 'assets/diagrams/Drw_%' OR diagram_image LIKE 'assets/diagrams/Section_%'").fetchone()[0]
ru  = cur.execute("SELECT COUNT(*) FROM part_detail WHERE diagram_image LIKE '%/ru/%' OR diagram_image LIKE '%rusauto%'").fetchone()[0]
none= cur.execute("SELECT COUNT(*) FROM part_detail WHERE diagram_image IS NULL").fetchone()[0]
print(f"  own_drawing={own}  rusauto={ru}  none={none}")
print("\n=== files present in app/public/assets/diagrams ===")
try:
    files = os.listdir(ASSET)
    drw = [f for f in files if f.startswith("Drw_")]
    sec = [f for f in files if f.startswith("Section_") or f.startswith("section_")]
    print(f"  total files={len(files)}  Drw_*={len(drw)}  Section/section_*={len(sec)}")
    print("  sample:", sorted(files)[:8])
except Exception as e:
    print("  ERR listing:", e)
con.close()
