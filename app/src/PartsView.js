import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import * as api from "./data/api";
import { DetailPanel, money, stockClass, usePrefs } from "./App";
export default function PartsView() {
    const [rows, setRows] = useState([]);
    const [q, setQ] = useState("");
    const [cat, setCat] = useState("");
    const [sortKey, setSortKey] = useState("sku");
    const [dir, setDir] = useState(1);
    const [detail, setDetail] = useState(null);
    const prefs = usePrefs();
    const [cats, setCats] = useState([]);
    const [adding, setAdding] = useState(false);
    const [newName, setNewName] = useState("");
    const [newCat, setNewCat] = useState(null);
    const newRef = useRef(null);
    const [bin, setBin] = useState(false);
    const [deleted, setDeleted] = useState([]);
    const [note, setNote] = useState(null);
    const noteTimer = useRef(undefined);
    const load = useCallback(() => {
        api.listParts().then(setRows).catch(console.error);
        api.listDeletedParts().then(setDeleted).catch(console.error);
    }, []);
    useEffect(() => { load(); }, [load]);
    useEffect(() => { api.listCategories().then(setCats).catch(console.error); }, []);
    /* A retirement is reversible, so the right affordance is an undo, not a
       confirmation dialog nobody reads. Blocked deletes say why instead. */
    const say = useCallback((raw, undo, bad) => {
        // Tauri rejects with the plain string our command returned; a thrown JS
        // Error arrives prefixed. Strip it so the operator sees the message only.
        const text = raw.replace(/^Error:\s*/, "");
        window.clearTimeout(noteTimer.current);
        setNote({ text, undo, bad });
        noteTimer.current = window.setTimeout(() => setNote(null), undo ? 9000 : 5000);
    }, []);
    const openPart = useCallback(async (partId) => {
        try {
            setDetail(await api.partDetail(partId));
        }
        catch (e) {
            console.error(e);
        }
    }, []);
    const catCodes = useMemo(() => Array.from(new Set(rows.map((r) => r.category_code).filter(Boolean))).sort(), [rows]);
    const view = useMemo(() => {
        const t = q.trim().toLowerCase();
        const v = rows.filter((r) => (!cat || r.category_code === cat) &&
            (!t ||
                r.sku.toLowerCase().includes(t) ||
                r.name.toLowerCase().includes(t) ||
                (r.locator ?? "").toLowerCase().includes(t) ||
                (r.catalogue_pn ?? "").toLowerCase().includes(t) ||
                (r.inventory_pn ?? "").toLowerCase().includes(t)));
        return [...v].sort((a, b) => {
            const av = a[sortKey] ?? "", bv = b[sortKey] ?? "";
            if (av < bv)
                return -1 * dir;
            if (av > bv)
                return 1 * dir;
            return 0;
        });
    }, [rows, q, cat, sortKey, dir]);
    const sortBy = (k) => { if (k === sortKey)
        setDir((d) => (d === 1 ? -1 : 1));
    else {
        setSortKey(k);
        setDir(1);
    } };
    const arrow = (k) => (k === sortKey ? (dir === 1 ? " ▲" : " ▼") : "");
    /* ---- add ------------------------------------------------------------- */
    const startAdd = () => {
        setNewCat(cats.find((c) => c.code === cat)?.id ?? cats[0]?.id ?? null);
        setNewName("");
        setAdding(true);
        window.setTimeout(() => newRef.current?.focus(), 0);
    };
    const commitAdd = async () => {
        const name = newName.trim();
        if (!name || !newCat) {
            setAdding(false);
            return;
        }
        try {
            const id = await api.createPart(name, newCat);
            setAdding(false);
            load();
            openPart(id); // straight into the editor — no extra click
            say(`Added "${name}".`);
        }
        catch (e) {
            say(String(e), undefined, true);
        }
    };
    /* ---- delete / restore ------------------------------------------------ */
    const removePart = async (r, ev) => {
        ev.stopPropagation();
        try {
            const chk = await api.deletePart(r.id);
            load();
            if (detail?.id === r.id)
                setDetail(null);
            const stock = chk.on_hand !== 0 ? ` — it still had ${chk.on_hand} on hand` : "";
            const hist = chk.historic_lines > 0 ? `, and ${chk.historic_lines} past order line(s) still point at it` : "";
            say(`Retired ${chk.sku}${stock}${hist}.`, r.id);
        }
        catch (e) {
            say(String(e), undefined, true);
        }
    };
    const restore = async (id) => {
        try {
            await api.restorePart(id);
            load();
            say("Restored.");
        }
        catch (e) {
            say(String(e), undefined, true);
        }
    };
    return (_jsxs("div", { children: [_jsxs("div", { className: "ptbar", children: [_jsx("input", { className: "dgsearch", style: { maxWidth: 320 }, placeholder: "Search SKU, locator, OEM PN, name\u2026", value: q, onChange: (e) => setQ(e.target.value) }), _jsxs("select", { className: "locsel", value: cat, onChange: (e) => setCat(e.target.value), children: [_jsx("option", { value: "", children: "All categories" }), catCodes.map((c) => _jsx("option", { value: c, children: c }, c))] }), adding ? (_jsxs("span", { className: "addinline", children: [_jsx("select", { className: "locsel", value: newCat ?? "", onChange: (e) => setNewCat(Number(e.target.value)), children: cats.map((c) => _jsxs("option", { value: c.id, children: [c.code, " \u00B7 ", c.name] }, c.id)) }), _jsx("input", { ref: newRef, className: "dgsearch", style: { maxWidth: 260 }, placeholder: "Part name\u2026", value: newName, onChange: (e) => setNewName(e.target.value), onKeyDown: (e) => { if (e.key === "Enter")
                                    void commitAdd(); if (e.key === "Escape")
                                    setAdding(false); } }), _jsx("button", { className: "mini go", onClick: () => void commitAdd(), children: "Create" }), _jsx("button", { className: "mini", onClick: () => setAdding(false), children: "Cancel" })] })) : (_jsx("button", { className: "mini", onClick: startAdd, children: "\uFF0B New part" })), _jsx("span", { className: "spacer" }), deleted.length > 0 && (_jsxs("button", { className: "mini" + (bin ? " on" : ""), onClick: () => setBin((b) => !b), children: ["\uD83D\uDDD1 Deleted (", deleted.length, ")"] })), _jsxs("span", { className: "ptcount", children: [view.length, " of ", rows.length, " parts"] })] }), bin && (_jsxs("div", { className: "binpanel", children: [_jsx("div", { className: "binhead", children: "Retired parts \u2014 the row is kept so old invoices still resolve" }), _jsxs("table", { children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "SKU" }), _jsx("th", { children: "Name" }), _jsx("th", { children: "Cat" }), _jsx("th", { children: "OEM PN" }), _jsx("th", { children: "Retired" }), _jsx("th", {})] }) }), _jsx("tbody", { children: deleted.map((d) => (_jsxs("tr", { children: [_jsx("td", { className: "mono acc", children: d.sku }), _jsx("td", { children: d.name }), _jsx("td", { className: "dim", children: d.category_code ?? "—" }), _jsx("td", { className: "mono dim", children: d.inventory_pn ?? "—" }), _jsx("td", { className: "mono dim", children: d.deleted_at ?? "—" }), _jsx("td", { className: "num", children: _jsx("button", { className: "mini", onClick: () => void restore(d.id), children: "Restore" }) })] }, d.id))) })] })] })), _jsx("div", { className: "pttable", children: _jsxs("table", { children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsxs("th", { className: "srt", onClick: () => sortBy("sku"), children: ["SKU", arrow("sku")] }), _jsx("th", { children: "Locator" }), _jsxs("th", { className: "srt", onClick: () => sortBy("name"), children: ["Name", arrow("name")] }), _jsx("th", { children: "Side" }), _jsxs("th", { className: "srt", onClick: () => sortBy("category_code"), children: ["Cat", arrow("category_code")] }), _jsx("th", { children: "OEM PN" }), _jsxs("th", { className: "srt num", onClick: () => sortBy("qty_on_hand"), children: ["Qty", arrow("qty_on_hand")] }), _jsx("th", { children: "Bin" }), prefs.showStatus && _jsxs("th", { className: "srt", onClick: () => sortBy("status"), children: ["Status", arrow("status")] }), _jsx("th", { children: "Media" }), _jsx("th", { className: "num", children: "Price" }), _jsx("th", { className: "rmcol" })] }) }), _jsx("tbody", { children: view.map((r) => (_jsxs("tr", { onClick: () => openPart(r.id), children: [_jsx("td", { className: "mono acc", children: r.sku }), _jsx("td", { className: "mono dim", children: r.locator ?? "—" }), _jsx("td", { children: r.name }), _jsx("td", { className: "dim", children: r.side ?? "" }), _jsx("td", { className: "dim", children: r.category_code }), _jsx("td", { className: "mono dim", children: r.catalogue_pn ?? "—" }), _jsx("td", { className: "num", children: _jsx("span", { className: "qpill " + stockClass(r.qty_on_hand), children: r.qty_on_hand }) }), _jsx("td", { className: "mono dim", children: r.bin ?? "—" }), prefs.showStatus && (_jsx("td", { children: _jsx("span", { className: "stat " + (r.match_status === "NOT IN CAT" ? "warn" : ""), children: r.status }) })), _jsxs("td", { className: "media-ico", children: [_jsx("span", { className: r.has_photo ? "on" : "", title: "photo", children: "\u25A6" }), _jsx("span", { className: r.has_diagram ? "on" : "", title: "diagram", children: "\u25CE" }), _jsx("span", { className: r.has_model ? "on" : "", title: "3D model", children: "\u25F3" })] }), _jsx("td", { className: "num mono", children: money(r.price_cents) }), _jsx("td", { className: "rmcol", children: _jsx("button", { className: "rmbtn", title: `Retire ${r.sku}`, onClick: (e) => void removePart(r, e), children: "\u2715" }) })] }, r.id))) })] }) }), note && (_jsxs("div", { className: "ptnote" + (note.bad ? " bad" : ""), children: [_jsx("span", { children: note.text }), note.undo !== undefined && (_jsx("button", { className: "mini", onClick: () => { const id = note.undo; setNote(null); void restore(id); }, children: "Undo" }))] })), detail && _jsx(DetailPanel, { detail: detail, onClose: () => setDetail(null), onPosted: () => { openPart(detail.id); load(); } })] }));
}
