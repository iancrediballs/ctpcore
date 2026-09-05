import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useEffect, useState, useCallback } from "react";
import * as api from "./data/api";
import { money } from "./App";
const TARGETS = [
    { key: "xero", label: "Xero CSV", ext: "csv" },
    { key: "quickbooks", label: "QuickBooks IIF", ext: "iif" },
];
export default function AccountingView() {
    const [target, setTarget] = useState("xero");
    const [rows, setRows] = useState([]);
    const [picked, setPicked] = useState(new Set());
    const [result, setResult] = useState(null);
    const [msg, setMsg] = useState("");
    const load = useCallback(async (t) => {
        try {
            const r = await api.listExportQueue(t);
            setRows(r);
            // default-select everything not yet exported to this target
            setPicked(new Set(r.filter((x) => !x.exported_at).map((x) => x.id)));
        }
        catch (e) {
            console.error(e);
        }
    }, []);
    useEffect(() => { load(target); }, [target, load]);
    const toggle = (id) => setPicked((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
    const queued = rows.filter((r) => !r.exported_at);
    const exportNow = async () => {
        const ids = [...picked];
        if (ids.length === 0) {
            setMsg("nothing selected");
            return;
        }
        setMsg("");
        try {
            const res = await api.exportAccounting(target, ids);
            setResult(res);
            await load(target);
        }
        catch (e) {
            setMsg("✕ " + String(e));
        }
    };
    const download = () => {
        if (!result)
            return;
        const blob = new Blob([result.content], { type: "text/plain" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = result.filename;
        a.click();
        URL.revokeObjectURL(url);
    };
    const copy = async () => {
        if (result) {
            await navigator.clipboard.writeText(result.content);
            setMsg("copied to clipboard");
        }
    };
    return (_jsxs(_Fragment, { children: [_jsxs("div", { className: "salesbar", children: [_jsx("span", { className: "tag", children: "// accounting export" }), _jsx("span", { className: "spacer" }), _jsx("div", { className: "seg", children: TARGETS.map((t) => (_jsx("button", { className: "segbtn" + (target === t.key ? " on" : ""), onClick: () => { setTarget(t.key); setResult(null); }, children: t.label }, t.key))) })] }), _jsxs("div", { className: "hint", children: ["invoiced orders push to ", target === "xero" ? "Xero" : "QuickBooks", " once each \u2014 already-exported orders are locked out of re-posting."] }), _jsxs("div", { className: "count", children: [queued.length, " queued \u00B7 ", rows.length - queued.length, " already exported"] }), rows.map((r) => (_jsx("div", { className: "card" + (r.exported_at ? " dimmed" : ""), children: _jsxs("div", { className: "row1", children: [!r.exported_at ? (_jsx("input", { type: "checkbox", className: "cbx", checked: picked.has(r.id), onChange: () => toggle(r.id) })) : (_jsx("span", { className: "cbx done", children: "\u2713" })), _jsx("span", { className: "sku", children: r.number }), _jsx("span", { className: "nm", children: r.customer_name }), _jsx("span", { className: "why", style: { margin: 0 }, children: r.invoice_date }), _jsx("span", { className: "spacer" }), r.tax_rate_bps > 0 && _jsxs("span", { className: "brand", children: ["+", (r.tax_rate_bps / 100).toFixed(1), "% tax"] }), r.exported_at && _jsx("span", { className: "sbadge st-invoiced", title: r.batch_uuid ?? "", children: "exported" }), _jsx("span", { className: "price", children: money(r.total_minor) })] }) }, r.id))), rows.length === 0 && _jsx("div", { className: "empty", children: "no invoiced orders yet \u2014 invoice an order in Sales" }), _jsxs("div", { className: "actbar", children: [_jsx("span", { className: "spacer" }), _jsxs("button", { className: "post", disabled: picked.size === 0, onClick: exportNow, children: ["Export ", picked.size || "", " \u2192 ", target === "xero" ? "Xero" : "QuickBooks"] })] }), msg && _jsx("div", { className: "msg" + (msg.startsWith("✕") ? " err" : ""), children: msg }), result && (_jsx("div", { className: "overlay", onClick: () => setResult(null), children: _jsxs("div", { className: "panel", onClick: (e) => e.stopPropagation(), children: [_jsxs("div", { className: "phead", children: [_jsx("span", { className: "sku big", children: result.filename }), _jsx("span", { className: "spacer" }), _jsx("button", { className: "x", onClick: () => setResult(null), children: "\u2715" })] }), _jsxs("div", { className: "sub", children: [result.exported_count, " order", result.exported_count !== 1 ? "s" : "", " exported", result.skipped_count > 0 ? ` · ${result.skipped_count} skipped (already posted)` : "", " \u00B7 batch ", result.batch_uuid] }), _jsxs("div", { className: "mvbar", style: { marginTop: 14 }, children: [_jsx("button", { className: "post", onClick: download, children: "Download file" }), _jsx("button", { className: "ghost", onClick: copy, children: "Copy" })] }), _jsx("textarea", { className: "exparea", readOnly: true, value: result.content })] }) }))] }));
}
