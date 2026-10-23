// Shell harness: stands in for backend.web.ts (PowerSync SQLite). Fake rows in
// the same shapes staffOrders()/partDetail() return, so the REAL MobileShell
// renders without a sign-in. Never shipped (vite.harness.config.ts only).
const parts = [
  { id: 10, sku: "3732015-1063-C00", name: "Front Fog Lamp L/H", category_code: "LGT", qty_on_hand: 4, bin: "A1", price_cents: 119594, in_stock: true, image: null },
  { id: 11, sku: "CTP-CBY-006-C", name: "Cab mirror", category_code: "CAB", qty_on_hand: 2, bin: "B2", price_cents: 45000, in_stock: true, image: null },
  { id: 12, sku: "X-1", name: "Door hinge", category_code: "CAB", qty_on_hand: 0, bin: null, price_cents: 9900, in_stock: false, image: null },
];
const L = (id: number, part_id: number, qty: number, price: number) => {
  const p = parts.find((x) => x.id === part_id)!;
  return { id, part_id, qty, unit_price_minor: price, sku: p.sku, name: p.name, catalogue_pn: null };
};
const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86400000).toISOString().replace("T", " ").replace("Z", "+00");
const base = { customer_contact: null, customer_phone: null, customer_email: null, location_code: "MAIN", notes: null,
  tax_rate_bps: 1500, client_response: null, client_responded_at: null, unpriced: 0 };
const orders = [
  { ...base, id: 2, number: "RQ-261023-50", status: "quote", created_at: iso(0), fulfilled_at: null, invoice_no: null, invoiced_at: null,
    customer_id: 7, customer_name: "Test Account", stage: "to_price", unpriced: 1, lines: [L(21, 11, 1, 0)] },
  { ...base, id: 6, number: "RQ-261023-51", status: "quote", created_at: iso(0), fulfilled_at: null, invoice_no: null, invoiced_at: null,
    customer_id: 6, customer_name: "Hermans", stage: "with_customer", zoho_estimate_id: "e1", zoho_estimate_number: "QT-000002",
    zoho_estimate_status: "draft", zoho_estimate_total_minor: 159040, zoho_estimate_expiry: "2026-11-22", lines: [L(61, 10, 1, 115600)] },
  { ...base, id: 3, number: "RQ-261021-45", status: "confirmed", created_at: iso(2), fulfilled_at: null, invoice_no: null, invoiced_at: null,
    customer_id: 6, customer_name: "Hermans", cust_on_account: true, zoho_salesorder_id: "y", zoho_salesorder_number: "SO-00012", zoho_so_status: "open",
    stage: "to_pick", lines: [L(31, 10, 2, 115600)] },
  { ...base, id: 1, number: "RQ-261020-43", status: "fulfilled", created_at: iso(3), fulfilled_at: iso(1), invoice_no: null, invoiced_at: null,
    customer_id: 6, customer_name: "Hermans", cust_on_account: true, zoho_salesorder_id: "x", zoho_salesorder_number: "SO-00011", zoho_so_status: "invoiced",
    zoho_invoice_id: "i5", zoho_invoice_number: "INV-000005", zoho_status: "sent", zoho_invoice_total_minor: 132940, zoho_invoice_balance_minor: 132940,
    stage: "fulfilled", lines: [L(11, 10, 1, 115600)] },
  { ...base, id: 4, number: "RQ-260812-01", status: "invoiced", created_at: iso(70), fulfilled_at: iso(70), invoice_no: "26081201", invoiced_at: iso(70),
    customer_id: 6, customer_name: "Hermans", zoho_invoice_number: "DS000001", zoho_status: "paid", stage: "invoiced", lines: [L(41, 12, 4, 9900)] },
  { ...base, id: 5, number: "RQ-261001-02", status: "cancelled", created_at: iso(22), fulfilled_at: null, invoice_no: null, invoiced_at: null,
    customer_id: 7, customer_name: "Test Account", stage: "cancelled", lines: [L(51, 12, 1, 9900)] },
].map((o) => ({ ...o, total_minor: o.lines.reduce((t, l) => t + l.qty * l.unit_price_minor, 0) }));
const detail = (id: number) => {
  const p = parts.find((x) => x.id === id) ?? parts[0];
  return { ...p, locator: null, catalogue_pn: null, inventory_pn: null, brand: null, category_name: "Lights", drawing_no: null, notes: null,
    total_on_hand: p.qty_on_hand, stock: [{ location_id: 1, location_code: "MAIN", on_hand: p.qty_on_hand }], ledger: [], images: [],
    diagram_image: null, diagram_item: null };
};
const R: Record<string, (a: Record<string, unknown>) => unknown> = {
  list_parts: () => parts, list_sections: () => [], list_categories: () => [],
  search_parts: () => parts.map((p) => ({ ...p, brand: null, on_hand: p.qty_on_hand, matched_on: "sku" })),
  part_detail: (a) => detail(Number(a["partId"])),
  staff_orders: () => orders, staff_customers: () => [{ id: 6, name: "Hermans" }, { id: 7, name: "Test Account" }],
  my_requests: () => [], device_audit: () => [],
};
export const webBackend = {
  async call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    const h = R[cmd];
    return (h ? h(args ?? {}) : []) as T;
  },
};
export function isPortedToWeb(cmd: string): boolean { return cmd in R; }
