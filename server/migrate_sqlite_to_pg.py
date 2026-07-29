#!/usr/bin/env python3
"""One-time data migration: live SQLite (fleetview.db) -> Postgres seed SQL.

Reads the desktop app's SQLite DB and emits server/seed.postgres.sql: FK-ordered
INSERTs that preserve every id (so foreign keys survive), self-referencing columns
applied in a second UPDATE pass, and identity-sequence resets at the end.

Run:  python migrate_sqlite_to_pg.py
Then: psql <conn> -f seed.postgres.sql   (or paste into the Supabase SQL editor)
"""
import os, sqlite3, datetime

DB = os.path.join(os.environ["APPDATA"], "net.chinatruckparts.fleetview", "fleetview.db")
OUT = os.path.join(os.path.dirname(__file__), "seed.postgres.sql")

# FK-safe insert order. (lead is new/empty; views + part_search FTS are skipped.)
ORDER = [
    "category", "brand", "part", "part_xref", "vehicle_model", "part_fitment",
    "location", "stock_movement", "stock_policy", "price",
    "customer", "sales_order", "sales_line", "accounting_export", "company",
    "diagram", "part_diagram_callout", "part_image", "part_model", "hotspot",
]
# self-referencing columns: insert NULL, then UPDATE in a 2nd pass
SELF_REF = {"category": ("parent_id",), "part": ("superseded_by",)}
# single-column identity-id tables needing setval after explicit-id inserts
# (composite-PK tables price/stock_policy/part_fitment/part_diagram_callout have no id seq)
IDENTITY_TABLES = [
    "category", "brand", "part", "part_xref", "vehicle_model", "location",
    "stock_movement", "customer", "sales_order", "sales_line",
    "accounting_export", "diagram", "part_image", "part_model", "hotspot",
]


def lit(v):
    if v is None:
        return "NULL"
    if isinstance(v, (int, float)):
        return repr(v)
    s = str(v).replace("'", "''")
    return "'" + s + "'"


def cols(cur, table):
    return [r[1] for r in cur.execute(f"PRAGMA table_info({table})")]


def main():
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    cur = con.cursor()
    out = []
    out.append("-- CTP Core seed: generated %s from %s" %
               (datetime.datetime.now().isoformat(timespec="seconds"), DB))
    out.append("BEGIN;")
    updates = []

    for t in ORDER:
        colnames = cols(cur, t)
        if not colnames:
            out.append(f"-- (skip {t}: not found)")
            continue
        selfcols = SELF_REF.get(t, ())
        rows = list(cur.execute(f"SELECT * FROM {t}"))
        out.append(f"\n-- {t}: {len(rows)} rows")
        for r in rows:
            insert_cols, insert_vals = [], []
            for c in colnames:
                if c in selfcols:
                    continue  # deferred to UPDATE pass
                insert_cols.append(c)
                insert_vals.append(lit(r[c]))
            out.append(
                f'INSERT INTO {t} ({", ".join(insert_cols)}) '
                f'VALUES ({", ".join(insert_vals)});'
            )
            for c in selfcols:
                if r[c] is not None:
                    updates.append(f"UPDATE {t} SET {c}={lit(r[c])} WHERE id={r['id']};")

    if updates:
        out.append("\n-- self-referencing fixups")
        out.extend(updates)

    out.append("\n-- reset identity sequences so new inserts don't collide")
    for t in IDENTITY_TABLES:
        out.append(
            f"SELECT setval(pg_get_serial_sequence('{t}','id'), "
            f"COALESCE((SELECT MAX(id) FROM {t}), 1));"
        )

    out.append("COMMIT;")
    con.close()
    with open(OUT, "w", encoding="utf-8") as f:
        f.write("\n".join(out))
    print("wrote", OUT, "(", len(out), "lines )")


if __name__ == "__main__":
    main()
