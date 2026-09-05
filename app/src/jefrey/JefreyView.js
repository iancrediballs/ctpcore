import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// CTP Core — Jefrey. Offline parts assistant: identify, quote, source,
// reconcile, pick, audit, ask. Everything runs against a local snapshot of the
// catalogue, so it works with no connection and answers in milliseconds.
import { Fragment, useEffect, useMemo, useRef, useState, useCallback } from "react";
import * as api from "../data/api";
import { fromRust, identify, memory, normalise, } from "./brain";
import { buildQuote, buildRFQ, buildPickList, auditCatalogue, ask, draftReply, reconcile, crossRefs, resolved, money, } from "./skills";
const SAMPLE = `Good morning Ian
Please quote the following for the JH6:
1) 2803035B1063 - 6 pcs
2) fender lh  x2
3) drivers door skin qty 3
4) bull bar bracket right hand - 5 pcs
5) mud flap rear x4
Thanks`;
/* ---------------------------------------------------------------- Jefrey */
function JefreyHead({ state }) {
    return (_jsxs("svg", { className: "jf-svg jf-" + state, viewBox: "0 0 120 132", width: "86", height: "95", children: [_jsxs("defs", { children: [_jsxs("linearGradient", { id: "jfsteel", x1: "0", y1: "0", x2: "0", y2: "1", children: [_jsx("stop", { offset: "0", stopColor: "#39444d" }), _jsx("stop", { offset: ".45", stopColor: "#242d34" }), _jsx("stop", { offset: "1", stopColor: "#161d22" })] }), _jsxs("linearGradient", { id: "jfsteel2", x1: "0", y1: "0", x2: "1", y2: "0", children: [_jsx("stop", { offset: "0", stopColor: "#1b2228" }), _jsx("stop", { offset: ".5", stopColor: "#2c363e" }), _jsx("stop", { offset: "1", stopColor: "#1b2228" })] }), _jsx("clipPath", { id: "jfvisor", children: _jsx("rect", { x: "26", y: "46", width: "68", height: "20", rx: "4" }) })] }), _jsxs("g", { className: "jf-head", children: [_jsx("rect", { x: "58.2", y: "6", width: "3.6", height: "14", fill: "#2b353d" }), _jsx("circle", { className: "jf-led", cx: "60", cy: "5", r: "3.4" }), _jsx("circle", { cx: "60", cy: "5", r: "6.5", fill: "currentColor", opacity: ".13" }), _jsx("rect", { x: "48", y: "98", width: "24", height: "10", fill: "#1a2126" }), _jsx("rect", { x: "38", y: "106", width: "44", height: "7", rx: "2", fill: "#232c33" }), _jsx("rect", { x: "14", y: "19", width: "92", height: "82", rx: "9", fill: "url(#jfsteel)", stroke: "#4a5761", strokeWidth: "1.2" }), _jsx("rect", { x: "20", y: "25", width: "80", height: "2", rx: "1", fill: "#4d5b66", opacity: ".55" }), [[23, 28], [97, 28], [23, 92], [97, 92]].map(([cx, cy]) => (_jsx("circle", { cx: cx, cy: cy, r: "2.6", fill: "#151b20", stroke: "#525f6a", strokeWidth: ".9" }, `${cx}-${cy}`))), _jsx("rect", { x: "6", y: "50", width: "9", height: "26", rx: "3", fill: "url(#jfsteel2)", stroke: "#3d4952" }), _jsx("rect", { x: "105", y: "50", width: "9", height: "26", rx: "3", fill: "url(#jfsteel2)", stroke: "#3d4952" }), _jsx("rect", { x: "24", y: "44", width: "72", height: "24", rx: "5", fill: "#080b0d", stroke: "#3d4952", strokeWidth: "1.1" }), _jsxs("g", { clipPath: "url(#jfvisor)", children: [_jsx("rect", { className: "jf-glow", x: "26", y: "46", width: "68", height: "20" }), _jsx("rect", { className: "jf-eye", x: "52", y: "49", width: "16", height: "14", rx: "3" }), _jsx("rect", { className: "jf-scan", x: "26", y: "42", width: "68", height: "1.6", fill: "#ffe0b0" })] }), _jsx("rect", { x: "34", y: "76", width: "52", height: "16", rx: "3", fill: "#12181c", stroke: "#333f47", strokeWidth: ".9" }), [79.5, 83.2, 86.9].map((y) => _jsx("rect", { x: "38", y: y, width: "44", height: "1.7", rx: ".8", fill: "#3b4750" }, y)), _jsx("text", { x: "60", y: "38", textAnchor: "middle", fontFamily: "ui-monospace,monospace", fontSize: "7.5", letterSpacing: "2.2", fill: "#5b6a75", children: "JFY-01" })] })] }));
}
/* ------------------------------------------------------------------ view */
export default function JefreyView() {
    const [cat, setCat] = useState([]);
    const [loading, setLoading] = useState(true);
    const [err, setErr] = useState(null);
    const [aliasN, setAliasN] = useState(0);
    const [mode, setMode] = useState("identify");
    const [text, setText] = useState("");
    const [rows, setRows] = useState([]);
    const [open, setOpen] = useState(null);
    const [panel, setPanel] = useState("none");
    const [ms, setMs] = useState(0);
    const [jstate, setJState] = useState("idle");
    const [say, setSay] = useState("Paste a customer request. I read it here on this machine — no connection needed.");
    const [toast, setToast] = useState(null);
    const [goodsText, setGoodsText] = useState("");
    const [goods, setGoods] = useState(null);
    const [question, setQuestion] = useState("");
    const [answer, setAnswer] = useState(null);
    const taRef = useRef(null);
    const flash = useCallback((m) => {
        setToast(m);
        window.setTimeout(() => setToast(null), 2800);
    }, []);
    /* ---- load the catalogue snapshot + everything Jefrey has been taught --- */
    const reload = useCallback(async () => {
        try {
            const [raw, aliases] = await Promise.all([
                api.jefreyCatalogue(),
                api.jefreyAliases(),
            ]);
            memory.load(aliases);
            setAliasN(memory.size);
            setCat(fromRust(raw));
            setErr(null);
        }
        catch (e) {
            setErr(String(e));
        }
        finally {
            setLoading(false);
        }
    }, []);
    useEffect(() => { void reload(); }, [reload]);
    const audit = useMemo(() => (cat.length ? auditCatalogue(cat) : null), [cat]);
    const quote = useMemo(() => (rows.length ? buildQuote(rows) : null), [rows]);
    const rfq = useMemo(() => (rows.length ? buildRFQ(rows) : null), [rows]);
    const pick = useMemo(() => (rows.length ? buildPickList(rows) : null), [rows]);
    const counts = useMemo(() => {
        const c = { confirmed: 0, probable: 0, contested: 0, uncertain: 0, unmatched: 0 };
        rows.forEach((r) => { c[r.status]++; });
        return c;
    }, [rows]);
    /* ---- run -------------------------------------------------------------- */
    function run() {
        if (!text.trim()) {
            setSay("Give me something to read.");
            return;
        }
        setJState("scanning");
        setSay(`Reading against ${cat.length} parts…`);
        window.setTimeout(() => {
            const t0 = performance.now();
            const out = identify(text, cat);
            setMs(Math.round((performance.now() - t0) * 10) / 10);
            setRows(out);
            setPanel("none");
            setOpen(null);
            const c = { confirmed: 0, probable: 0, contested: 0, uncertain: 0, unmatched: 0 };
            out.forEach((r) => { c[r.status]++; });
            const eyes = c.probable + c.contested + c.uncertain;
            if (!out.length) {
                setJState("void");
                setSay("Nothing in that text reads as a part request.");
                return;
            }
            if (c.unmatched === out.length) {
                setJState("void");
                setSay(`None of these are in the catalogue. ${c.unmatched} flagged for sourcing.`);
                return;
            }
            if (eyes) {
                setJState("ambiguous");
                setSay(`${c.confirmed} locked in. ${eyes} I won't guess on — open a row and set me straight.`);
            }
            else {
                setJState("confident");
                setSay(`${c.confirmed} of ${out.length} lines resolved outright.${c.unmatched ? ` ${c.unmatched} flagged for sourcing.` : ""}`);
            }
        }, 420);
    }
    /* ---- teach ------------------------------------------------------------ */
    async function teach(row, idx) {
        const cand = row.candidates[idx];
        if (!cand)
            return;
        memory.learn(row.phrase, cand.part.id);
        row.candidates.forEach((o, j) => { if (j !== idx)
            memory.reject(row.phrase, o.part.id); });
        try {
            await api.jefreyLearn(normalise(row.phrase), cand.part.id, 1);
            await Promise.all(row.candidates.filter((_, j) => j !== idx).map((o) => api.jefreyLearn(normalise(row.phrase), o.part.id, -1)));
        }
        catch (e) {
            flash("Saved in this session, but couldn't write it to the database: " + String(e));
        }
        setAliasN(memory.size);
        setRows((prev) => prev.map((r) => r !== row ? r : {
            ...r, chosen: idx, status: "confirmed",
            candidates: r.candidates.map((c, j) => j === idx ? { ...c, score: 100, why: "learned from your correction", contested: false } : c),
        }));
        setJState("confident");
        setSay(`Got it. "${row.phrase}" means ${cand.part.sku} from now on — that's saved, not just for today.`);
        flash(`Learned: "${row.phrase}" → ${cand.part.sku}`);
    }
    function pushOrder() {
        const ok = rows.filter((r) => r.status === "confirmed" && r.candidates[r.chosen]);
        const held = rows.length - ok.length;
        const val = ok.reduce((s, r) => s + r.qty * r.candidates[r.chosen].part.list, 0);
        flash(`${ok.length} lines → draft order · ${money(val)}${held ? ` · ${held} held back` : ""}`);
        setSay(held
            ? `Pushed ${ok.length}. Held ${held} — I'm not putting a guess on an invoice.`
            : `Draft order ready. ${ok.length} lines, ${money(val)}.`);
    }
    const copy = (s, label) => navigator.clipboard.writeText(s).then(() => flash(`${label} copied.`), () => flash("Clipboard blocked."));
    const csv = () => {
        const head = ["Qty", "Customer wording", "SKU", "Part name", "Inventory PN", "Bin", "On hand", "List ZAR", "Confidence", "Status"];
        const body = rows.map((r) => {
            const c = r.candidates[r.chosen];
            return [r.qty, r.phrase, c?.part.sku ?? "", c?.part.name ?? "*** NOT IN CATALOGUE ***",
                c?.part.inv_pn ?? "", c?.part.loc ?? "", c?.part.qty ?? "", c?.part.list ?? "",
                (c?.score ?? 0) + "%", r.status];
        });
        copy([head, ...body].map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n"), "Table");
    };
    if (loading)
        return _jsx("div", { className: "jf-boot", children: "Waking Jefrey\u2026" });
    if (err)
        return _jsxs("div", { className: "jf-boot jf-err", children: ["Jefrey couldn't read the catalogue: ", err] });
    return (_jsxs("div", { className: "jf-wrap", children: [_jsxs("div", { className: "jf-hdr", children: [_jsx(JefreyHead, { state: jstate }), _jsxs("div", { className: "jf-meta", children: [_jsxs("div", { className: "jf-name", children: ["JEFREY ", _jsx("span", { className: "jf-role", children: "parts identification unit" })] }), _jsx("div", { className: "jf-say", children: say }), _jsxs("div", { className: "jf-stats", children: [_jsxs("span", { children: [cat.length, " parts loaded"] }), _jsx("span", { className: "jf-dot", children: "\u00B7" }), _jsxs("span", { className: "jf-learned", title: "Corrections Jefrey has been taught \u2014 stored in the database", children: [aliasN, " learned aliases"] }), _jsx("span", { className: "jf-dot", children: "\u00B7" }), _jsx("span", { children: "local \u00B7 no network" }), ms > 0 && _jsxs(_Fragment, { children: [_jsx("span", { className: "jf-dot", children: "\u00B7" }), _jsxs("span", { children: [ms, " ms"] })] })] })] }), _jsx("div", { className: "jf-modes", children: ["identify", "goods", "ask", "audit"].map((m) => (_jsxs("button", { className: "jf-mode" + (mode === m ? " on" : ""), onClick: () => setMode(m), children: [m === "identify" ? "Identify" : m === "goods" ? "Goods-in" : m === "ask" ? "Ask" : "Audit", m === "audit" && audit?.tally.critical ? _jsx("b", { className: "jf-badge", children: audit.tally.critical }) : null] }, m))) })] }), mode === "identify" && (_jsxs(_Fragment, { children: [_jsxs("div", { className: "jf-input", children: [_jsx("textarea", { ref: taRef, value: text, spellCheck: false, placeholder: "Paste the WhatsApp message, email or order\u2026", onChange: (e) => setText(e.target.value), onKeyDown: (e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter")
                                    run(); } }), _jsxs("div", { className: "jf-inbtns", children: [_jsxs("button", { className: "jf-go", onClick: run, children: ["Identify parts ", _jsx("span", { className: "jf-kbd", children: "Ctrl \u21B5" })] }), _jsx("button", { className: "jf-ghost", onClick: () => { setText(SAMPLE); }, children: "Sample" }), _jsx("button", { className: "jf-ghost", onClick: () => { setText(""); setRows([]); setPanel("none"); setJState("idle"); setSay("Cleared."); }, children: "Clear" })] })] }), rows.length > 0 && (_jsxs(_Fragment, { children: [_jsxs("div", { className: "jf-strip", children: [_jsxs("span", { className: "jf-s", children: [_jsx("b", { children: rows.length }), " lines"] }), counts.confirmed > 0 && _jsxs("span", { className: "jf-s jf-ok", children: ["\u25CF ", _jsx("b", { children: counts.confirmed }), " confirmed"] }), counts.probable > 0 && _jsxs("span", { className: "jf-s jf-warn", children: ["\u25CF ", _jsx("b", { children: counts.probable }), " probable"] }), counts.contested > 0 && _jsxs("span", { className: "jf-s jf-cont", children: ["\u25CF ", _jsx("b", { children: counts.contested }), " contested"] }), counts.uncertain > 0 && _jsxs("span", { className: "jf-s jf-warn", children: ["\u25CF ", _jsx("b", { children: counts.uncertain }), " uncertain"] }), counts.unmatched > 0 && _jsxs("span", { className: "jf-s jf-bad", children: ["\u25CF ", _jsx("b", { children: counts.unmatched }), " source"] }), _jsx("span", { className: "jf-sp" }), _jsx("button", { className: "jf-act" + (panel === "quote" ? " on" : ""), onClick: () => setPanel(panel === "quote" ? "none" : "quote"), children: "Quote" }), _jsx("button", { className: "jf-act" + (panel === "rfq" ? " on" : ""), onClick: () => setPanel(panel === "rfq" ? "none" : "rfq"), children: "RFQ" }), _jsx("button", { className: "jf-act" + (panel === "pick" ? " on" : ""), onClick: () => setPanel(panel === "pick" ? "none" : "pick"), children: "Pick list" }), _jsx("button", { className: "jf-act" + (panel === "reply" ? " on" : ""), onClick: () => setPanel(panel === "reply" ? "none" : "reply"), children: "Reply" }), _jsx("button", { className: "jf-act", onClick: csv, children: "CSV" }), _jsx("button", { className: "jf-act jf-primary", onClick: pushOrder, children: "Push to order \u2192" })] }), _jsxs("table", { className: "jf-tbl", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { className: "jf-r", children: "Qty" }), _jsx("th", { children: "What they asked for" }), _jsx("th", { children: "Matched part" }), _jsx("th", { children: "Inventory PN" }), _jsx("th", { children: "Bin" }), _jsx("th", { className: "jf-r", children: "Stock" }), _jsx("th", { className: "jf-r", children: "List" }), _jsx("th", { children: "Confidence" })] }) }), _jsx("tbody", { children: rows.map((r) => {
                                            const c = r.candidates[r.chosen];
                                            const isOpen = open === r.key;
                                            return (_jsxs(Fragment, { children: [_jsxs("tr", { className: isOpen ? "jf-open" : "", onClick: () => setOpen(isOpen ? null : r.key), children: [_jsx("td", { className: "jf-qty", children: r.qty }), _jsxs("td", { className: "jf-req", children: [r.phrase, r.side && _jsx("span", { className: "jf-side", children: r.side })] }), c ? (_jsxs(_Fragment, { children: [_jsxs("td", { children: [_jsx("div", { className: "jf-pn-name" + (c.part.flag === "no_name" ? " jf-gap" : ""), children: c.part.name }), _jsxs("div", { className: "jf-sub", children: [c.part.sku, " \u00B7 ", c.part.section, c.part.side !== "-" ? " · " + c.part.side : ""] })] }), _jsxs("td", { className: "jf-pn", children: [c.part.inv_pn, c.part.cat_pn && c.part.cat_pn !== c.part.inv_pn && _jsxs("small", { children: ["cat ", c.part.cat_pn] })] }), _jsx("td", { className: "jf-loc", children: c.part.loc || "—" }), _jsx("td", { className: "jf-r jf-stk " + (c.part.qty === 0 ? "jf-bad" : c.part.qty <= 3 ? "jf-warn" : "jf-ok"), children: c.part.qty }), _jsx("td", { className: "jf-r jf-zar", children: money(c.part.list) }), _jsx("td", { children: _jsxs("span", { className: "jf-chip jf-c-" + r.status, children: [_jsxs("b", { children: [c.score, "%"] }), " ", r.status] }) })] })) : (_jsxs(_Fragment, { children: [_jsx("td", { colSpan: 5, className: "jf-bad", children: "Not in the catalogue \u2014 needs sourcing from the supplier" }), _jsx("td", { children: _jsxs("span", { className: "jf-chip jf-c-unmatched", children: [_jsx("b", { children: "\u2014" }), " source"] }) })] }))] }), isOpen && (_jsx("tr", { className: "jf-drawer", children: _jsx("td", { colSpan: 8, children: _jsxs("div", { className: "jf-dr", onClick: (e) => e.stopPropagation(), children: [_jsxs("div", { children: [_jsx("h4", { children: "How Jefrey got there" }), r.trace.map((t, i) => (_jsxs("div", { className: "jf-tr", children: [_jsx("span", { className: "jf-ts", children: t.step }), _jsx("span", { children: t.detail })] }, i))), c && _jsxs("div", { className: "jf-tr", children: [_jsx("span", { className: "jf-ts", children: "verdict" }), _jsx("span", { children: c.why })] }), c && crossRefs(c.part, cat).map((x, i) => (_jsxs("div", { className: "jf-tr jf-xref", children: [_jsx("span", { className: "jf-ts", children: x.kind }), _jsx("span", { children: x.note })] }, "x" + i)))] }), _jsxs("div", { children: [_jsx("h4", { children: r.candidates.length ? "Pick the right one — Jefrey remembers it for good" : "Nothing to pick from" }), r.candidates.map((cd, i) => (_jsxs("div", { className: "jf-alt" + (i === r.chosen ? " sel" : ""), children: [_jsxs("span", { className: "jf-altsc", children: [cd.score, "%"] }), _jsxs("span", { className: "jf-altnm", children: [cd.part.name, _jsxs("small", { children: [cd.part.sku, " \u00B7 ", cd.part.inv_pn, " \u00B7 ", cd.part.qty, " on hand"] })] }), _jsx("button", { onClick: () => void teach(r, i), children: i === r.chosen ? "CURRENT" : "THIS ONE" })] }, cd.part.id)))] })] }) }) }))] }, r.key));
                                        }) })] }), panel === "quote" && quote && (_jsxs("div", { className: "jf-panel", children: [_jsx("h3", { children: "Pro-forma" }), quote.negativeLines.length > 0 && (_jsxs("div", { className: "jf-alert", children: [quote.negativeLines.length, " line", quote.negativeLines.length > 1 ? "s are" : " is", " priced at or below landed cost (", quote.negativeLines.map((l) => l.part.sku).join(", "), "). Quoting this as it stands loses money on every unit."] })), _jsxs("table", { className: "jf-tbl jf-mini", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { className: "jf-r", children: "Qty" }), _jsx("th", { children: "Part" }), _jsx("th", { className: "jf-r", children: "Unit" }), _jsx("th", { className: "jf-r", children: "Line" }), _jsx("th", { className: "jf-r", children: "Margin" }), _jsx("th", { children: "Availability" })] }) }), _jsx("tbody", { children: quote.lines.map((l) => (_jsxs("tr", { children: [_jsx("td", { className: "jf-qty", children: l.qty }), _jsxs("td", { children: [l.part.name, _jsx("div", { className: "jf-sub", children: l.part.inv_pn })] }), _jsx("td", { className: "jf-r jf-zar", children: money(l.unit) }), _jsx("td", { className: "jf-r jf-zar", children: money(l.ext) }), _jsxs("td", { className: "jf-r jf-zar " + (l.negative ? "jf-bad" : l.margin < 0.2 ? "jf-warn" : "jf-ok"), children: [(l.margin * 100).toFixed(0), "%"] }), _jsx("td", { className: "jf-sub", children: l.back > 0 ? `${l.avail} now · ${l.back} on ${l.lead}` : l.lead })] }, l.part.id))) })] }), _jsxs("div", { className: "jf-totals", children: [_jsxs("div", { children: [_jsx("span", { children: "Subtotal" }), _jsx("b", { children: money(quote.sub) })] }), _jsxs("div", { children: [_jsx("span", { children: "VAT 15%" }), _jsx("b", { children: money(quote.vat) })] }), _jsxs("div", { className: "jf-grand", children: [_jsx("span", { children: "Total" }), _jsx("b", { children: money(quote.total) })] }), _jsxs("div", { children: [_jsx("span", { children: "Gross margin" }), _jsxs("b", { className: quote.margin < 0.15 ? "jf-bad" : "jf-ok", children: [(quote.margin * 100).toFixed(1), "%"] })] })] }), _jsx("div", { className: "jf-assume", children: quote.assumptions.map((a, i) => _jsx("span", { children: a }, i)) })] })), panel === "rfq" && rfq && (_jsxs("div", { className: "jf-panel", children: [_jsxs("h3", { children: ["Supplier RFQ ", _jsx("button", { className: "jf-ghost jf-sm", onClick: () => copy(rfq.text, "RFQ"), children: "Copy" })] }), _jsxs("div", { className: "jf-sub jf-mb", children: [rfq.shortfall, " shortfall line(s), ", rfq.unknown, " unidentified \u00B7 est. ", money(rfq.estCost), " at landed cost"] }), rfq.need.length ? _jsx("pre", { className: "jf-pre", children: rfq.text })
                                        : _jsx("div", { className: "jf-sub", children: "Nothing to source \u2014 everything on this request is on the shelf." })] })), panel === "pick" && pick && (_jsxs("div", { className: "jf-panel", children: [_jsx("h3", { children: "Pick list" }), _jsxs("div", { className: "jf-sub jf-mb", children: ["Route ", pick.route || "—", " \u00B7 ", pick.units, " units", pick.shorts.length ? ` · ${pick.shorts.length} short` : ""] }), _jsxs("table", { className: "jf-tbl jf-mini", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "Bin" }), _jsx("th", { className: "jf-r", children: "Pick" }), _jsx("th", { children: "Part" }), _jsx("th", { children: "Inventory PN" }), _jsx("th", {})] }) }), _jsx("tbody", { children: pick.items.map((i) => (_jsxs("tr", { children: [_jsx("td", { className: "jf-loc", children: _jsx("b", { children: i.loc.txt }) }), _jsx("td", { className: "jf-r jf-qty", children: i.pick }), _jsx("td", { children: i.part.name }), _jsx("td", { className: "jf-pn", children: i.part.inv_pn }), _jsx("td", { className: "jf-bad", children: i.short ? `${i.short} short` : "" })] }, i.part.id))) })] })] })), panel === "reply" && (_jsxs("div", { className: "jf-panel", children: [_jsxs("h3", { children: ["Reply to the customer ", _jsx("button", { className: "jf-ghost jf-sm", onClick: () => copy(draftReply(rows, quote), "Reply"), children: "Copy" })] }), _jsx("pre", { className: "jf-pre", children: draftReply(rows, quote) })] }))] }))] })), mode === "goods" && (_jsxs("div", { className: "jf-panel", children: [_jsx("h3", { children: "Goods-in reconciliation" }), _jsx("div", { className: "jf-sub jf-mb", children: rows.length
                            ? `Checking against the ${resolved(rows).length} identified line(s) from the Identify tab.`
                            : "Identify an order first — that becomes what Jefrey expects the shipment to contain." }), _jsx("textarea", { className: "jf-ta2", value: goodsText, spellCheck: false, placeholder: "Paste the supplier packing list — one line per part\n2803035B1063-DQ    6\n5103121-H02-G      2", onChange: (e) => setGoodsText(e.target.value) }), _jsx("div", { className: "jf-inbtns", children: _jsx("button", { className: "jf-go", disabled: !rows.length || !goodsText.trim(), onClick: () => {
                                const exp = resolved(rows).map(({ row, part }) => ({ part, qty: row.qty }));
                                const res = reconcile(goodsText, exp, cat);
                                setGoods(res);
                                const bad = (res.tally.short || 0) + (res.tally.over || 0) + (res.tally.unknown || 0);
                                setJState(bad ? "ambiguous" : "confident");
                                setSay(bad ? `${bad} discrepanc${bad === 1 ? "y" : "ies"} against what you ordered.` : "Shipment matches the order exactly.");
                            }, children: "Reconcile" }) }), goods && (_jsxs("table", { className: "jf-tbl jf-mini jf-mt", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "Status" }), _jsx("th", { children: "Part" }), _jsx("th", { className: "jf-r", children: "Ordered" }), _jsx("th", { className: "jf-r", children: "Received" }), _jsx("th", { children: "Note" })] }) }), _jsx("tbody", { children: goods.findings.map((f, i) => (_jsxs("tr", { children: [_jsx("td", { children: _jsx("span", { className: "jf-chip jf-g-" + f.sev, children: f.sev }) }), _jsx("td", { children: f.part ? _jsxs(_Fragment, { children: [f.part.name, _jsx("div", { className: "jf-sub", children: f.part.sku })] }) : _jsx("span", { className: "jf-sub", children: "\u2014" }) }), _jsx("td", { className: "jf-r jf-qty", children: f.want || "—" }), _jsx("td", { className: "jf-r jf-qty", children: f.got || "—" }), _jsx("td", { className: "jf-sub", children: f.note })] }, i))) })] }))] })), mode === "ask" && (_jsxs("div", { className: "jf-panel", children: [_jsx("h3", { children: "Ask Jefrey" }), _jsx("input", { className: "jf-q", value: question, placeholder: "how many mirrors do we have \u00B7 what's in bin A1 \u00B7 which parts are losing money \u00B7 what still needs a photo", onChange: (e) => setQuestion(e.target.value), onKeyDown: (e) => { if (e.key === "Enter" && question.trim()) {
                            setAnswer(ask(question, cat));
                            setJState("confident");
                        } } }), _jsx("div", { className: "jf-chips", children: ["stock value", "what's low on stock", "which parts are losing money", "what still needs a photo", "what's in bin A1", "how many mirrors"].map((s) => (_jsx("button", { className: "jf-suggest", onClick: () => { setQuestion(s); setAnswer(ask(s, cat)); }, children: s }, s))) }), answer && (_jsxs(_Fragment, { children: [_jsx("div", { className: "jf-answer", children: answer.answer }), _jsxs("div", { className: "jf-sql", title: "The rule Jefrey ran \u2014 he shows his working rather than asking you to trust him", children: [_jsx("span", { children: answer.rule }), " ", answer.sql] }), answer.table && answer.table.length > 0 && (_jsxs("table", { className: "jf-tbl jf-mini jf-mt", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "Part" }), _jsx("th", { children: "Inventory PN" }), _jsx("th", { children: "Bin" }), _jsx("th", { className: "jf-r", children: "On hand" }), _jsx("th", { className: "jf-r", children: "Cost" }), _jsx("th", { className: "jf-r", children: "List" })] }) }), _jsx("tbody", { children: answer.table.slice(0, 60).map((p) => (_jsxs("tr", { children: [_jsxs("td", { children: [p.name, _jsxs("div", { className: "jf-sub", children: [p.sku, " \u00B7 ", p.section] })] }), _jsx("td", { className: "jf-pn", children: p.inv_pn }), _jsx("td", { className: "jf-loc", children: p.loc || "—" }), _jsx("td", { className: "jf-r jf-stk " + (p.qty === 0 ? "jf-bad" : p.qty <= 3 ? "jf-warn" : "jf-ok"), children: p.qty }), _jsx("td", { className: "jf-r jf-zar", children: money(p.cost) }), _jsx("td", { className: "jf-r jf-zar " + (p.list > 0 && p.cost >= p.list ? "jf-bad" : ""), children: money(p.list) })] }, p.id))) })] })), answer.table && answer.table.length > 60 && _jsxs("div", { className: "jf-sub jf-mt", children: ["Showing the first 60 of ", answer.table.length, "."] })] }))] })), mode === "audit" && audit && (_jsxs("div", { className: "jf-panel", children: [_jsx("h3", { children: "Catalogue audit" }), _jsxs("div", { className: "jf-strip jf-nb", children: [_jsxs("span", { className: "jf-s", children: [_jsx("b", { children: audit.scanned }), " parts scanned"] }), ["critical", "high", "medium", "low"].map((s) => audit.tally[s]
                                ? _jsxs("span", { className: "jf-s jf-a-" + s, children: ["\u25CF ", _jsx("b", { children: audit.tally[s] }), " ", s] }, s) : null), audit.exposure > 0 && _jsxs("span", { className: "jf-s jf-bad", children: ["exposure ", _jsx("b", { children: money(audit.exposure) })] })] }), _jsx("div", { className: "jf-sub jf-mb", children: "Ranked by what costs you money, not by what was easiest to find. Exposure is the loss if every below-cost part on the shelf sold at its list price." }), _jsxs("table", { className: "jf-tbl jf-mini", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "Severity" }), _jsx("th", { children: "Issue" }), _jsx("th", { children: "Part" }), _jsx("th", { children: "Detail" }), _jsx("th", { className: "jf-r", children: "Cost" })] }) }), _jsx("tbody", { children: audit.findings.slice(0, 120).map((f, i) => (_jsxs("tr", { children: [_jsx("td", { children: _jsx("span", { className: "jf-chip jf-a-" + f.sev, children: f.sev }) }), _jsx("td", { className: "jf-pn", children: f.code }), _jsx("td", { children: f.part ? _jsxs(_Fragment, { children: [f.part.name, _jsxs("div", { className: "jf-sub", children: [f.part.sku, " \u00B7 ", f.part.loc || "no bin"] })] }) : "—" }), _jsx("td", { className: "jf-sub", children: f.detail }), _jsx("td", { className: "jf-r jf-zar", children: f.cost ? money(f.cost) : "" })] }, i))) })] }), audit.findings.length > 120 && _jsxs("div", { className: "jf-sub jf-mt", children: ["Showing the top 120 of ", audit.findings.length, "."] })] })), toast && _jsx("div", { className: "jf-toast", children: toast })] }));
}
