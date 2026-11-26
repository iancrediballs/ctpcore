// CTP Core — 0097: back-order stock from Zoho purchase orders ticked "Back order" (cf_back_order).
// Shared by zoho-back-orders (the sync itself) and zoho-push (the Receive list's back-order badge).
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { zohoInv, type Logger } from "../_shared/zoho.ts";

/** A PO whose goods have not all arrived. Status alone misses one that is already BILLED
 *  but not received (PO-00003, 25 Nov: status "billed", received_status "to_be_received"). */
// deno-lint-ignore no-explicit-any
export const stillToReceive = (p: any) => {
  const st = String(p.status ?? ""), rs = String(p.received_status ?? "");
  if (["draft", "cancelled", "closed", "received"].includes(st)) return false;
  return rs ? rs !== "received" : ["open", "issued", "partially_received"].includes(st);
};

// deno-lint-ignore no-explicit-any
export const isBackOrder = (po: any) => {
  const h = po?.custom_field_hash?.cf_back_order_unformatted ?? po?.custom_field_hash?.cf_back_order;
  if (h != null) return h === true || String(h).toLowerCase() === "true";
  // deno-lint-ignore no-explicit-any
  const f = ((po?.custom_fields ?? []) as any[]).find((c) => c.api_name === "cf_back_order" || /^back\s*order$/i.test(String(c.label ?? "")));
  return f ? f.value === true || String(f.value).toLowerCase() === "true" : false;
};

// deno-lint-ignore no-explicit-any
export const lineReceived = (l: any) => Number(l.quantity_received ?? l.quantity_marked_as_received ?? 0);

/** Every unreceived line of every open Zoho PO → zoho_back_order_line (replaced in full); back_order marks
 *  the POs ticked "Back order" (= In transit). All of them together = On purchase order (0098).
 *  Skipped when read less than `minAgeMs` ago (10 min on the schedule, 1 min for webhooks, 0 = always). */
export async function backOrderSync(db: SupabaseClient, log: Logger, minAgeMs: number) {
  const { data: cfg } = await db.from("zoho_config").select("back_orders_synced_at").eq("id", 1).maybeSingle();
  const last = cfg?.back_orders_synced_at ? new Date(cfg.back_orders_synced_at).getTime() : 0;
  if (minAgeMs > 0 && Date.now() - last < minAgeMs) return { skipped: `back orders read less than ${Math.round(minAgeMs / 60_000) || 1} minute(s) ago` };
  // deno-lint-ignore no-explicit-any
  const list: any[] = [];
  for (let page = 1; page <= 10; page++) {
    const b = await zohoInv("GET", "/purchaseorders", { page: String(page), per_page: "200" });
    list.push(...(b.purchaseorders ?? []));
    if (!b.page_context?.has_more_page) break;
  }
  // deno-lint-ignore no-explicit-any
  const lines: any[] = [], pos: string[] = [], open: string[] = [];
  for (const p of list.filter(stillToReceive)) {
    const po = (await zohoInv("GET", `/purchaseorders/${p.purchaseorder_id}`)).purchaseorder;
    const bo = isBackOrder(po);
    (bo ? pos : open).push(String(po.purchaseorder_number));
    // deno-lint-ignore no-explicit-any
    for (const l of (po.line_items ?? []) as any[]) {
      if (!l.item_id) continue;
      const ordered = Number(l.quantity ?? 0) - Number(l.quantity_cancelled ?? 0), received = lineReceived(l);
      if (ordered - received <= 0) continue;
      // deno-lint-ignore no-explicit-any
      const model = ((l.item_custom_fields ?? []) as any[]).find((c) => c.api_name === "cf_model")?.value ?? null;
      lines.push({ line_item_id: String(l.line_item_id), zoho_purchaseorder_id: String(po.purchaseorder_id),
        purchaseorder_number: po.purchaseorder_number, reference_number: po.reference_number ?? null, vendor_name: po.vendor_name ?? null,
        po_date: po.date || null, eta: po.delivery_date || po.expected_delivery_date || null, po_status: po.status ?? null,
        billed_status: po.billed_status ?? null, zoho_item_id: String(l.item_id), sku: l.sku ?? null, name: l.name ?? null, model,
        qty_ordered: ordered, qty_received: received, back_order: bo });
    }
  }
  const { data, error } = await db.rpc("apply_zoho_back_orders", { p_lines: lines });
  if (error) { await log({ doc_type: "purchaseorder", action: "readback_error", ok: false, message: `back orders: ${error.message}` }); throw new Error(error.message); }
  return { purchaseorders: pos, other_open_purchaseorders: open, ...data };
}
