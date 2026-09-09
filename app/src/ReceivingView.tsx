// CTP Core — RECEIVING. Booking a container in, without writing SQL.
//
// The schema underneath this is worth nothing until somebody can use it, and
// the person using it is standing at an open crate with a packing list, not
// sitting with a database client. So the screen follows the physical job in the
// order it actually happens:
//
//   1. Start a receipt        — who it is from. One supplier, so it is prefilled.
//   2. Count the goods in     — search, quantity, cost. Repeat, fast, keyboard.
//   3. Add the charges        — freight, duty, clearing. They arrive later than
//                               the goods, so this step is optional and can be
//                               revisited after posting.
//   4. Look at the landed cost BEFORE committing.
//   5. Post.                  — the single moment stock moves.
//
// WHY THE DRAFT MATTERS, and why this screen is built around it: receiving a
// container takes hours, gets interrupted, and the person counting is not the
// person holding the invoice. A draft accumulates lines and writes NO stock.
// Posting is one moment. Without that, a half-counted container is already in
// stock and the shortfall looks like theft.
//
// THE ONE NUMBER THIS SCREEN EXISTS TO SHOW: what a part actually cost once
// freight and duty are in, next to what the supplier's price list said. On the
// first real container that difference is the margin the business has been
// quietly giving away, and it should be visible before the goods are posted,
// not discovered in a report next quarter.
import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "./data/api";
import { money, type Hit } from "./App";

type Supplier = { id: number; code: string; name: string; currency: string; incoterm: string | null };
type DocRef = { id: number; number: string };

type LandedLine = {
  part_id: number; sku: string; qty: number;
  unit_invoice_minor: number; unit_freight_minor: number; unit_duty_minor: number;
  unit_clearing_minor: number; unit_other_minor: number;
  unit_cost_invoiced_minor: number; total_invoiced_minor: number;
};
type Landed = {
  receipt_id: number; lines: LandedLine[];
  goods_total_minor: number; components_total_minor: number;
  grand_total_minor: number; excluded_minor: number;
  weight_fallbacks: string[];
};
type Posted = {
  receipt_id: number; movements: number; landed_rows: number;
  accruals: number; units: number;
};
type CostNow = {
  part_id: number; sku: string;
  cost_invoiced_minor: number; cost_expected_minor: number; rebate_minor: number;
  basis: string; is_estimated: boolean; list_price_minor: number;
  margin_bps_invoiced: number; margin_bps_expected: number;
};

/** Working line, held in React until the draft is saved row by row. */
type DraftLine = { part_id: number; sku: string; name: string; qty: number; unit_cost_minor: number };
type DraftCost = { component: string; amount_minor: number; allocation: string; is_landed: boolean };

const COMPONENTS: { key: string; label: string; alloc: string }[] = [
  { key: "freight_sea", label: "Sea freight", alloc: "by_value" },
  { key: "freight_road", label: "Road freight", alloc: "by_value" },
  { key: "duty", label: "Duty", alloc: "by_value" },
  { key: "clearing", label: "Clearing & forwarding", alloc: "by_units" },
  { key: "insurance", label: "Insurance", alloc: "by_value" },
  { key: "handling", label: "Handling", alloc: "by_units" },
  // Listed last and defaulted OUT of the part cost, because it is normally
  // reclaimable. Including it would overstate cost on every part.
  { key: "vat_import", label: "Import VAT (reclaimable)", alloc: "by_value" },
];

const ALLOCATIONS: { key: string; label: string; hint: string }[] = [
  { key: "by_value", label: "by value", hint: "Split in proportion to what each line cost. The default, and the only one that works until parts carry weights." },
  { key: "by_units", label: "by units", hint: "Split evenly per unit. Right for a per-consignment charge like clearing." },
  { key: "by_weight", label: "by weight", hint: "Proper for freight — but no part has a weight yet, so this falls back to value and says so." },
];

/** Rand string -> integer cents. Accepts "1 192.63", "1192,63", "R1192.63". */
function toMinor(s: string): number {
  const cleaned = s.replace(/[^\d.,-]/g, "").replace(/\s/g, "").replace(",", ".");
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}
const pct = (bps: number) => (bps / 100).toFixed(1) + "%";

export default function ReceivingView() {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [receipt, setReceipt] = useState<DocRef | null>(null);
  const [supplierId, setSupplierId] = useState<number | null>(null);
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [costs, setCosts] = useState<DraftCost[]>([]);
  const [landed, setLanded] = useState<Landed | null>(null);
  const [posted, setPosted] = useState<Posted | null>(null);
  const [msg, setMsg] = useState<string>("");
  const [busy, setBusy] = useState(false);

  const supported = api.supports("post_goods_receipt");

  useEffect(() => {
    if (!supported) return;
    api.listSuppliers<Supplier[]>()
      .then((s) => { setSuppliers(s); if (s.length === 1) setSupplierId(s[0].id); })
      .catch((e) => setMsg("✕ " + String(e)));
  }, [supported]);

  const start = useCallback(async () => {
    setBusy(true); setMsg("");
    try {
      const r = await api.createGoodsReceipt<DocRef>({ supplierId, kind: "purchase" });
      setReceipt(r); setLines([]); setCosts([]); setLanded(null); setPosted(null);
    } catch (e) { setMsg("✕ " + String(e)); } finally { setBusy(false); }
  }, [supplierId]);

  /** Save a line to the draft immediately. The draft IS the working state — if
   *  the app closes mid-count, what was counted is still there. */
  const addLine = useCallback(async (l: DraftLine) => {
    if (!receipt) return;
    try {
      await api.addReceiptLine(receipt.id, l.part_id, l.qty, l.unit_cost_minor);
      setLines((prev) => {
        const i = prev.findIndex((p) => p.part_id === l.part_id);
        if (i >= 0) { const c = [...prev]; c[i] = l; return c; }
        return [...prev, l];
      });
      setLanded(null);
      setMsg("");
    } catch (e) { setMsg("✕ " + String(e)); }
  }, [receipt]);

  const addCost = useCallback(async (c: DraftCost) => {
    if (!receipt) return;
    try {
      await api.addReceiptCost({
        receiptId: receipt.id, component: c.component, amountMinor: c.amount_minor,
        allocation: c.allocation, isLanded: c.is_landed,
      });
      setCosts((p) => [...p, c]);
      setLanded(null);
    } catch (e) { setMsg("✕ " + String(e)); }
  }, [receipt]);

  const preview = useCallback(async () => {
    if (!receipt) return;
    setBusy(true);
    try { setLanded(await api.previewLandedCost<Landed>(receipt.id)); setMsg(""); }
    catch (e) { setMsg("✕ " + String(e)); } finally { setBusy(false); }
  }, [receipt]);

  const post = useCallback(async () => {
    if (!receipt) return;
    setBusy(true);
    try {
      const r = await api.postGoodsReceipt<Posted>(receipt.id);
      setPosted(r);
      setMsg(`posted · ${r.units} unit${r.units === 1 ? "" : "s"} into stock`);
    } catch (e) { setMsg("✕ " + String(e)); } finally { setBusy(false); }
  }, [receipt]);

  if (!supported) {
    return (
      <div className="empty">
        Receiving runs on the desktop app only — the landed-cost calculation
        lives in the local database layer. Open CTP Core on the office PC.
      </div>
    );
  }

  const goods = lines.reduce((a, l) => a + l.qty * l.unit_cost_minor, 0);
  const charges = costs.filter((c) => c.is_landed).reduce((a, c) => a + c.amount_minor, 0);
  const excluded = costs.filter((c) => !c.is_landed).reduce((a, c) => a + c.amount_minor, 0);

  return (
    <>
      <div className="salesbar">
        <span className="tag">// receiving</span>
        <span className="spacer" />
        {!receipt && (
          <>
            {suppliers.length > 1 && (
              <select className="locsel" value={supplierId ?? ""}
                onChange={(e) => setSupplierId(Number(e.target.value))}>
                {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            )}
            <button className="post sm" onClick={start} disabled={busy || supplierId == null}>
              + Book in a delivery
            </button>
          </>
        )}
        {receipt && !posted && (
          <span className="why" style={{ margin: 0 }}>
            {receipt.number} · draft — nothing is in stock yet
          </span>
        )}
        {posted && <span className="sbadge st-fulfilled">posted</span>}
      </div>

      {!receipt && (
        <div className="empty">
          Nothing being received. Start a delivery when a container arrives —
          counting into a draft writes no stock until you post it.
        </div>
      )}

      {receipt && (
        <>
          {/* ── 1. the goods ─────────────────────────────────────────── */}
          <div className="count">
            1 · what arrived {lines.length > 0 && `— ${lines.length} line${lines.length === 1 ? "" : "s"}, ${money(goods)}`}
          </div>
          {!posted && <LineAdder onAdd={addLine} />}
          {lines.map((l) => (
            <div className="card" key={l.part_id}>
              <div className="row1">
                <span className="sku">{l.sku}</span>
                <span className="nm">{l.name}</span>
                <span className="spacer" />
                <span className="why" style={{ margin: 0 }}>{l.qty} × {money(l.unit_cost_minor)}</span>
                <span className="price">{money(l.qty * l.unit_cost_minor)}</span>
              </div>
            </div>
          ))}
          {lines.length === 0 && <div className="empty">no lines counted yet</div>}

          {/* ── 2. the charges ───────────────────────────────────────── */}
          <div className="count">
            2 · what it cost to land {charges > 0 && `— ${money(charges)}`}
            {excluded > 0 && ` (+ ${money(excluded)} excluded)`}
          </div>
          <div className="hint">
            Freight, duty and clearing usually arrive after the goods do. Leave
            this empty and post anyway — you can add them later and recost.
          </div>
          {!posted && <CostAdder onAdd={addCost} />}
          {costs.map((c, i) => (
            <div className="card" key={i}>
              <div className="row1">
                <span className="sku">{COMPONENTS.find((x) => x.key === c.component)?.label ?? c.component}</span>
                <span className="why" style={{ margin: 0 }}>{c.allocation.replace("by_", "by ")}</span>
                <span className="spacer" />
                {!c.is_landed && <span className="sbadge st-cancelled">not costed in</span>}
                <span className="price">{money(c.amount_minor)}</span>
              </div>
            </div>
          ))}

          {/* ── 3. the answer ────────────────────────────────────────── */}
          <div className="count">3 · what it actually cost</div>
          <div className="actbar">
            <button className="post sm" onClick={preview} disabled={busy || lines.length === 0}>
              {busy ? "…" : "Work out landed cost"}
            </button>
            {landed && !posted && (
              <button className="post" onClick={post} disabled={busy}>
                Post {landed.lines.reduce((a, l) => a + l.qty, 0)} units into stock
              </button>
            )}
            {posted && (
              <span className="why" style={{ margin: 0 }}>
                {posted.movements} movement{posted.movements === 1 ? "" : "s"} ·
                {" "}{posted.landed_rows} costed
                {posted.accruals > 0 && ` · ${posted.accruals} rebate accrual${posted.accruals === 1 ? "" : "s"}`}
              </span>
            )}
          </div>

          {msg && <div className={"msg" + (msg.startsWith("✕") ? " err" : "")}>{msg}</div>}

          {landed && <LandedTable landed={landed} posted={!!posted} />}
        </>
      )}
    </>
  );
}

/** Search a part, set a quantity and a cost, enter. Built for a keyboard and a
 *  packing list, because that is what the job is. */
function LineAdder({ onAdd }: { onAdd: (l: DraftLine) => void }) {
  const [term, setTerm] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [pick, setPick] = useState<Hit | null>(null);
  const [qty, setQty] = useState("");
  const [cost, setCost] = useState("");
  const qtyRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (term.trim().length < 2) { setHits([]); return; }
    let live = true;
    api.searchParts<Hit[]>(term)
      .then((h) => { if (live) setHits(h.slice(0, 6)); })
      .catch(() => { if (live) setHits([]); });
    return () => { live = false; };
  }, [term]);

  const commit = () => {
    const q = parseInt(qty, 10);
    if (!pick || !Number.isFinite(q) || q <= 0) return;
    onAdd({
      part_id: pick.id, sku: pick.sku, name: pick.name,
      qty: q, unit_cost_minor: toMinor(cost),
    });
    setPick(null); setTerm(""); setQty(""); setCost(""); setHits([]);
  };

  return (
    <div className="addinline">
      {!pick ? (
        <>
          <input className="searchbox" placeholder="part number or name…" autoFocus
            value={term} onChange={(e) => setTerm(e.target.value)} />
          {hits.length > 0 && (
            <div className="addlist">
              {hits.map((h) => (
                <button className="arow" key={h.id}
                  onClick={() => { setPick(h); setTerm(""); setHits([]); setTimeout(() => qtyRef.current?.focus(), 0); }}>
                  <span className="sku">{h.sku}</span>
                  <span className="nm">{h.name}</span>
                </button>
              ))}
            </div>
          )}
        </>
      ) : (
        <div className="mvbar">
          <span className="sku">{pick.sku}</span>
          <span className="nm">{pick.name}</span>
          <span className="spacer" />
          <input ref={qtyRef} className="qty" placeholder="qty" inputMode="numeric"
            value={qty} onChange={(e) => setQty(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } }} />
          <input className="qty" placeholder="unit cost" inputMode="decimal"
            value={cost} onChange={(e) => setCost(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } }} />
          <button className="post" onClick={commit}>Add ⏎</button>
          <button className="x" onClick={() => { setPick(null); setQty(""); setCost(""); }}>✕</button>
        </div>
      )}
    </div>
  );
}

function CostAdder({ onAdd }: { onAdd: (c: DraftCost) => void }) {
  const [component, setComponent] = useState("freight_sea");
  const [amount, setAmount] = useState("");
  const def = COMPONENTS.find((c) => c.key === component)!;
  const [allocation, setAllocation] = useState(def.alloc);
  // Import VAT is reclaimable, so by default it is recorded but NOT costed into
  // the part. Any other component defaults to being costed in.
  const isVat = component === "vat_import";

  useEffect(() => {
    const d = COMPONENTS.find((c) => c.key === component);
    if (d) setAllocation(d.alloc);
  }, [component]);

  const commit = () => {
    const m = toMinor(amount);
    if (m <= 0) return;
    onAdd({ component, amount_minor: m, allocation, is_landed: !isVat });
    setAmount("");
  };

  return (
    <div className="mvbar">
      <select className="locsel" value={component} onChange={(e) => setComponent(e.target.value)}>
        {COMPONENTS.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
      </select>
      <select className="locsel" value={allocation} onChange={(e) => setAllocation(e.target.value)}
        title={ALLOCATIONS.find((a) => a.key === allocation)?.hint}>
        {ALLOCATIONS.map((a) => <option key={a.key} value={a.key}>{a.label}</option>)}
      </select>
      <input className="qty" placeholder="amount" inputMode="decimal"
        value={amount} onChange={(e) => setAmount(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } }} />
      <button className="post" onClick={commit}>Add ⏎</button>
      {isVat && (
        <span className="why" style={{ margin: 0 }}>
          recorded, not costed into the part — reclaimable
        </span>
      )}
    </div>
  );
}

/** The payoff. Per part: what the supplier charged, what landed, and the gap.
 *  The gap is the number the business has never been able to see. */
function LandedTable({ landed, posted }: { landed: Landed; posted: boolean }) {
  const [costs, setCosts] = useState<Record<number, CostNow>>({});

  // After posting, pull each part's current cost so the landed figure can be
  // shown against the list price it will be sold at.
  useEffect(() => {
    if (!posted) return;
    let live = true;
    (async () => {
      const out: Record<number, CostNow> = {};
      for (const l of landed.lines) {
        try { out[l.part_id] = await api.partCostNow<CostNow>(l.part_id); }
        catch { /* a part with no price is not an error here */ }
      }
      if (live) setCosts(out);
    })();
    return () => { live = false; };
  }, [posted, landed]);

  return (
    <>
      <div className="totals">
        <div className="totrow"><span className="totlabel">goods</span><span className="tnum">{money(landed.goods_total_minor)}</span></div>
        <div className="totrow"><span className="totlabel">freight, duty, clearing</span><span className="tnum">{money(landed.components_total_minor)}</span></div>
        {landed.excluded_minor > 0 && (
          <div className="totrow">
            <span className="totlabel">excluded (reclaimable)</span>
            <span className="tnum">{money(landed.excluded_minor)}</span>
          </div>
        )}
        <div className="totrow tot"><span className="totlabel">landed total</span><span className="tnum">{money(landed.grand_total_minor)}</span></div>
      </div>

      {landed.weight_fallbacks.length > 0 && (
        <div className="hint">
          ⚠ {landed.weight_fallbacks.join(", ")} asked to be split by weight, but
          no part on this receipt carries one — so it was split by value instead.
          That under-costs heavy cheap parts and over-costs light expensive ones.
          Capturing weights as you unpack fixes it permanently.
        </div>
      )}

      <div className="pttable">
        <div className="trow binhead">
          <span className="sku">part</span>
          <span className="nm">qty</span>
          <span className="uprice">supplier</span>
          <span className="uprice">+ landed</span>
          <span className="uprice">true cost</span>
          <span className="uprice">uplift</span>
        </div>
        {landed.lines.map((l) => {
          const add = l.unit_cost_invoiced_minor - l.unit_invoice_minor;
          const up = l.unit_invoice_minor > 0
            ? Math.round((add * 10000) / l.unit_invoice_minor) : 0;
          const c = costs[l.part_id];
          return (
            <div className="trow" key={l.part_id}>
              <span className="sku">{l.sku}</span>
              <span className="nm">{l.qty}</span>
              <span className="uprice">{money(l.unit_invoice_minor)}</span>
              <span className="uprice">{money(add)}</span>
              <span className="uprice"><b>{money(l.unit_cost_invoiced_minor)}</b></span>
              <span className="uprice">{up > 0 ? "+" + pct(up) : "—"}</span>
              {c && c.list_price_minor > 0 && (
                <span className="why" style={{ gridColumn: "1 / -1", margin: "2px 0 0" }}>
                  sells at {money(c.list_price_minor)} — margin {pct(c.margin_bps_invoiced)} on
                  {" "}true cost{c.rebate_minor > 0 && `, ${pct(c.margin_bps_expected)} after settled rebate`}
                </span>
              )}
            </div>
          );
        })}
      </div>

      <div className="hint">
        “True cost” is money actually spent — invoice plus freight, duty and
        clearing. It is the figure every margin should be measured against. A
        rebate, when one is earned and settled, is reported separately and never
        lowers this number, because a discount funded by money that has not
        arrived is how a threshold gets missed.
      </div>
    </>
  );
}
