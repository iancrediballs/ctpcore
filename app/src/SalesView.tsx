import { useEffect, useRef, useState, useCallback } from "react";
import * as api from "./data/api";
import { money, stockClass, type Hit } from "./App";
import { buildDocHTML, openPrintWindow, type DocCompany } from "./invoiceDoc";
import AddCustomer from "./admin/AddCustomer";

// 23 Oct 2026 (Ian): quotes are Zoho ESTIMATES and Zoho leads their content.
// This desktop screen works on the PC's own SQLite: its orders never reach
// Supabase, Zoho or the customer, so it cannot know estimate numbers or
// statuses. Until it is rebuilt on the cloud data, quoting and stock-out here
// are locked; history stays readable and printable.
const QUOTES_IN_ZOHO = true;
function ZohoNotice() {
  return (
    <div className="msg" style={{ margin: "8px 0 12px" }}>
      <b>Quotes are Zoho estimates now.</b> Raise and price quotes in the phone/browser app
      (ctpcore.vercel.app) — "Send quote" creates the estimate (QT-…) in Zoho, and prices are
      edited in Zoho (Edit prices in Zoho, QT-…). Accounts send it from Zoho; the customer accepts
      in the app; fulfil there once Zoho shows the invoice. Orders on this PC are local only and
      never reach Zoho or the customer, so new quotes, line edits and stock-out are locked here.
    </div>
  );
}

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
    try { setOrders(await api.listOrders<OrderSummary[]>()); }
    catch (e) { console.error(e); }
  }, []);

  useEffect(() => { loadOrders(); }, [loadOrders]);

  const openOrder = useCallback(async (id: number) => {
    try { setOpen(await api.getOrder<OrderDetail>(id)); }
    catch (e) { console.error(e); }
  }, []);

  return (
    <>
      <div className="salesbar">
        <span className="tag">// sales &amp; quotes</span>
        <span className="spacer" />
        <button className="post sm" disabled={QUOTES_IN_ZOHO} title={QUOTES_IN_ZOHO ? "Quotes are raised in the phone/browser app as Zoho estimates" : undefined}
          onClick={() => setCreating(true)}>+ New quote</button>
      </div>
      {QUOTES_IN_ZOHO && <ZohoNotice />}

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
  const [find, setFind] = useState("");   // 0056: Zoho customers make this list long
  const [adding, setAdding] = useState(false);   // Phase 1: Zoho-first add customer
  const [loc, setLoc] = useState<number | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    (async () => {
      const c = await api.listCustomers<Customer[]>();
      const l = await api.listLocations<Loc[]>();
      setCusts(c); setLocs(l);
      // no default customer: a quote on the wrong account is worse than one more click
      setLoc(l[0]?.id ?? null);
    })();
  }, []);

  const create = async () => {
    if (cust == null || loc == null) return;
    try {
      const d = await api.createOrder<OrderDetail>(cust, loc);
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
          <input type="search" placeholder="Search customers…" value={find} onChange={(e) => setFind(e.target.value)} />
          <select value={cust ?? ""} onChange={(e) => setCust(e.target.value ? Number(e.target.value) : null)}>
            <option value="">— pick the customer —</option>
            {custs.filter((c) => c.id === cust || !find.trim() || c.name.toLowerCase().includes(find.trim().toLowerCase()))
              .map((c) => <option key={c.id} value={c.id}>{c.name} · {c.price_tier}</option>)}
          </select>
        </label>
        {!adding
          ? <button onClick={() => setAdding(true)}>+ New customer</button>
          : <AddCustomer isAdmin={false} onCancel={() => setAdding(false)}
              onDone={async (id) => { setCusts(await api.listCustomers<Customer[]>()); setCust(id); setAdding(false); }} />}
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
  const editable = !QUOTES_IN_ZOHO && (order.status === "quote" || order.status === "confirmed");
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [msg, setMsg] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = setTimeout(async () => {
      if (q.trim().length < 2) { setHits([]); return; }
      try { setHits(await api.searchParts<Hit[]>(q)); } catch { /* noop */ }
    }, 90);
    return () => clearTimeout(t);
  }, [q]);

  const mut = async (fn: () => Promise<OrderDetail>, ok?: string) => {
    try { const d = await fn(); onChange(d); afterMutation(); if (ok) setMsg(ok); }
    catch (e) { setMsg("✕ " + String(e)); }
  };

  const addPart = (partId: number) =>
    mut(() => api.addLine<OrderDetail>(order.id, partId, 1));

  const fulfill = () =>
    mut(() => api.fulfillOrder<OrderDetail>(order.id), "fulfilled — stock issued through the ledger");

  const setStatus = (status: string) =>
    mut(() => api.setStatus<OrderDetail>(order.id, status));

  const printDoc = async () => {
    try {
      const company = await api.getCompany<DocCompany>();
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
                      mut(() => api.updateLineQty<OrderDetail>(l.id, v));
                  }}
                  onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
              ) : (<span className="qtystatic">{l.qty}</span>)}
              <span className="uprice">@ {money(l.unit_price_minor)}</span>
              <span className="price">{money(l.line_total_minor)}</span>
              {editable && <button className="x sm" title="remove"
                onClick={() => mut(() => api.removeLine<OrderDetail>(l.id))}>✕</button>}
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
                      mut(() => api.setTaxRate<OrderDetail>(order.id, bps));
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

        {QUOTES_IN_ZOHO && (order.status === "quote" || order.status === "confirmed") && <ZohoNotice />}
        {/* actions */}
        <div className="actbar">
          {!QUOTES_IN_ZOHO && order.status === "quote" && <button className="ghost" onClick={() => setStatus("confirmed")}>Confirm</button>}
          {!QUOTES_IN_ZOHO && order.status === "confirmed" && <button className="ghost" onClick={() => setStatus("quote")}>← Back to quote</button>}
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
          {/* "Mark invoiced" removed 2026-09-21 (Ian): it set the status with no
              number behind it — the path 0045 now refuses at the database. The
              tax invoice is Zoho Books' (sales order → invoice); an order reads
              "invoiced" here only through invoice_order, never by hand. */}
          {order.status === "fulfilled" && <span className="hint">Goods out — the tax invoice is issued from the sales order in Zoho Books.</span>}
        </div>
        {msg && <div className={"msg" + (msg.startsWith("✕") ? " err" : "")}>{msg}</div>}
      </div>
    </div>
  );
}
