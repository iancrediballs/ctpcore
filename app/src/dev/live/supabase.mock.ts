// Live-data harness: stands in for sync/supabase.ts. The online reads the
// catalogue makes (diagram + hotspots, embedded part and photos) are answered
// from the fixture with the same filters; everything else returns empty.
import { open, fixture } from "./db";

type Row = Record<string, unknown>;
type Filter = (r: Row) => boolean;

function embedHotspot(h: Row): Row {
  const part = (fixture.part ?? []).find((p) => String(p.id) === String(h.part_id));
  const imgs = (fixture.part_image ?? []).filter((i) => String(i.part_id) === String(h.part_id));
  return { ...h, id: Number(h.id), diagram_id: Number(h.diagram_id), part_id: h.part_id == null ? null : Number(h.part_id),
    part: part ? { sku: part.sku, name: part.name, deleted_at: part.deleted_at, part_image: imgs } : null };
}

function builder(table: string) {
  const filters: Filter[] = [];
  let order: string | null = null;
  const run = async (): Promise<Row[]> => {
    await open();
    let rows = (fixture[table] ?? []).filter((r) => filters.every((f) => f(r)));
    if (table === "hotspot") rows = rows.map(embedHotspot);
    if (table === "diagram") rows = rows.map((d) => ({ ...d, id: Number(d.id) }));
    if (order) rows = [...rows].sort((a, b) => Number(a[order!]) - Number(b[order!]));
    return rows;
  };
  const b = {
    select: () => b,
    eq: (c: string, v: unknown) => { filters.push((r) => String(r[c]) === String(v)); return b; },
    is: (c: string, v: unknown) => { filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return b; },
    not: () => b, in: () => b, neq: () => b, gte: () => b, lte: () => b, limit: () => b,
    order: (c: string) => { order = c; return b; },
    maybeSingle: async () => ({ data: (await run())[0] ?? null, error: null }),
    single: async () => ({ data: (await run())[0] ?? null, error: null }),
    then: (ok: (v: { data: Row[]; error: null }) => unknown, bad?: (e: unknown) => unknown) =>
      run().then((data) => ok({ data, error: null }), bad),
  };
  return b;
}

export const supabase = {
  from: (t: string) => builder(t),
  rpc: async () => ({ data: null, error: null }),
  functions: { invoke: async () => ({ data: null, error: { message: "[live harness] offline" } }) },
  storage: { from: () => ({ upload: async () => ({ error: { message: "read-only" } }), createSignedUrl: async () => ({ data: null, error: null }) }) },
  auth: { getSession: async () => ({ data: { session: null } }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) },
};
