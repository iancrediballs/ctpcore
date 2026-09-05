import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// CTP Core — counter / sales / accounting shell + part detail with media.
import { useEffect, useRef, useState, useCallback } from "react";
import * as api from "./data/api";
import SalesView from "./SalesView";
import AccountingView from "./AccountingView";
import DiagramsView from "./DiagramsView";
import PartsView from "./PartsView";
import ExplorerView from "./ExplorerView";
import JefreyView from "./jefrey/JefreyView";
import { assetUrl, supportsModels } from "./assets";
// Where an asset lives depends on the surface — desktop bundle vs Storage CDN.
// See src/assets.ts; do not resolve paths inline again.
const asset = assetUrl;
const SIDE_LABEL = { L: "L/H", R: "R/H", C: "Centre", B: "Both" };
const PREFS_KEY = "ctp_prefs";
function loadPrefs() {
    try {
        return { showStatus: true, showNotes: true, ...JSON.parse(localStorage.getItem(PREFS_KEY) || "{}") };
    }
    catch {
        return { showStatus: true, showNotes: true };
    }
}
function savePrefs(p) {
    try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(p));
    }
    catch { /* ignore */ }
    window.dispatchEvent(new Event("ctp-prefs"));
}
export function usePrefs() {
    const [p, setP] = useState(loadPrefs);
    useEffect(() => {
        const h = () => setP(loadPrefs());
        window.addEventListener("ctp-prefs", h);
        return () => window.removeEventListener("ctp-prefs", h);
    }, []);
    return p;
}
// Every price in this database is South African rand, held as integer cents.
// This read "$" until 2026-09-05 — a leftover from the seed data, and wrong on
// every screen in the app: the counter, part detail, the order desk, and the
// accounting export queue all print through here. Thousands are spaced rather
// than comma'd, which is the SA convention and keeps R1 234 567,89-scale
// numbers scannable on a warehouse screen.
export const money = (c) => c == null ? "—" : "R" + (c / 100).toLocaleString("en-ZA", {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
});
export const stockClass = (n) => (n <= 0 ? "s-out" : n <= 5 ? "s-low" : "s-ok");
export default function App() {
    const [view, setView] = useState("counter");
    const [settings, setSettings] = useState(false);
    return (_jsxs("div", { className: "wrap" + (view === "parts" || view === "diagrams" || view === "explorer" || view === "jefrey" ? " wide" : ""), children: [_jsxs("div", { className: "brandbar", children: [_jsx("img", { className: "brandlogo", src: "/assets/brand/ctp_logo_light.svg", alt: "China Truck Parts" }), _jsx("span", { className: "corewm", children: "Core" }), _jsxs("nav", { className: "nav", children: [_jsx("button", { className: "navbtn" + (view === "counter" ? " on" : ""), onClick: () => setView("counter"), children: "Counter" }), _jsx("button", { className: "navbtn" + (view === "parts" ? " on" : ""), onClick: () => setView("parts"), children: "Parts" }), _jsx("button", { className: "navbtn" + (view === "sales" ? " on" : ""), onClick: () => setView("sales"), children: "Sales" }), _jsx("button", { className: "navbtn" + (view === "accounting" ? " on" : ""), onClick: () => setView("accounting"), children: "Accounting" }), _jsx("button", { className: "navbtn" + (view === "diagrams" ? " on" : ""), onClick: () => setView("diagrams"), children: "Diagrams" }), supportsModels && (_jsx("button", { className: "navbtn" + (view === "explorer" ? " on" : ""), onClick: () => setView("explorer"), children: "3D\u00A0Explorer" })), _jsx("button", { className: "navbtn" + (view === "jefrey" ? " on" : ""), onClick: () => setView("jefrey"), children: "Jefrey" })] }), _jsx("span", { className: "kpi", children: "local \u00B7 offline-ready" }), _jsx("button", { className: "gear", title: "Company settings", onClick: () => setSettings(true), children: "⚙" })] }), view === "counter" && _jsx(CounterView, {}), view === "parts" && _jsx(PartsView, {}), view === "sales" && _jsx(SalesView, {}), view === "accounting" && _jsx(AccountingView, {}), view === "diagrams" && _jsx(DiagramsView, {}), view === "explorer" && supportsModels && _jsx(ExplorerView, {}), view === "jefrey" && _jsx(JefreyView, {}), settings && _jsx(SettingsModal, { onClose: () => setSettings(false) })] }));
}
function SettingsModal({ onClose }) {
    const [c, setC] = useState(null);
    const [msg, setMsg] = useState("");
    const prefs = usePrefs();
    useEffect(() => { api.getCompany().then(setC).catch(console.error); }, []);
    if (!c)
        return null;
    const f = (k) => (e) => setC({ ...c, [k]: e.target.value });
    const save = async () => {
        try {
            await api.setCompany(c);
            setMsg("✓ saved");
        }
        catch (e) {
            setMsg("✕ " + String(e));
        }
    };
    return (_jsx("div", { className: "overlay", onClick: onClose, children: _jsxs("div", { className: "panel narrow", onClick: (ev) => ev.stopPropagation(), children: [_jsxs("div", { className: "phead", children: [_jsx("span", { className: "sku big", children: "Company profile" }), _jsx("span", { className: "spacer" }), _jsx("button", { className: "x", onClick: onClose, children: "✕" })] }), _jsx("div", { className: "sub", children: "appears as the letterhead on quotes & invoices" }), _jsxs("div", { className: "note-inline", children: ["This is ", _jsx("b", { children: "this machine\u2019s" }), " copy. Staff and roles, order emails, warehouses and pricing tiers live in the shared settings, along with the letterhead the phone app prints from.", _jsx("button", { className: "linkish", onClick: () => api.openUrl("https://ctp-core.vercel.app"), children: "Open shared settings \u203A" })] }), _jsxs("label", { className: "fld", children: ["Name", _jsx("input", { value: c.name, onChange: f("name") })] }), _jsxs("label", { className: "fld", children: ["Address", _jsx("input", { value: c.address ?? "", onChange: f("address") })] }), _jsxs("label", { className: "fld", children: ["Phone", _jsx("input", { value: c.phone ?? "", onChange: f("phone") })] }), _jsxs("label", { className: "fld", children: ["Email", _jsx("input", { value: c.email ?? "", onChange: f("email") })] }), _jsxs("label", { className: "fld", children: ["Tax ID", _jsx("input", { value: c.tax_id ?? "", onChange: f("tax_id") })] }), _jsxs("label", { className: "fld", children: ["Currency", _jsx("input", { value: c.currency, onChange: f("currency") })] }), _jsxs("label", { className: "fld", children: ["Terms", _jsx("textarea", { rows: 3, value: c.terms ?? "", onChange: f("terms") })] }), _jsx("button", { className: "post", style: { marginTop: 14 }, onClick: save, children: "Save" }), msg && _jsx("div", { className: "msg" + (msg.startsWith("✕") ? " err" : ""), children: msg }), _jsx("div", { className: "sub", style: { marginTop: 20 }, children: "Display \u2014 part detail" }), _jsxs("label", { className: "chk", children: [_jsx("input", { type: "checkbox", checked: prefs.showStatus, onChange: (e) => savePrefs({ ...prefs, showStatus: e.target.checked }) }), "Show Status tag (MATCHED / NOT IN CAT)"] }), _jsxs("label", { className: "chk", children: [_jsx("input", { type: "checkbox", checked: prefs.showNotes, onChange: (e) => savePrefs({ ...prefs, showNotes: e.target.checked }) }), "Show Discrepancy Notes"] })] }) }));
}
function CounterView() {
    const [q, setQ] = useState("");
    const [hits, setHits] = useState([]);
    const [busy, setBusy] = useState(false);
    const [sel, setSel] = useState(0);
    const [detail, setDetail] = useState(null);
    const inputRef = useRef(null);
    useEffect(() => { inputRef.current?.focus(); }, []);
    useEffect(() => {
        const term = q.trim();
        if (term.length < 2) {
            setHits([]);
            return;
        }
        let cancelled = false;
        setBusy(true);
        const t = setTimeout(async () => {
            try {
                const rows = await api.searchParts(term);
                if (!cancelled) {
                    setHits(rows);
                    setSel(0);
                }
            }
            catch (e) {
                console.error(e);
            }
            finally {
                if (!cancelled)
                    setBusy(false);
            }
        }, 120);
        return () => { cancelled = true; clearTimeout(t); };
    }, [q]);
    const openDetail = useCallback(async (partId) => {
        try {
            setDetail(await api.partDetail(partId));
        }
        catch (e) {
            console.error(e);
        }
    }, []);
    const refresh = useCallback(() => { if (detail)
        openDetail(detail.id); }, [detail, openDetail]);
    return (_jsxs("div", { children: [_jsxs("span", { className: "tag", children: ["// parts counter ", busy ? "· searching…" : ""] }), _jsx("div", { className: "searchbox", children: _jsx("input", { ref: inputRef, value: q, autoFocus: true, placeholder: "SKU, locator, OEM part no, name\u2026", onChange: (e) => setQ(e.target.value), onKeyDown: (e) => {
                        if (e.key === "ArrowDown") {
                            e.preventDefault();
                            setSel((s) => Math.min(s + 1, hits.length - 1));
                        }
                        else if (e.key === "ArrowUp") {
                            e.preventDefault();
                            setSel((s) => Math.max(s - 1, 0));
                        }
                        else if (e.key === "Enter" && hits[sel]) {
                            e.preventDefault();
                            openDetail(hits[sel].id);
                        }
                    } }) }), _jsxs("div", { className: "hint", children: ["Search by ", _jsx("b", { children: "any" }), " number \u2014 public SKU, locator, OEM / inventory PN, or name."] }), _jsx("div", { className: "count", children: q.trim().length < 2 ? "" : `${hits.length} result${hits.length !== 1 ? "s" : ""}` }), hits.map((h, i) => (_jsxs("div", { className: "card" + (i === sel ? " active" : ""), onClick: () => openDetail(h.id), children: [_jsxs("div", { className: "row1", children: [_jsx("span", { className: "sku", children: h.sku }), _jsx("span", { className: "nm", children: h.name }), h.brand && _jsx("span", { className: "brand", children: h.brand }), _jsx("span", { className: "spacer" }), _jsx("span", { className: "stock " + stockClass(h.on_hand), children: h.on_hand <= 0 ? "OUT" : h.on_hand + " on hand" }), _jsx("span", { className: "price", children: money(h.price_cents) })] }), _jsxs("div", { className: "why", children: ["matched ", h.matched_on, " \u2192 ", h.sku] })] }, h.id))), q.trim().length >= 2 && hits.length === 0 && !busy && (_jsxs("div", { className: "empty", children: ["no cross-reference found for \u201C", q, "\u201D"] })), detail && _jsx(DetailPanel, { detail: detail, onClose: () => setDetail(null), onPosted: refresh })] }));
}
const ACTIONS = [
    { key: "receipt", label: "Receive" },
    { key: "sale", label: "Issue / Sell" },
    { key: "adjustment", label: "Adjust" },
];
// Visual identification: three-tier identity + photo + exploded diagram (with
// the part's callout number) + optional 3D model. For sales / admin / stock-take.
function PartMedia({ detail, onChanged }) {
    const [sel, setSel] = useState(0);
    const [zoom, setZoom] = useState(null);
    const prefs = usePrefs();
    const fileRef = useRef(null);
    const imgs = detail.images ?? [];
    const photo = imgs[sel]?.path ?? (imgs[0]?.path ?? null);
    // Open an image in an in-app lightbox. window.open() is blocked inside the
    // Tauri webview, so clicks did nothing — the overlay below replaces it.
    const open = (p) => { if (p)
        setZoom(asset(p)); };
    const addPhoto = async (file) => {
        const buf = new Uint8Array(await file.arrayBuffer());
        try {
            await api.savePartImage(detail.id, file.name, Array.from(buf), "photo");
            onChanged?.();
        }
        catch (e) {
            console.error(e);
        }
    };
    const removeImg = async (id) => {
        try {
            await api.removePartImage(id);
            setSel(0);
            onChanged?.();
        }
        catch (e) {
            console.error(e);
        }
    };
    const makePrimary = async (id) => {
        try {
            await api.setPrimaryImage(id);
            onChanged?.();
        }
        catch (e) {
            console.error(e);
        }
    };
    return (_jsxs("div", { className: "media", children: [_jsxs("div", { className: "ident", children: [detail.locator && (_jsx("span", { className: "idtok locator", title: "Internal locator \u2014 find on the exploded diagram", children: detail.locator })), detail.catalogue_pn && (_jsxs("span", { className: "idtok oem", title: "OEM catalogue PN \u2014 order more stock with this", children: ["OEM ", detail.catalogue_pn] })), detail.inventory_pn && detail.inventory_pn !== detail.catalogue_pn && (_jsx("span", { className: "idtok inv", title: "Exact variant received", children: detail.inventory_pn })), detail.side && _jsx("span", { className: "idtok side", children: SIDE_LABEL[detail.side] ?? detail.side }), detail.category_name && _jsx("span", { className: "idtok cat", children: detail.category_name }), prefs.showStatus && detail.match_status && (_jsx("span", { className: "idtok ms " + (detail.match_status === "MATCHED" ? "ok" : "warn"), children: detail.match_status })), detail.list_price_minor != null && (_jsxs("span", { className: "idtok list", children: ["List R", (detail.list_price_minor / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })] }))] }), _jsxs("div", { className: "mediagrid", children: [_jsxs("div", { className: "mcell", children: [_jsxs("div", { className: "mlabel", children: ["Photo", _jsx("span", { className: "spacer" }), _jsx("button", { className: "mini", title: "Add photo", onClick: () => fileRef.current?.click(), children: "+ add" }), _jsx("input", { ref: fileRef, type: "file", accept: "image/*", style: { display: "none" }, onChange: (e) => { const fl = e.target.files?.[0]; if (fl)
                                            addPhoto(fl); e.currentTarget.value = ""; } })] }), photo
                                ? _jsx("img", { className: "mimg", src: asset(photo), alt: detail.name, onClick: () => open(photo) })
                                : _jsx("div", { className: "mph", children: "no photo yet" }), imgs.length > 0 && (_jsx("div", { className: "thumbs", children: imgs.map((im, i) => (_jsxs("div", { className: "thumbw" + (i === sel ? " on" : ""), children: [_jsx("img", { className: "thumb", src: asset(im.path), alt: "", onClick: () => setSel(i) }), !im.is_primary && _jsx("button", { className: "tbtn star", title: "Set as primary", onClick: () => makePrimary(im.id), children: "\u2605" }), _jsx("button", { className: "tbtn del", title: "Remove", onClick: () => removeImg(im.id), children: "\u2715" })] }, im.id))) }))] }), _jsxs("div", { className: "mcell", children: [_jsxs("div", { className: "mlabel", children: ["Diagram", detail.drawing_no ? " · " + detail.drawing_no : "", detail.diagram_item != null && _jsxs("span", { className: "callout", children: ["\u25B8 item ", detail.diagram_item] })] }), detail.diagram_image
                                ? _jsx("img", { className: "mimg", src: asset(detail.diagram_image), alt: "exploded view", referrerPolicy: "no-referrer", onClick: () => open(detail.diagram_image), onError: (e) => e.currentTarget.classList.add("broken") })
                                : _jsx("div", { className: "mph", children: "no diagram" })] })] }), detail.model_3d && supportsModels && (_jsxs("button", { className: "model3d", onClick: () => open(detail.model_3d), children: ["\u25F3 3D model \u2014 ", detail.inventory_pn ?? detail.sku, " \u21D7"] })), (detail.catalogue_pn || detail.inventory_pn) && (_jsx("button", { className: "srcbtn", title: "Look this part up on the supplier catalogue (rusauto43) \u2014 live price & isolated exploded view", onClick: () => api.openUrl("https://www.google.com/search?q=" +
                    encodeURIComponent("site:rusauto43.ru " + (detail.catalogue_pn || detail.inventory_pn))).catch(console.error), children: "\u20BD Check price & supplier exploded view \u21D7" })), prefs.showNotes && detail.notes && _jsxs("div", { className: "pnote", children: ["\u26A0 ", detail.notes] }), zoom && (_jsxs("div", { className: "lightbox", onClick: () => setZoom(null), children: [_jsx("img", { src: zoom, alt: "enlarged", referrerPolicy: "no-referrer", onClick: (e) => e.stopPropagation() }), _jsx("button", { className: "lbx", title: "Close (Esc)", onClick: () => setZoom(null), children: "\u2715" })] }))] }));
}
// Edit every field of a part. Loads category list; can auto-build the locator
// from Make-Model-Drawing-Item per the naming convention.
function PartEditForm({ detail, onSaved, onCancel }) {
    const [cats, setCats] = useState([]);
    const [msg, setMsg] = useState("");
    const [f, setF] = useState({
        name: detail.name,
        side: detail.side ?? "",
        make: detail.make ?? "",
        model: detail.model ?? "",
        drawing_no: detail.drawing_no ?? "",
        diagram_item_no: detail.diagram_item_no != null ? String(detail.diagram_item_no) : "",
        locator: detail.locator ?? "",
        catalogue_pn: detail.catalogue_pn ?? "",
        inventory_pn: detail.inventory_pn ?? "",
        mpn: detail.mpn ?? "",
        description: detail.description ?? "",
        status: detail.status ?? "active",
        match_status: detail.match_status ?? "",
        notes: detail.notes ?? "",
        list_price: detail.list_price_minor != null ? (detail.list_price_minor / 100).toFixed(2) : "",
        category_id: 0,
    });
    useEffect(() => {
        api.listCategories().then((c) => {
            setCats(c);
            const cur = c.find((x) => x.name === detail.category_name);
            setF((p) => ({ ...p, category_id: cur?.id ?? (c[0]?.id ?? 0) }));
        }).catch(console.error);
    }, []);
    const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }));
    const autoLoc = () => setF((p) => (p.make && p.model && p.drawing_no && p.diagram_item_no
        ? { ...p, locator: `${p.make}-${p.model}-${p.drawing_no}-${p.diagram_item_no.padStart(3, "0")}` } : p));
    const save = async () => {
        try {
            await api.updatePart(detail.id, {
                name: f.name, side: f.side || null, make: f.make || null, model: f.model || null,
                drawing_no: f.drawing_no || null, diagram_item_no: f.diagram_item_no ? parseInt(f.diagram_item_no, 10) : null,
                locator: f.locator || null, catalogue_pn: f.catalogue_pn || null, inventory_pn: f.inventory_pn || null,
                mpn: f.mpn || null, description: f.description || null, status: f.status,
                match_status: f.match_status || null, notes: f.notes || null, category_id: f.category_id,
                list_price_minor: f.list_price ? Math.round(parseFloat(f.list_price) * 100) : null,
            });
            onSaved();
        }
        catch (e) {
            setMsg("✕ " + String(e));
        }
    };
    return (_jsxs("div", { className: "editform", children: [_jsxs("label", { className: "fld2", children: ["Name", _jsx("input", { value: f.name, onChange: set("name") })] }), _jsxs("div", { className: "efrow", children: [_jsxs("label", { className: "fld2", children: ["Side", _jsxs("select", { value: f.side, onChange: set("side"), children: [_jsx("option", { value: "", children: "\u2014" }), _jsx("option", { value: "L", children: "L/H" }), _jsx("option", { value: "R", children: "R/H" }), _jsx("option", { value: "C", children: "Centre" }), _jsx("option", { value: "B", children: "Both" })] })] }), _jsxs("label", { className: "fld2", children: ["Category", _jsx("select", { value: f.category_id, onChange: (e) => setF((p) => ({ ...p, category_id: Number(e.target.value) })), children: cats.map((c) => _jsxs("option", { value: c.id, children: [c.code, " \u2014 ", c.name] }, c.id)) })] }), _jsxs("label", { className: "fld2", children: ["Status", _jsxs("select", { value: f.status, onChange: set("status"), children: [_jsx("option", { value: "active", children: "active" }), _jsx("option", { value: "superseded", children: "superseded" }), _jsx("option", { value: "discontinued", children: "discontinued" })] })] })] }), _jsxs("div", { className: "efrow", children: [_jsxs("label", { className: "fld2", children: ["Make", _jsx("input", { value: f.make, onChange: set("make") })] }), _jsxs("label", { className: "fld2", children: ["Model", _jsx("input", { value: f.model, onChange: set("model") })] }), _jsxs("label", { className: "fld2", children: ["Drawing", _jsx("input", { value: f.drawing_no, onChange: set("drawing_no") })] }), _jsxs("label", { className: "fld2", children: ["Item #", _jsx("input", { value: f.diagram_item_no, onChange: set("diagram_item_no") })] })] }), _jsxs("div", { className: "efrow", children: [_jsxs("label", { className: "fld2 grow", children: ["Locator", _jsx("input", { value: f.locator, onChange: set("locator") })] }), _jsx("button", { className: "ghost", onClick: autoLoc, title: "Build from Make-Model-Drawing-Item", children: "auto" })] }), _jsxs("div", { className: "efrow", children: [_jsxs("label", { className: "fld2", children: ["Catalogue PN (reorder)", _jsx("input", { value: f.catalogue_pn, onChange: set("catalogue_pn") })] }), _jsxs("label", { className: "fld2", children: ["Inventory PN (variant)", _jsx("input", { value: f.inventory_pn, onChange: set("inventory_pn") })] })] }), _jsxs("div", { className: "efrow", children: [_jsxs("label", { className: "fld2", children: ["MPN", _jsx("input", { value: f.mpn, onChange: set("mpn") })] }), _jsxs("label", { className: "fld2", children: ["Match status", _jsx("input", { value: f.match_status, onChange: set("match_status") })] }), _jsxs("label", { className: "fld2", children: ["List Price (ZAR)", _jsx("input", { value: f.list_price, onChange: set("list_price"), placeholder: "0.00" })] })] }), _jsxs("label", { className: "fld2", children: ["Description", _jsx("textarea", { rows: 2, value: f.description, onChange: set("description") })] }), _jsxs("label", { className: "fld2", children: ["Notes", _jsx("textarea", { rows: 2, value: f.notes, onChange: set("notes") })] }), _jsxs("div", { className: "efactions", children: [_jsx("button", { className: "post", onClick: save, children: "Save changes" }), _jsx("button", { className: "ghost", onClick: onCancel, children: "Cancel" }), msg && _jsx("span", { className: "msg err", children: msg })] })] }));
}
export function DetailPanel({ detail, onClose, onPosted }) {
    const [action, setAction] = useState("receipt");
    const [editing, setEditing] = useState(false);
    const [locId, setLocId] = useState(detail.stock[0]?.location_id ?? 1);
    const [qty, setQty] = useState("");
    const [msg, setMsg] = useState("");
    const [posting, setPosting] = useState(false);
    const qtyRef = useRef(null);
    useEffect(() => { qtyRef.current?.focus(); }, [action]);
    const post = useCallback(async () => {
        const n = parseInt(qty, 10);
        if (!Number.isFinite(n) || n === 0) {
            setMsg("enter a quantity");
            return;
        }
        let delta;
        if (action === "receipt")
            delta = Math.abs(n);
        else if (action === "sale")
            delta = -Math.abs(n);
        else
            delta = n;
        setPosting(true);
        setMsg("");
        try {
            const res = await api.postMovement(detail.id, locId, delta, action, crypto.randomUUID(), null);
            setMsg(res.duplicate
                ? "already posted (idempotent) — on hand " + res.on_hand
                : `posted · ${delta > 0 ? "+" : ""}${delta} → ${res.on_hand} on hand`);
            setQty("");
            onPosted();
        }
        catch (e) {
            setMsg("✕ " + String(e));
        }
        finally {
            setPosting(false);
        }
    }, [qty, action, locId, detail.id, onPosted]);
    return (_jsx("div", { className: "overlay", onClick: onClose, children: _jsxs("div", { className: "panel", onClick: (e) => e.stopPropagation(), children: [_jsxs("div", { className: "phead", children: [_jsx("span", { className: "sku big", children: detail.sku }), _jsx("span", { className: "nm", children: detail.name }), detail.brand && _jsx("span", { className: "brand", children: detail.brand }), _jsx("span", { className: "spacer" }), _jsx("span", { className: "price big", children: money(detail.price_cents) }), _jsx("button", { className: "x", onClick: () => setEditing((v) => !v), title: "Edit part", children: editing ? "↩" : "✎" }), _jsx("button", { className: "x", onClick: onClose, title: "Esc", children: "✕" })] }), editing
                    ? _jsx(PartEditForm, { detail: detail, onSaved: () => { setEditing(false); onPosted(); }, onCancel: () => setEditing(false) })
                    : _jsx(PartMedia, { detail: detail, onChanged: onPosted }), _jsx("div", { className: "stockgrid", children: detail.stock.map((s) => (_jsxs("div", { className: "sloc", children: [_jsx("div", { className: "slabel", children: s.location_name }), _jsx("div", { className: "sbig " + stockClass(s.on_hand), children: s.on_hand }), _jsxs("div", { className: "smeta", children: [s.bin ? "bin " + s.bin : "no bin", s.reorder_point != null && (_jsxs(_Fragment, { children: [" \u00B7 ROP ", s.reorder_point, s.on_hand <= s.reorder_point && _jsx("span", { className: "flag", children: " REORDER" })] }))] })] }, s.location_id))) }), _jsxs("div", { className: "mvbar", children: [_jsx("div", { className: "seg", children: ACTIONS.map((a) => (_jsx("button", { className: "segbtn" + (action === a.key ? " on" : ""), onClick: () => setAction(a.key), children: a.label }, a.key))) }), _jsx("select", { className: "locsel", value: locId, onChange: (e) => setLocId(Number(e.target.value)), children: detail.stock.map((s) => (_jsx("option", { value: s.location_id, children: s.location_code }, s.location_id))) }), _jsx("input", { ref: qtyRef, className: "qty", value: qty, onChange: (e) => setQty(e.target.value), onKeyDown: (e) => { if (e.key === "Enter") {
                                e.preventDefault();
                                post();
                            } }, placeholder: action === "adjustment" ? "± qty" : "qty", inputMode: "numeric" }), _jsx("button", { className: "post", onClick: post, disabled: posting, children: posting ? "…" : "Post ⏎" })] }), msg && _jsx("div", { className: "msg" + (msg.startsWith("✕") ? " err" : ""), children: msg }), _jsxs("div", { className: "count", children: ["ledger \u00B7 ", detail.total_on_hand, " total on hand"] }), _jsx("div", { className: "ledger", children: detail.ledger.map((r) => (_jsxs("div", { className: "lrow", children: [_jsx("span", { className: "lwhen", children: r.created_at }), _jsx("span", { className: "lloc", children: r.location_code }), _jsx("span", { className: "lreason r-" + r.reason, children: r.reason }), _jsxs("span", { className: "ldelta " + (r.delta >= 0 ? "pos" : "neg"), children: [r.delta > 0 ? "+" : "", r.delta] })] }, r.id))) })] }) }));
}
