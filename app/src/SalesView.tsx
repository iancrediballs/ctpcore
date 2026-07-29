import { useEffect, useRef, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { money, stockClass, type Hit } from "./App";
import { buildDocHTML, openPrintWindow, type DocCompany } from "./invoiceDoc";

type Customer = { id: number; code: string; name: string; contact: string | null; phone: string | null; price_tier: string };
type Loc = { id: number; code: string; name: string };
type OrderSummary = { id: number; number: string; customer_name: string; status: string; line_count: number; subtotal_minor: number; created_at: string };
type OrderLine = { id: number; part_id: number; sku: string; name: string; qty: number; unit_price_minor: number; line_total_minor: number; on_hand: number };
type OrderDetail = {
  id: number; number: string; status: string;
  customer_id: number; customer_name: string; customer_tier: string;
  customer_contact: string | null; customer_phone: string | null; customer_email: string | null;
  location_id: number; location_code: string; notes: string | null;
  lines: OrderLine[]; subtotal_minor: number;
  tax_rate_bps: number; tax_minor: number; total_minor: number;
  fulfilled_at: string | null; created_at: string;
};

const STATUS_ORDER = ["quote", "confirmed", "fulfilled", "invoiced"];

export default function SalesView() {
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [open, setOpen] = useState<OrderDetail | null>(null);
  const [creating, setCreating] = useState(false);

  const loadOrders = useCallback(async () => {
    try { setOrders(await invoke<OrderSummary[]>("list_orders")); }
    catch (e) { console.error(e); }
  }, []);

  useEffect(() => { loadOrders(); }, [loadOrders]);

  const openOrder = useCallback(async (id: number) => {
    try { setOpen(await invoke<OrderDetail>("get_order", { orderId: id })); }
    catch (e) { console.error(e); }
  }, []);

  return (
    <>
      <div className="salesbar">
        <span className="tag">// sales &amp; quotes</span>
        <span className="spacer" />
        <button className="post sm" onClick={() => setCreating(true)}>+ New quote</button>
      </div>

      <div className="count">{orders.length} order{orders.length !== 1 ? "s" : ""}</div>
      {orders.map((o) => (
        <div className="card" key={o.id} onClick={() => openOrder(o.id)}>
          <div className="row1">
            <span className="sku">{o.number}</span>
            <span className="nm">{o.customer_name}</span>
            <span className={"sbadge st-" + o.status}>{o.status}</span>
            <span className="spacer" />
            <span className="why" style={{ margin: 0 }}>{o.line_count} item{o.line_count !== 1 ? "s" : ""}</span>
            <span className="price">{money(o.subtotal_minor)}</span>
          </div>
        </div>
      ))}
      {orders.length === 0 && <div className="empty">no orders yet — start a quote</div>}

      {creating && (
        <NewQuote onClose={() => setCreating(false)} onCreated={(d) => { setCreating(false); loadOrders(); setOpen(d); }} />
      )}
      {open && (
        <OrderPanel
          order={open}
          onClose={() => { setOpen(null); loadOrders(); }}
          onChange={(d) => { setOpen(d); }}
          afterMutation={loadOrders}
        />
      )}
    </>
  );
}

function NewQuote({ onClose, onCreated }: { onClose: () => void; onCreated: (d: OrderDetail) => void }) {
  const [custs, setCusts] = useState<Customer[]>([]);
  const [locs, setLocs] = useState<Loc[]>([]);
  const [cust, setCust] = useState<number | null>(null);
  const [loc, setLoc] = useState<number | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    (async () => {
      const c = await invoke<Customer[]>("list_customers");
      const l = await invoke<Loc[]>("list_locations");
      setCusts(c); setLocs(l);
      setCust(c[0]?.id ?? null);
      setLoc(l[0]?.id ?? null);
    })();
  }, []);

  const create = async () => {
    if (cust == null || loc == null) return;
    try {
      const d = await invoke<OrderDetail>("create_order", { customerId: cust, locationId: loc });
      onCreated(d);
    } catch (e) { setErr(String(e)); }
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="panel narrow" onClick={(e) => e.stopPropagation()}>
        <div className="phead">
          <span className="sku big">New quote</span>
          <span className="spacer" />
          <button className="x" onClick={onClose}>✕</button>
        </div>
        <label className="fld">Customer
          <select value={cust ?? ""} onChange={(e) => setCust(Number(e.target.value))}>
            {custs.map((c) => <option key={c.id} value={c.id}>{c.name} · {c.price_tier}</option>)}
          </select>
        </label>
        <label className="fld">Fulfill from
          <select value={loc ?? ""} onChange={(e) => setLoc(Number(e.target.value))}>
            {locs.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </label>
        {err && <div className="msg err">✕ {err}</div>}
        <button className="post" style={{ marginTop: 14 }} onClick={create}>Create quote</button>
      </div>
    </div>
  );
}

function OrderPanel({ order, onClose, onChange, afterMutation }: {
  order: OrderDetail;
  onClose: () => void;
  onChange: (d: OrderDetail) => void;
  afterMutation: () => void;
}) {
  const editable = order.status === "quote" || order.status === "confirmed";
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [msg, setMsg] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = setTimeout(async () => {
      if (q.trim().length < 2) { setHits([]); return; }
      try { setHits(await invoke<Hit[]>("search_parts", { query: q })); } catch { /* noop */ }
    }, 90);
    return () => clearTimeout(t);
  }, [q]);

  const mut = async (fn: () => Promise<OrderDetail>, ok?: string) => {
    try { const d = await fn(); onChange(d); afterMutation(); if (ok) setMsg(ok); }
    catch (e) { setMsg("✕ " + String(e)); }
  };

  const addPart = (partId: number) =>
    mut(() => invoke<OrderDetail>("add_line", { orderId: order.id, partId, qty: 1 }));

  const fulfill = () =>
    mut(() => invoke<OrderDetail>("fulfill_order", { orderId: order.id }), "fulfilled — stock issued through the ledger");

  const setStatus = (status: string) =>
    mut(() => invoke<OrderDetail>("set_status", { orderId: order.id, status }));

  const printDoc = async () => {
    try {
      const company = await invoke<DocCompany>("get_company");
      openPrintWindow(buildDocHTML(order, company));
    } catch (e) { setMsg("✕ " + String(e)); }
  };

  const stepIdx = STATUS_ORDER.indexOf(order.status);

  return (
    <div className="overlay" onClick={onClose}>
      <div className="panel" onClick={(e) => e.stopPropagation()}>
        <div className="phead">
          <span className="sku big">{order.number}</span>
          <span className="nm">{order.customer_name}</span>
          <span className="brand">{order.customer_tier}</span>
          <span className={"sbadge st-" + order.status}>{order.status}</span>
          <span className="spacer" />
          <button className="x" onClick={onClose} title="Esc">✕</button>
        </div>
        <div className="sub">fulfills from {order.location_code} · opened {order.created_at}{order.fulfilled_at ? " · fulfilled " + order.fulfilled_at : ""}</div>

        {/* status rail */}
        <div className="rail">
          {STATUS_ORDER.map((s, i) => (
            <span key={s} className={"step" + (i <= stepIdx ? " done" : "") + (i === stepIdx ? " now" : "")}>{s}</span>
          ))}
          {order.status === "cancelled" && <span className="step now st-cancelled">cancelled</span>}
        </div>

        {/* add part (only while editable) */}
        {editable && (
          <>
            <div className="searchbox sm">
              <input ref={searchRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="add part — search #, competitor #, brand…" />
            </div>
            {hits.length > 0 && (
              <div className="addlist">
                {hits.slice(0, 6).map((h) => (
                  <div className="arow" key={h.id} onClick={() => { addPart(h.id); setQ(""); setHits([]); searchRef.current?.focus(); }}>
                    <span className="sku">{h.sku}</span>
                    <span className="nm">{h.name}</span>
                    <span className="spacer" />
                    <span className={"stock " + stockClass(h.on_hand)}>{h.on_hand <= 0 ? "OUT" : h.on_hand}</span>
                    <span className="price">{money(h.price_cents)}</span>
                    <span className="addbtn">+ add</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {/* line items */}
        <div className="count">{order.lines.length} line{order.lines.length !== 1 ? "s" : ""}</div>
        <div className="lines">
          {order.lines.map((l) => (
            <div className="litem" key={l.id}>
              <span className="sku">{l.sku}</span>
              <span className="nm">{l.name}</span>
              {l.qty > l.on_hand && <span className="flag" title="short on stock">⚠ {l.on_hand} avail</span>}
              <span className="spacer" />
              {editable ? (
                <input className="qty xs" defaultValue={l.qty}
                  onBlur={(e) => {
                    const v = parseInt(e.target.value, 10);
                    if (Number.isFinite(v) && v > 0 && v !== l.qty)
                      mut(() => invoke<OrderDetail>("update_line_qty", { lineId: l.id, qty: v }));
                  }}
                  onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
              ) : (<span className="qtystatic">{l.qty}</span>)}
              <span className="uprice">@ {money(l.unit_price_minor)}</span>
              <span className="price">{money(l.line_total_minor)}</span>
              {editable && <button className="x sm" title="remove"
                onClick={() => mut(() => invoke<OrderDetail>("remove_line", { lineId: l.id }))}>✕</button>}
            </div>
          ))}
          {order.lines.length === 0 && <div className="empty">no lines — search above to add parts</div>}
        </div>

        <div className="totals">
          <div className="trow">
            <span className="spacer" />
            <span className="totlabel">Subtotal</span>
            <span className="tnum">{money(order.subtotal_minor)}</span>
          </div>
          <div className="trow">
            <span className="spacer" />
            <span className="totlabel">
              Tax
              {editable ? (
                <input className="taxin" defaultValue={(order.tax_rate_bps / 100).toString()}
                  title="tax %"
                  onBlur={(e) => {
                    const pct = parseFloat(e.target.value);
                    const bps = Math.round((Number.isFinite(pct) ? pct : 0) * 100);
                    if (bps !== order.tax_rate_bps)
                      mut(() => invoke<OrderDetail>("set_tax_rate", { orderId: order.id, bps }));
                  }}
                  onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
              ) : (<> {(order.tax_rate_bps / 100).toFixed(2)}%</>)}
            </span>
            <span className="tnum">{money(order.tax_minor)}</span>
          </div>
          <div className="trow grand">
            <span className="spacer" />
            <span className="totlabel">Total</span>
            <span className="tot">{money(order.total_minor)}</span>
          </div>
        </div>

        {/* actions */}
        <div className="actbar">
          {order.status === "quote" && <button className="ghost" onClick={() => setStatus("confirmed")}>Confirm</button>}
          {order.status === "confirmed" && <button className="ghost" onClick={() => setStatus("quote")}>← Back to quote</button>}
          {(order.status === "quote" || order.status === "confirmed") && (
            <button className="ghost danger" onClick={() => setStatus("cancelled")}>Cancel</button>
          )}
          <button className="ghost" onClick={printDoc}>
            {order.status === "quote" || order.status === "confirmed" ? "Print quote" : "Print invoice"}
          </button>
          <span className="spacer" />
          {editable && (
            <button className="post" disabled={order.lines.length === 0} onClick={fulfill}>Fulfill → issue stock</button>
          )}
          {order.status === "fulfilled" && <button className="post" onClick={() => setStatus("invoiced")}>Mark invoiced</button>}
        </div>
        {msg && <div className={"msg" + (msg.startsWith("✕") ? " err" : "")}>{msg}</div>}
      </div>
    </div>
  );
}
