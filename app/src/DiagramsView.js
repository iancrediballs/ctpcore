import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useEffect, useRef, useState, useCallback } from "react";
import * as api from "./data/api";
import { DetailPanel } from "./App";
import { assetUrl } from "./assets";
// Was a local copy that always prefixed "/" — which also mangled the absolute
// rusauto URLs some diagram rows carry. src/assets.ts passes those through.
const asset = assetUrl;
export default function DiagramsView() {
    const [list, setList] = useState([]);
    const [curId, setCurId] = useState(null);
    const [diag, setDiag] = useState(null);
    const [detail, setDetail] = useState(null);
    const [zoom, setZoom] = useState(900);
    const [q, setQ] = useState("");
    const [edit, setEdit] = useState(false);
    const [adding, setAdding] = useState(false);
    const [selHot, setSelHot] = useState(null);
    const [assignQ, setAssignQ] = useState("");
    const [assignHits, setAssignHits] = useState([]);
    const [dragId, setDragId] = useState(null);
    const [natDims, setNatDims] = useState(null);
    const [, setTick] = useState(0);
    const dragPos = useRef(null);
    const moved = useRef(false);
    const imgRef = useRef(null);
    const upRef = useRef(null);
    const loadList = useCallback(() => {
        api.listDiagrams().then(setList).catch(console.error);
    }, []);
    useEffect(() => { loadList(); }, [loadList]);
    useEffect(() => {
        if (list.length && curId == null) {
            const first = list.find((x) => x.hotspot_count > 0) ?? list[0];
            if (first)
                setCurId(first.id);
        }
    }, [list, curId]);
    const reload = useCallback(() => {
        if (curId == null)
            return;
        api.getDiagram(curId).then(setDiag).catch(console.error);
    }, [curId]);
    useEffect(() => { reload(); setSelHot(null); setNatDims(null); }, [curId, reload]);
    const openPart = useCallback(async (partId) => {
        if (partId == null)
            return;
        try {
            setDetail(await api.partDetail(partId));
        }
        catch (e) {
            console.error(e);
        }
    }, []);
    const effW = () => (diag?.img_w || natDims?.w || 0);
    const effH = () => (diag?.img_h || natDims?.h || 0);
    const imgCoords = (e) => {
        const img = imgRef.current;
        const w = effW(), h = effH();
        if (!img || !w || !h)
            return null;
        const r = img.getBoundingClientRect();
        return { x: ((e.clientX - r.left) / r.width) * w, y: ((e.clientY - r.top) / r.height) * h };
    };
    const hot = (id) => diag?.hotspots.find((h) => h.id === id) ?? null;
    // drag a marker to reposition it (commit on release)
    const startDrag = (h, e) => {
        if (!edit)
            return;
        e.stopPropagation();
        setSelHot(h.id);
        moved.current = false;
        dragPos.current = { x: h.x, y: h.y };
        setDragId(h.id);
    };
    useEffect(() => {
        if (dragId == null)
            return;
        const move = (e) => { const c = imgCoords(e); if (!c)
            return; dragPos.current = c; moved.current = true; setTick((t) => t + 1); };
        const up = async () => {
            window.removeEventListener("pointermove", move);
            const id = dragId, pos = dragPos.current;
            setDragId(null);
            if (moved.current && pos) {
                const h = hot(id);
                try {
                    await api.updateHotspot(id, pos.x, pos.y, h?.part_id ?? null, h?.item_no ?? null);
                    reload();
                }
                catch (e) {
                    console.error(e);
                }
            }
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up, { once: true });
        return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    }, [dragId]); // eslint-disable-line react-hooks/exhaustive-deps
    const onCanvasClick = async (e) => {
        if (!edit || curId == null || !adding)
            return;
        const c = imgCoords(e);
        if (!c)
            return;
        try {
            const id = await api.addHotspot(curId, c.x, c.y, null, null);
            reload();
            setSelHot(id);
            setAdding(false);
        }
        catch (err) {
            console.error(err);
        }
    };
    const assignPart = async (h, partId) => {
        try {
            await api.updateHotspot(h.id, h.x, h.y, partId, h.item_no);
            reload();
            setAssignQ("");
            setAssignHits([]);
        }
        catch (e) {
            console.error(e);
        }
    };
    const setItem = async (h, val) => {
        try {
            await api.updateHotspot(h.id, h.x, h.y, h.part_id, val || null);
            reload();
        }
        catch (e) {
            console.error(e);
        }
    };
    const delHot = async (id) => {
        try {
            await api.deleteHotspot(id);
            setSelHot(null);
            reload();
            loadList();
        }
        catch (e) {
            console.error(e);
        }
    };
    useEffect(() => {
        const t = assignQ.trim();
        if (t.length < 2) {
            setAssignHits([]);
            return;
        }
        let cx = false;
        api.searchParts(t).then((r) => { if (!cx)
            setAssignHits(r); }).catch(console.error);
        return () => { cx = true; };
    }, [assignQ]);
    const uploadDiagram = async (file) => {
        const url = URL.createObjectURL(file);
        const im = new Image();
        try {
            await new Promise((res, rej) => { im.onload = () => res(null); im.onerror = rej; im.src = url; });
        }
        catch {
            URL.revokeObjectURL(url);
            return;
        }
        const w = im.naturalWidth, h = im.naturalHeight;
        URL.revokeObjectURL(url);
        const buf = new Uint8Array(await file.arrayBuffer());
        try {
            const newId = await api.saveDiagram(file.name, Array.from(buf), file.name.replace(/\.[^.]+$/, ""), w, h);
            loadList();
            setCurId(newId);
            setEdit(true);
        }
        catch (e) {
            console.error(e);
        }
    };
    const deleteDiagram = async () => {
        if (curId == null)
            return;
        if (!confirm("Delete this diagram and its hotspots? (Parts are not affected.)"))
            return;
        try {
            await api.deleteDiagram(curId);
            setCurId(null);
            setDiag(null);
            setSelHot(null);
            loadList();
        }
        catch (e) {
            console.error(e);
        }
    };
    const shown = list.filter((d) => !q.trim() || d.title.toLowerCase().includes(q.toLowerCase()) || d.drawing_key.toLowerCase().includes(q.toLowerCase()));
    const sel = hot(selHot);
    const markPos = (h) => (dragId === h.id && dragPos.current ? dragPos.current : { x: h.x, y: h.y });
    return (_jsxs("div", { className: "dgwrap2", children: [_jsxs("div", { className: "dgside", children: [_jsx("input", { className: "dgsearch", placeholder: "Filter diagrams\u2026", value: q, onChange: (e) => setQ(e.target.value) }), _jsx("button", { className: "mini upbtn", onClick: () => upRef.current?.click(), children: "\u2B06 Upload diagram" }), _jsx("input", { ref: upRef, type: "file", accept: "image/*", style: { display: "none" }, onChange: (e) => { const fl = e.target.files?.[0]; if (fl)
                            uploadDiagram(fl); e.currentTarget.value = ""; } }), shown.map((d) => (_jsxs("div", { className: "dgitem" + (d.id === curId ? " on" : ""), onClick: () => setCurId(d.id), children: [_jsx("span", { className: "dgkey", children: d.drawing_key }), _jsx("span", { className: "dgtitle", children: d.title }), _jsx("span", { className: "dgcount" + (d.hotspot_count ? "" : " zero"), children: d.hotspot_count })] }, d.id)))] }), _jsxs("div", { className: "dgmain", children: [diag && (_jsxs("div", { className: "dghead", children: [_jsx("b", { children: diag.drawing_key }), " ", _jsx("span", { className: "dghname", children: diag.title }), _jsx("span", { className: "spacer" }), edit ? (_jsxs(_Fragment, { children: [_jsx("button", { className: "mini" + (adding ? " act" : ""), onClick: () => setAdding((v) => !v), children: "\uFF0B hotspot" }), _jsx("span", { className: "dghint", children: adding ? "click the drawing to drop a marker" : "drag a marker to move · click to edit" })] })) : (_jsxs("span", { className: "dghint", children: [diag.hotspots.length, " hotspot", diag.hotspots.length !== 1 ? "s" : "", " \u00B7 click a number"] })), edit && _jsx("button", { className: "zbtn del", title: "Delete this diagram", onClick: deleteDiagram, children: "\uD83D\uDDD1" }), _jsx("button", { className: "zbtn edit" + (edit ? " on" : ""), title: "Edit hotspots", onClick: () => { setEdit((v) => !v); setAdding(false); setSelHot(null); }, children: "\u270E" }), _jsx("button", { className: "zbtn", onClick: () => setZoom((z) => Math.max(400, z - 250)), children: "\u2212" }), _jsx("button", { className: "zbtn", onClick: () => setZoom((z) => Math.min(4000, z + 250)), children: "+" })] })), edit && sel && (_jsxs("div", { className: "hotedit", children: [_jsxs("span", { className: "hetag", children: ["Hotspot #", sel.item_no ?? "—"] }), _jsx("input", { className: "heitem", placeholder: "item #", defaultValue: sel.item_no ?? "", onBlur: (e) => setItem(sel, e.target.value) }), sel.part_id ? _jsxs("span", { className: "helink", children: ["\u2192 ", sel.sku, " \u00B7 ", sel.name] }) : _jsx("span", { className: "helink unl", children: "no part linked" }), _jsx("input", { className: "hesearch", placeholder: "assign part: SKU / PN / name\u2026", value: assignQ, onChange: (e) => setAssignQ(e.target.value) }), _jsx("button", { className: "mini del", onClick: () => delHot(sel.id), children: "delete" }), assignHits.length > 0 && (_jsx("div", { className: "heresults", children: assignHits.slice(0, 6).map((h) => (_jsxs("div", { className: "herow", onClick: () => assignPart(sel, h.id), children: [_jsx("span", { className: "sku", children: h.sku }), " ", _jsx("span", { className: "nm", children: h.name })] }, h.id))) }))] })), _jsx("div", { className: "dgstage", children: diag?.image_path ? (_jsxs("div", { className: "dgcanvas" + (edit && adding ? " placing" : ""), style: { width: zoom }, children: [_jsx("img", { ref: imgRef, className: "dgimg", src: asset(diag.image_path), alt: diag.title, draggable: false, onClick: onCanvasClick, onLoad: (e) => { if (!diag.img_w || !diag.img_h)
                                        setNatDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight }); } }), (diag.img_w || natDims) && diag.hotspots.map((h) => {
                                    const p = markPos(h);
                                    return (_jsx("button", { className: "dgmk" + (h.part_id ? "" : " unl") + (edit && h.id === selHot ? " sel" : "") + (edit ? " drag" : ""), style: { left: (p.x / effW()) * 100 + "%", top: (p.y / effH()) * 100 + "%" }, title: h.name ? `${h.item_no ? "#" + h.item_no + " · " : ""}${h.name}` : "unlinked", onPointerDown: (e) => startDrag(h, e), onClick: (e) => { e.stopPropagation(); if (moved.current) {
                                            moved.current = false;
                                            return;
                                        } if (edit)
                                            setSelHot(h.id);
                                        else
                                            openPart(h.part_id); }, children: h.item_no ?? "•" }, h.id));
                                })] })) : _jsx("div", { className: "dgempty", children: "select or upload a diagram" }) })] }), detail && _jsx(DetailPanel, { detail: detail, onClose: () => setDetail(null), onPosted: () => openPart(detail.id) })] }));
}
