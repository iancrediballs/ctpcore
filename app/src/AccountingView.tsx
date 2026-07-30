import { useEffect, useState, useCallback } from "react";
import * as api from "./data/api";
import { money } from "./App";

type Target = "xero" | "quickbooks";
type ExportRow = {
  id: number; number: string; customer_name: string; invoice_date: string;
  subtotal_minor: number; tax_rate_bps: number; total_minor: number;
  exported_at: string | null; batch_uuid: string | null;
};
type ExportResult = {
  batch_uuid: string; target: string; filename: string; content: string;
  exported_count: number; skipped_count: number;
};

const TARGETS: { key: Target; label: string; ext: string }[] = [
  { key: "xero", label: "Xero CSV", ext: "csv" },
  { key: "quickbooks", label: "QuickBooks IIF", ext: "iif" },
];

export default function AccountingView() {
  const [target, setTarget] = useState<Target>("xero");
  const [rows, setRows] = useState<ExportRow[]>([]);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [result, setResult] = useState<ExportResult | null>(null);
  const [msg, setMsg] = useState("");

  const load = useCallback(async (t: Target) => {
    try {
      const r = await api.listExportQueue<ExportRow[]>(t);
      setRows(r);
      // default-select everything not yet exported to this target
      setPicked(new Set(r.filter((x) => !x.exported_at).map((x) => x.id)));
    } catch (e) { console.error(e); }
  }, []);

  useEffect(() => { load(target); }, [target, load]);

  const toggle = (id: number) =>
    setPicked((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const queued = rows.filter((r) => !r.exported_at);
  const exportNow = async () => {
    const ids = [...picked];
    if (ids.length === 0) { setMsg("nothing selected"); return; }
    setMsg("");
    try {
      const res = await api.exportAccounting<ExportResult>(target, ids);
      setResult(res);
      await load(target);
    } catch (e) { setMsg("✕ " + String(e)); }
  };

  const download = () => {
    if (!result) return;
    const blob = new Blob([result.content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = result.filename; a.click();
    URL.revokeObjectURL(url);
  };

  const copy = async () => {
    if (result) { await navigator.clipboard.writeText(result.content); setMsg("copied to clipboard"); }
  };

  return (
    <>
      <div className="salesbar">
        <span className="tag">// accounting export</span>
        <span className="spacer" />
        <div className="seg">
          {TARGETS.map((t) => (
            <button key={t.key} className={"segbtn" + (target === t.key ? " on" : "")} onClick={() => { setTarget(t.key); setResult(null); }}>{t.label}</button>
          ))}
        </div>
      </div>

      <div className="hint">invoiced orders push to {target === "xero" ? "Xero" : "QuickBooks"} once each — already-exported orders are locked out of re-posting.</div>

      <div className="count">{queued.length} queued · {rows.length - queued.length} already exported</div>

      {rows.map((r) => (
        <div className={"card" + (r.exported_at ? " dimmed" : "")} key={r.id}>
          <div className="row1">
            {!r.exported_at ? (
              <input type="checkbox" className="cbx" checked={picked.has(r.id)} onChange={() => toggle(r.id)} />
            ) : (<span className="cbx done">✓</span>)}
            <span className="sku">{r.number}</span>
            <span className="nm">{r.customer_name}</span>
            <span className="why" style={{ margin: 0 }}>{r.invoice_date}</span>
            <span className="spacer" />
            {r.tax_rate_bps > 0 && <span className="brand">+{(r.tax_rate_bps / 100).toFixed(1)}% tax</span>}
            {r.exported_at && <span className="sbadge st-invoiced" title={r.batch_uuid ?? ""}>exported</span>}
            <span className="price">{money(r.total_minor)}</span>
          </div>
        </div>
      ))}
      {rows.length === 0 && <div className="empty">no invoiced orders yet — invoice an order in Sales</div>}

      <div className="actbar">
        <span className="spacer" />
        <button className="post" disabled={picked.size === 0} onClick={exportNow}>
          Export {picked.size || ""} → {target === "xero" ? "Xero" : "QuickBooks"}
        </button>
      </div>
      {msg && <div className={"msg" + (msg.startsWith("✕") ? " err" : "")}>{msg}</div>}

      {result && (
        <div className="overlay" onClick={() => setResult(null)}>
          <div className="panel" onClick={(e) => e.stopPropagation()}>
            <div className="phead">
              <span className="sku big">{result.filename}</span>
              <span className="spacer" />
              <button className="x" onClick={() => setResult(null)}>✕</button>
            </div>
            <div className="sub">
              {result.exported_count} order{result.exported_count !== 1 ? "s" : ""} exported
              {result.skipped_count > 0 ? ` · ${result.skipped_count} skipped (already posted)` : ""} · batch {result.batch_uuid}
            </div>
            <div className="mvbar" style={{ marginTop: 14 }}>
              <button className="post" onClick={download}>Download file</button>
              <button className="ghost" onClick={copy}>Copy</button>
            </div>
            <textarea className="exparea" readOnly value={result.content} />
          </div>
        </div>
      )}
    </>
  );
}
