// Live-data harness: an in-browser SQLite (sql.js, from the CDN) shaped like
// PowerSync's local DB and seeded from fixture.<role>.json — a dump of live
// Postgres taken with the columns each role's sync bucket delivers. The REAL
// backend.web.ts SQL runs against it. Dev only (vite.livedata.config.ts).
import { AppSchema } from "../../sync/AppSchema";

type Row = Record<string, unknown>;
type SqlDb = {
  run(sql: string, params?: unknown[]): void;
  exec(sql: string, params?: unknown[]): { columns: string[]; values: unknown[][] }[];
};
declare global { interface Window { initSqlJs?: (o: { locateFile: (f: string) => string }) => Promise<{ Database: new () => SqlDb }> } }

export const role = new URLSearchParams(location.search).get("role") ?? "admin";
const fixtureRole = role === "customer" ? "customer" : "staff";
const CDN = "https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/";

function loadScript(src: string): Promise<void> {
  return new Promise((ok, bad) => {
    const s = document.createElement("script");
    s.src = src; s.onload = () => ok(); s.onerror = () => bad(new Error("could not load " + src));
    document.head.appendChild(s);
  });
}

export let fixture: Record<string, Row[]> = {};
let db: SqlDb | null = null;
let opening: Promise<void> | null = null;

export function open(): Promise<void> {
  if (!opening) opening = (async () => {
    await loadScript(CDN + "sql-wasm.js");
    const SQL = await window.initSqlJs!({ locateFile: (f) => CDN + f });
    fixture = await (await fetch(`/src/dev/live/fixture.${fixtureRole}.json`)).json();
    db = new SQL.Database();
    for (const t of AppSchema.tables) {
      const cols = ["id", ...t.columns.map((c) => c.name)];
      db.run(`CREATE TABLE "${t.name}" (${cols.map((c) => `"${c}"`).join(", ")})`);
      // Like PowerSync: a column the bucket does not send is simply NULL.
      for (const r of fixture[t.name] ?? []) {
        db.run(`INSERT INTO "${t.name}" (${cols.map((c) => `"${c}"`).join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
          cols.map((c) => (r[c] === undefined ? null : r[c])));
      }
    }
    console.info("[live harness]", fixtureRole, Object.fromEntries(Object.entries(fixture).map(([k, v]) => [k, v.length])));
  })();
  return opening;
}

export function getAll<T = Row>(sql: string, params: unknown[] = []): T[] {
  const res = db!.exec(sql, params.map((p) => (typeof p === "boolean" ? Number(p) : p)));
  if (!res.length) return [];
  const { columns, values } = res[0];
  return values.map((v) => Object.fromEntries(columns.map((c, i) => [c, v[i]]))) as T[];
}
