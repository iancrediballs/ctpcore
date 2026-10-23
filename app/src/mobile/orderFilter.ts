// CTP Core — order desk search and filters (Ian, 23 Oct 2026: "filtering in the
// orders menu, by date, by item, by invoice, by quote etc.").
//
// Pure functions over the rows staffOrders() already returns, so they cost no
// queries and no Zoho calls: everything filtered here is on the phone already.
// The stages OVERLAP on purpose — an order can be accepted AND awaiting its
// invoice, or fulfilled AND invoiced — because each one answers a different
// question the desk asks ("what is waiting on accounts?" / "what went out?").

export type FilterOrder = {
  id: number; number: string; status: string; created_at: string;
  fulfilled_at: string | null; invoice_no: string | null;
  customer_id?: number | null; customer_name: string;
  zoho_salesorder_id?: string | null; zoho_salesorder_number?: string | null;
  zoho_invoice_id?: string | null; zoho_invoice_number?: string | null; zoho_status?: string | null;
  zoho_invoice_total_minor?: number | null; zoho_invoice_balance_minor?: number | null;
  zoho_estimate_number?: string | null;
  lines: { part_id: number; sku: string; name: string; catalogue_pn?: string | null }[];
};

export type Range = "all" | "today" | "7d" | "month" | "custom";
export type StageKey = "quote" | "accepted" | "awaiting_invoice" | "invoiced" | "fulfilled" | "cancelled";

export type OrderFilter = {
  q: string;
  range: Range; from: string; to: string;          // from/to: yyyy-mm-dd, custom only
  stage: StageKey | null;
  customer: string | null;                         // customer_id, or the name when there is no id
  part: number | null;
  invoice: "any" | "has" | "none";
  paid: "any" | "paid" | "unpaid";
};

export const EMPTY_FILTER: OrderFilter = {
  q: "", range: "all", from: "", to: "", stage: null, customer: null, part: null, invoice: "any", paid: "any",
};

export const STAGE_LABEL: Record<StageKey, string> = {
  quote: "Quote", accepted: "Accepted", awaiting_invoice: "Awaiting invoice",
  invoiced: "Invoiced", fulfilled: "Fulfilled", cancelled: "Cancelled",
};

export const RANGE_LABEL: Record<Range, string> = {
  all: "Any date", today: "Today", "7d": "Last 7 days", month: "This month", custom: "Custom",
};

/** Postgres text timestamps arrive as "2026-10-20 12:13:00.5+00"; Date.parse
 *  wants the T and a full offset. */
export function parseTs(s: string | null | undefined): number {
  if (!s) return NaN;
  let t = s.trim().replace(" ", "T");
  t = t.replace(/([+-]\d\d)$/, "$1:00");
  return Date.parse(t);
}

export const hasInvoice = (o: FilterOrder): boolean =>
  !!(o.zoho_invoice_id || o.zoho_invoice_number || o.invoice_no || o.status === "invoiced");

/** Paid = Zoho says so, or the read-back balance is zero on a non-zero invoice. */
export const isPaid = (o: FilterOrder): boolean =>
  hasInvoice(o) && (o.zoho_status === "paid"
    || (o.zoho_invoice_balance_minor === 0 && (o.zoho_invoice_total_minor ?? 0) > 0));

export function inStage(o: FilterOrder, s: StageKey): boolean {
  switch (s) {
    case "quote": return o.status === "quote";
    case "accepted": return o.status === "confirmed";
    // accepted or goods out, and accounts have not invoiced it yet
    case "awaiting_invoice": return (o.status === "confirmed" || o.status === "fulfilled") && !hasInvoice(o);
    case "invoiced": return o.status !== "cancelled" && hasInvoice(o);
    case "fulfilled": return o.status === "fulfilled" || o.status === "invoiced" || (!!o.fulfilled_at && o.status !== "cancelled");
    case "cancelled": return o.status === "cancelled";
  }
}

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
const DAY = 86_400_000;

/** [from, to) in ms for the range, local time. null = no bound. */
export function rangeBounds(f: OrderFilter, now = new Date()): [number | null, number | null] {
  const today = startOfDay(now);
  switch (f.range) {
    case "all": return [null, null];
    case "today": return [today, today + DAY];
    case "7d": return [today - 6 * DAY, today + DAY];
    case "month": return [new Date(now.getFullYear(), now.getMonth(), 1).getTime(), today + DAY];
    case "custom": {
      const a = f.from ? Date.parse(f.from + "T00:00:00") : NaN;
      const b = f.to ? Date.parse(f.to + "T00:00:00") : NaN;
      return [Number.isFinite(a) ? a : null, Number.isFinite(b) ? b + DAY : null];
    }
  }
}

const norm = (s: string) => s.toLowerCase();
const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Search: RQ number, Zoho SO / invoice / estimate number, CTP invoice no.,
 *  customer, and any line's SKU, catalogue number or name. "so 11", "SO-00011"
 *  and "so00011" all find SO-00011 — separators are ignored for numbers. */
export function matchesQuery(o: FilterOrder, q: string): boolean {
  const term = q.trim();
  if (!term) return true;
  const words = norm(term).split(/\s+/).filter(Boolean);
  const hay = [
    o.number, o.zoho_salesorder_number, o.zoho_invoice_number, o.zoho_estimate_number, o.invoice_no,
    o.customer_name,
    ...o.lines.flatMap((l) => [l.sku, l.catalogue_pn, l.name]),
  ].filter((x): x is string => !!x);
  const text = norm(hay.join(" \u0001 "));
  if (words.every((w) => text.includes(w))) return true;
  // whole term without separators against each number-like field
  const c = compact(term);
  return c.length >= 2 && hay.some((h) => compact(h).includes(c));
}

export const customerKey = (o: FilterOrder): string =>
  o.customer_id != null ? String(o.customer_id) : "n:" + o.customer_name;

export function applyFilter<T extends FilterOrder>(rows: T[], f: OrderFilter, now = new Date()): T[] {
  const [lo, hi] = rangeBounds(f, now);
  return rows.filter((o) => {
    if (lo != null || hi != null) {
      const t = parseTs(o.created_at);
      if (!Number.isFinite(t)) return false;
      if (lo != null && t < lo) return false;
      if (hi != null && t >= hi) return false;
    }
    if (f.stage && !inStage(o, f.stage)) return false;
    if (f.customer && customerKey(o) !== f.customer) return false;
    if (f.part != null && !o.lines.some((l) => l.part_id === f.part)) return false;
    if (f.invoice === "has" && !hasInvoice(o)) return false;
    if (f.invoice === "none" && hasInvoice(o)) return false;
    if (f.paid === "paid" && !isPaid(o)) return false;
    if (f.paid === "unpaid" && (!hasInvoice(o) || isPaid(o))) return false;
    return matchesQuery(o, f.q);
  });
}

export const isFiltering = (f: OrderFilter): boolean =>
  f.q.trim() !== "" || f.range !== "all" || f.stage != null || f.customer != null
  || f.part != null || f.invoice !== "any" || f.paid !== "any";

/** The session's filter. sessionStorage: survives a reload, gone when the tab
 *  or app is closed — "remembered for the session", not forever. */
const KEY = "ctp-order-filter.v1";
export function loadFilter(): OrderFilter {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return EMPTY_FILTER;
    const v = JSON.parse(raw) as Partial<OrderFilter>;
    return { ...EMPTY_FILTER, ...v };
  } catch { return EMPTY_FILTER; }
}
export function saveFilter(f: OrderFilter): void {
  try { sessionStorage.setItem(KEY, JSON.stringify(f)); } catch { /* private mode: lives in memory */ }
}
