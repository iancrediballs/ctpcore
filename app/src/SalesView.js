import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useEffect, useRef, useState, useCallback } from "react";
import * as api from "./data/api";
import { money, stockClass } from "./App";
import { buildDocHTML, openPrintWindow } from "./invoiceDoc";
const STATUS_ORDER = ["quote", "confirmed", "fulfilled", "invoiced"];
export default function SalesView() {
    const [orders, setOrders] = useState([]);
    const [open, setOpen] = useState(null);
    const [creating, setCreating] = useState(false);
    const loadOrders = useCallback(async () => {
        try {
            setOrders(await api.listOrders());
        }
        catch (e) {
            console.error(e);
        }
    }, []);
    useEffect(() => { loadOrders(); }, [loadOrders]);
    const openOrder = useCallback(async (id) => {
        try {
            setOpen(await api.getOrder(id));
        }
        catch (e) {
            console.error(e);
        }
    }, []);
    return (_jsxs(_Fragment, { children: [_jsxs("div", { className: "salesbar", children: [_jsx("span", { className: "tag", children: "// sales & quotes" }), _jsx("span", { className: "spacer" }), _jsx("button", { className: "post sm", onClick: () => setCreating(true), children: "+ New quote" })] }), _jsxs("div", { className: "count", children: [orders.length, " order", orders.length !== 1 ? "s" : ""] }), orders.map((o) => (_jsx("div", { className: "card", onClick: () => openOrder(o.id), children: _jsxs("div", { className: "row1", children: [_jsx("span", { className: "sku", children: o.number }), _jsx("span", { className: "nm", children: o.customer_name }), _jsx("span", { className: "sbadge st-" + o.status, children: o.status }), _jsx("span", { className: "spacer" }), _jsxs("span", { className: "why", style: { margin: 0 }, children: [o.line_count, " item", o.line_count !== 1 ? "s" : ""] }), _jsx("span", { className: "price", children: money(o.subtotal_minor) })] }) }, o.id))), orders.length === 0 && _jsx("div", { className: "empty", children: "no orders yet \u2014 start a quote" }), creating && (_jsx(NewQuote, { onClose: () => setCreating(false), onCreated: (d) => { setCreating(false); loadOrders(); setOpen(d); } })), open && (_jsx(OrderPanel, { order: open, onClose: () => { setOpen(null); loadOrders(); }, onChange: (d) => { setOpen(d); }, afterMutation: loadOrders }))] }));
}
function NewQuote({ onClose, onCreated }) {
    const [custs, setCusts] = useState([]);
    const [locs, setLocs] = useState([]);
    const [cust, setCust] = useState(null);
    const [loc, setLoc] = useState(null);
    const [err, setErr] = useState("");
    useEffect(() => {
        (async () => {
            const c = await api.listCustomers();
            const l = await api.listLocations();
            setCusts(c);
            setLocs(l);
            setCust(c[0]?.id ?? null);
            setLoc(l[0]?.id ?? null);
        })();
    }, []);
    const create = async () => {
        if (cust == null || loc == null)
            return;
        try {
            const d = await api.createOrder(cust, loc);
            onCreated(d);
        }
        catch (e) {
            setErr(String(e));
        }
    };
    return (_jsx("div", { className: "overlay", onClick: onClose, children: _jsxs("div", { className: "panel narrow", onClick: (e) => e.stopPropagation(), children: [_jsxs("div", { className: "phead", children: [_jsx("span", { className: "sku big", children: "New quote" }), _jsx("span", { className: "spacer" }), _jsx("button", { className: "x", onClick: onClose, children: "\u2715" })] }), _jsxs("label", { className: "fld", children: ["Customer", _jsx("select", { value: cust ?? "", onChange: (e) => setCust(Number(e.target.value)), children: custs.map((c) => _jsxs("option", { value: c.id, children: [c.name, " \u00B7 ", c.price_tier] }, c.id)) })] }), _jsxs("label", { className: "fld", children: ["Fulfill from", _jsx("select", { value: loc ?? "", onChange: (e) => setLoc(Number(e.target.value)), children: locs.map((l) => _jsx("option", { value: l.id, children: l.name }, l.id)) })] }), err && _jsxs("div", { className: "msg err", children: ["\u2715 ", err] }), _jsx("button", { className: "post", style: { marginTop: 14 }, onClick: create, children: "Create quote" })] }) }));
}
function OrderPanel({ order, onClose, onChange, afterMutation }) {
    const editable = order.status === "quote" || order.status === "confirmed";
    const [q, setQ] = useState("");
    const [hits, setHits] = useState([]);
    const [msg, setMsg] = useState("");
    const searchRef = useRef(null);
    useEffect(() => {
        const t = setTimeout(async () => {
            if (q.trim().length < 2) {
                setHits([]);
                return;
            }
            try {
                setHits(await api.searchParts(q));
            }
            catch { /* noop */ }
        }, 90);
        return () => clearTimeout(t);
    }, [q]);
    const mut = async (fn, ok) => {
        try {
            const d = await fn();
            onChange(d);
            afterMutation();
            if (ok)
                setMsg(ok);
        }
        catch (e) {
            setMsg("✕ " + String(e));
        }
    };
    const addPart = (partId) => mut(() => api.addLine(order.id, partId, 1));
    const fulfill = () => mut(() => api.fulfillOrder(order.id), "fulfilled — stock issued through the ledger");
    const setStatus = (status) => mut(() => api.setStatus(order.id, status));
    const printDoc = async () => {
        try {
            const company = await api.getCompany();
            openPrintWindow(buildDocHTML(order, company));
        }
        catch (e) {
            setMsg("✕ " + String(e));
        }
    };
    const stepIdx = STATUS_ORDER.indexOf(order.status);
    return (_jsx("div", { className: "overlay", onClick: onClose, children: _jsxs("div", { className: "panel", onClick: (e) => e.stopPropagation(), children: [_jsxs("div", { className: "phead", children: [_jsx("span", { className: "sku big", children: order.number }), _jsx("span", { className: "nm", children: order.customer_name }), _jsx("span", { className: "brand", children: order.customer_tier }), _jsx("span", { className: "sbadge st-" + order.status, children: order.status }), _jsx("span", { className: "spacer" }), _jsx("button", { className: "x", onClick: onClose, title: "Esc", children: "\u2715" })] }), _jsxs("div", { className: "sub", children: ["fulfills from ", order.location_code, " \u00B7 opened ", order.created_at, order.fulfilled_at ? " · fulfilled " + order.fulfilled_at : ""] }), _jsxs("div", { className: "rail", children: [STATUS_ORDER.map((s, i) => (_jsx("span", { className: "step" + (i <= stepIdx ? " done" : "") + (i === stepIdx ? " now" : ""), children: s }, s))), order.status === "cancelled" && _jsx("span", { className: "step now st-cancelled", children: "cancelled" })] }), editable && (_jsxs(_Fragment, { children: [_jsx("div", { className: "searchbox sm", children: _jsx("input", { ref: searchRef, value: q, onChange: (e) => setQ(e.target.value), placeholder: "add part \u2014 search #, competitor #, brand\u2026" }) }), hits.length > 0 && (_jsx("div", { className: "addlist", children: hits.slice(0, 6).map((h) => (_jsxs("div", { className: "arow", onClick: () => { addPart(h.id); setQ(""); setHits([]); searchRef.current?.focus(); }, children: [_jsx("span", { className: "sku", children: h.sku }), _jsx("span", { className: "nm", children: h.name }), _jsx("span", { className: "spacer" }), _jsx("span", { className: "stock " + stockClass(h.on_hand), children: h.on_hand <= 0 ? "OUT" : h.on_hand }), _jsx("span", { className: "price", children: money(h.price_cents) }), _jsx("span", { className: "addbtn", children: "+ add" })] }, h.id))) }))] })), _jsxs("div", { className: "count", children: [order.lines.length, " line", order.lines.length !== 1 ? "s" : ""] }), _jsxs("div", { className: "lines", children: [order.lines.map((l) => (_jsxs("div", { className: "litem", children: [_jsx("span", { className: "sku", children: l.sku }), _jsx("span", { className: "nm", children: l.name }), l.qty > l.on_hand && _jsxs("span", { className: "flag", title: "short on stock", children: ["\u26A0 ", l.on_hand, " avail"] }), _jsx("span", { className: "spacer" }), editable ? (_jsx("input", { className: "qty xs", defaultValue: l.qty, onBlur: (e) => {
                                        const v = parseInt(e.target.value, 10);
                                        if (Number.isFinite(v) && v > 0 && v !== l.qty)
                                            mut(() => api.updateLineQty(l.id, v));
                                    }, onKeyDown: (e) => { if (e.key === "Enter")
                                        e.target.blur(); } })) : (_jsx("span", { className: "qtystatic", children: l.qty })), _jsxs("span", { className: "uprice", children: ["@ ", money(l.unit_price_minor)] }), _jsx("span", { className: "price", children: money(l.line_total_minor) }), editable && _jsx("button", { className: "x sm", title: "remove", onClick: () => mut(() => api.removeLine(l.id)), children: "\u2715" })] }, l.id))), order.lines.length === 0 && _jsx("div", { className: "empty", children: "no lines \u2014 search above to add parts" })] }), _jsxs("div", { className: "totals", children: [_jsxs("div", { className: "trow", children: [_jsx("span", { className: "spacer" }), _jsx("span", { className: "totlabel", children: "Subtotal" }), _jsx("span", { className: "tnum", children: money(order.subtotal_minor) })] }), _jsxs("div", { className: "trow", children: [_jsx("span", { className: "spacer" }), _jsxs("span", { className: "totlabel", children: ["Tax", editable ? (_jsx("input", { className: "taxin", defaultValue: (order.tax_rate_bps / 100).toString(), title: "tax %", onBlur: (e) => {
                                                const pct = parseFloat(e.target.value);
                                                const bps = Math.round((Number.isFinite(pct) ? pct : 0) * 100);
                                                if (bps !== order.tax_rate_bps)
                                                    mut(() => api.setTaxRate(order.id, bps));
                                            }, onKeyDown: (e) => { if (e.key === "Enter")
                                                e.target.blur(); } })) : (_jsxs(_Fragment, { children: [" ", (order.tax_rate_bps / 100).toFixed(2), "%"] }))] }), _jsx("span", { className: "tnum", children: money(order.tax_minor) })] }), _jsxs("div", { className: "trow grand", children: [_jsx("span", { className: "spacer" }), _jsx("span", { className: "totlabel", children: "Total" }), _jsx("span", { className: "tot", children: money(order.total_minor) })] })] }), _jsxs("div", { className: "actbar", children: [order.status === "quote" && _jsx("button", { className: "ghost", onClick: () => setStatus("confirmed"), children: "Confirm" }), order.status === "confirmed" && _jsx("button", { className: "ghost", onClick: () => setStatus("quote"), children: "\u2190 Back to quote" }), (order.status === "quote" || order.status === "confirmed") && (_jsx("button", { className: "ghost danger", onClick: () => setStatus("cancelled"), children: "Cancel" })), _jsx("button", { className: "ghost", onClick: printDoc, children: order.status === "quote" || order.status === "confirmed" ? "Print quote" : "Print invoice" }), _jsx("span", { className: "spacer" }), editable && (_jsx("button", { className: "post", disabled: order.lines.length === 0, onClick: fulfill, children: "Fulfill \u2192 issue stock" })), order.status === "fulfilled" && _jsx("button", { className: "post", onClick: () => setStatus("invoiced"), children: "Mark invoiced" })] }), msg && _jsx("div", { className: "msg" + (msg.startsWith("✕") ? " err" : ""), children: msg })] }) }));
}
