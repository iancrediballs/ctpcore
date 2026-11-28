// Public build: an in-browser SQLite (sql.js, bundled) shaped like the local
// database PowerSync fills on a customer's phone, seeded from the
// `public-fixture` edge function (the customer sync bucket: no prices, no cost,
// no stock quantities). The REAL backend.web.ts SQL runs against it, so the
// catalogue screens behave exactly as they do in the app.
import initSqlJs, { type Database } from "sql.js";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import { AppSchema } from "../sync/AppSchema";

type Row = Record<string, unknown>;
const FIXTURE_URL = "https://hkzmydowyiajkbakxfkj.supabase.co/functions/v1/public-fixture";

/** The truck this page is for: <html data-make="FAW" data-model="JH6">. */
export const truck = {
  make: document.documentElement.dataset.make ?? null,
  model: document.documentElement.dataset.model ?? null,
};

export let fixture: Record<string, Row[]> = {};
let db: Database | null = null;
let opening: Promise<void> | null = null;

export function open(): Promise<void> {
  if (!opening) opening = (async () => {
    const qs = new URLSearchParams();
    if (truck.make) qs.set("make", truck.make);
    if (truck.model) qs.set("model", truck.model);
    const [SQL, res] = await Promise.all([
      initSqlJs({ locateFile: () => wasmUrl }),
      fetch(`${FIXTURE_URL}?${qs}`, { headers: { accept: "application/json" } }),
    ]);
    if (!res.ok) throw new Error(`catalogue unavailable (HTTP ${res.status})`);
    fixture = await res.json();
    db = new SQL.Database();
    for (const t of AppSchema.tables) {
      const cols = ["id", ...t.columns.map((c) => c.name)];
      db.run(`CREATE TABLE "${t.name}" (${cols.map((c) => `"${c}"`).join(", ")})`);
      const rows = fixture[t.name] ?? [];
      if (!rows.length) continue;
      const st = db.prepare(`INSERT INTO "${t.name}" (${cols.map((c) => `"${c}"`).join(",")}) VALUES (${cols.map(() => "?").join(",")})`);
      // Like PowerSync: ids and FKs are text, booleans are 0/1, a column the
      // bucket does not send is NULL.
      for (const r of rows) st.run(cols.map((c) => {
        const v = r[c];
        if (v === undefined || v === null) return null;
        if (typeof v === "boolean") return v ? 1 : 0;
        if (c === "id" || c.endsWith("_id")) return String(v);
        if (typeof v === "object") return JSON.stringify(v);
        return v as string | number;
      }));
      st.free();
    }
  })();
  return opening;
}

export function getAll<T = Row>(sql: string, params: unknown[] = []): T[] {
  const res = db!.exec(sql, params.map((p) => (typeof p === "boolean" ? Number(p) : p)) as (string | number | null)[]);
  if (!res.length) return [];
  const { columns, values } = res[0];
  return values.map((v) => Object.fromEntries(columns.map((c, i) => [c, v[i]]))) as T[];
}
