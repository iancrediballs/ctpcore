import { useEffect, useRef, useState, useCallback } from "react";
import * as api from "./data/api";
import { DetailPanel, type PartDetail, type Hit } from "./App";
import { assetUrl } from "./assets";

// Was a local copy that always prefixed "/" — which also mangled the absolute
// rusauto URLs some diagram rows carry. src/assets.ts passes those through.
const asset = assetUrl;

type DiagramSummary = {
  id: number; drawing_key: string; title: string;
  section_code: string | null; image_path: string | null; hotspot_count: number;
};
type Hotspot = {
  id: number; part_id: number | null; sku: string | null; locator: string | null;
  name: string | null; item_no: string | null; x: number; y: number; radius: number;
};
type DiagramFull = {
  id: number; drawing_key: string; title: string; image_path: string | null;
  img_w: number | null; img_h: number | null; hotspots: Hotspot[];
};

export default function DiagramsView() {
  const [list, setList] = useState<DiagramSummary[]>([]);
  const [curId, setCurId] = useState<number | null>(null);
  const [diag, setDiag] = useState<DiagramFull | null>(null);
  const [detail, setDetail] = useState<PartDetail | null>(null);
  const [zoom, setZoom] = useState(900);
  const [q, setQ] = useState("");
  const [edit, setEdit] = useState(false);
  const [adding, setAdding] = useState(false);
  const [selHot, setSelHot] = useState<number | null>(null);
  const [assignQ, setAssignQ] = useState("");
  const [assignHits, setAssignHits] = useState<Hit[]>([]);
  const [dragId, setDragId] = useState<number | null>(null);
  const [natDims, setNatDims] = useState<{ w: number; h: number } | null>(null);
  const [, setTick] = useState(0);
  const dragPos = useRef<{ x: number; y: number } | null>(null);
  const moved = useRef(false);
  const imgRef = useRef<HTMLImageElement>(null);
  const upRef = useRef<HTMLInputElement>(null);

  const loadList = useCallback(() => {
    api.listDiagrams<DiagramSummary[]>().then(setList).catch(console.error);
  }, []);
  useEffect(() => { loadList(); }, [loadList]);
  useEffect(() => {
    if (list.length && curId == null) {
      const first = list.find((x) => x.hotspot_count > 0) ?? list[0];
      if (first) setCurId(first.id);
    }
  }, [list, curId]);

  const reload = useCallback(() => {
    if (curId == null) return;
    api.getDiagram<DiagramFull>(curId).then(setDiag).catch(console.error);
  }, [curId]);
  useEffect(() => { reload(); setSelHot(null); setNatDims(null); }, [curId, reload]);

  const openPart = useCallback(async (partId: number | null) => {
    if (partId == null) return;
    try { setDetail(await api.partDetail<PartDetail>(partId)); } catch (e) { console.error(e); }
  }, []);

  const effW = () => (diag?.img_w || natDims?.w || 0);
  const effH = () => (diag?.img_h || natDims?.h || 0);
  const imgCoords = (e: { clientX: number; clientY: number }) => {
    const img = imgRef.current; const w = effW(), h = effH();
    if (!img || !w || !h) return null;
    const r = img.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * w, y: ((e.clientY - r.top) / r.height) * h };
  };
  const hot = (id: number | null) => diag?.hotspots.find((h) => h.id === id) ?? null;

  // drag a marker to reposition it (commit on release)
  const startDrag = (h: Hotspot, e: { stopPropagation: () => void }) => {
    if (!edit) return;
    e.stopPropagation();
    setSelHot(h.id); moved.current = false; dragPos.current = { x: h.x, y: h.y }; setDragId(h.id);
  };
  useEffect(() => {
    if (dragId == null) return;
    const move = (e: PointerEvent) => { const c = imgCoords(e); if (!c) return; dragPos.current = c; moved.current = true; setTick((t) => t + 1); };
    const up = async () => {
      window.removeEventListener("pointermove", move);
      const id = dragId, pos = dragPos.current; setDragId(null);
      if (moved.current && pos) {
        const h = hot(id);
        try { await api.updateHotspot(id, pos.x, pos.y, h?.part_id ?? null, h?.item_no ?? null); reload(); }
        catch (e) { console.error(e); }
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
  }, [dragId]); // eslint-disable-line react-hooks/exhaustive-deps

  const onCanvasClick = async (e: { clientX: number; clientY: number }) => {
    if (!edit || curId == null || !adding) return;
    const c = imgCoords(e); if (!c) return;
    try {
      const id = await api.addHotspot(curId, c.x, c.y, null, null);
      reload(); setSelHot(id); setAdding(false);
    } catch (err) { console.error(err); }
  };
  const assignPart = async (h: Hotspot, partId: number) => {
    try { await api.updateHotspot(h.id, h.x, h.y, partId, h.item_no); reload(); setAssignQ(""); setAssignHits([]); } catch (e) { console.error(e); }
  };
  const setItem = async (h: Hotspot, val: string) => {
    try { await api.updateHotspot(h.id, h.x, h.y, h.part_id, val || null); reload(); } catch (e) { console.error(e); }
  };
  const delHot = async (id: number) => {
    try { await api.deleteHotspot(id); setSelHot(null); reload(); loadList(); } catch (e) { console.error(e); }
  };
  useEffect(() => {
    const t = assignQ.trim();
    if (t.length < 2) { setAssignHits([]); return; }
    let cx = false;
    api.searchParts<Hit[]>(t).then((r) => { if (!cx) setAssignHits(r); }).catch(console.error);
    return () => { cx = true; };
  }, [assignQ]);

  const uploadDiagram = async (file: File) => {
    const url = URL.createObjectURL(file);
    const im = new Image();
    try { await new Promise((res, rej) => { im.onload = () => res(null); im.onerror = rej; im.src = url; }); }
    catch { URL.revokeObjectURL(url); return; }
    const w = im.naturalWidth, h = im.naturalHeight; URL.revokeObjectURL(url);
    const buf = new Uint8Array(await file.arrayBuffer());
    try {
      const newId = await api.saveDiagram(file.name, Array.from(buf), file.name.replace(/\.[^.]+$/, ""), w, h);
      loadList(); setCurId(newId); setEdit(true);
    } catch (e) { console.error(e); }
  };

  const deleteDiagram = async () => {
    if (curId == null) return;
    if (!confirm("Delete this diagram and its hotspots? (Parts are not affected.)")) return;
    try { await api.deleteDiagram(curId); setCurId(null); setDiag(null); setSelHot(null); loadList(); }
    catch (e) { console.error(e); }
  };

  const shown = list.filter((d) =>
    !q.trim() || d.title.toLowerCase().includes(q.toLowerCase()) || d.drawing_key.toLowerCase().includes(q.toLowerCase()));
  const sel = hot(selHot);
  const markPos = (h: Hotspot) => (dragId === h.id && dragPos.current ? dragPos.current : { x: h.x, y: h.y });

  return (
    <div className="dgwrap2">
      <div className="dgside">
        <input className="dgsearch" placeholder="Filter diagrams…" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="mini upbtn" onClick={() => upRef.current?.click()}>⬆ Upload diagram</button>
        <input ref={upRef} type="file" accept="image/*" style={{ display: "none" }}
          onChange={(e) => { const fl = e.target.files?.[0]; if (fl) uploadDiagram(fl); e.currentTarget.value = ""; }} />
        {shown.map((d) => (
          <div key={d.id} className={"dgitem" + (d.id === curId ? " on" : "")} onClick={() => setCurId(d.id)}>
            <span className="dgkey">{d.drawing_key}</span>
            <span className="dgtitle">{d.title}</span>
            <span className={"dgcount" + (d.hotspot_count ? "" : " zero")}>{d.hotspot_count}</span>
          </div>
        ))}
      </div>

      <div className="dgmain">
        {diag && (
          <div className="dghead">
            <b>{diag.drawing_key}</b> <span className="dghname">{diag.title}</span>
            <span className="spacer" />
            {edit ? (
              <>
                <button className={"mini" + (adding ? " act" : "")} onClick={() => setAdding((v) => !v)}>＋ hotspot</button>
                <span className="dghint">{adding ? "click the drawing to drop a marker" : "drag a marker to move · click to edit"}</span>
              </>
            ) : (
              <span className="dghint">{diag.hotspots.length} hotspot{diag.hotspots.length !== 1 ? "s" : ""} · click a number</span>
            )}
            {edit && <button className="zbtn del" title="Delete this diagram" onClick={deleteDiagram}>🗑</button>}
            <button className={"zbtn edit" + (edit ? " on" : "")} title="Edit hotspots" onClick={() => { setEdit((v) => !v); setAdding(false); setSelHot(null); }}>✎</button>
            <button className="zbtn" onClick={() => setZoom((z) => Math.max(400, z - 250))}>−</button>
            <button className="zbtn" onClick={() => setZoom((z) => Math.min(4000, z + 250))}>+</button>
          </div>
        )}

        {edit && sel && (
          <div className="hotedit">
            <span className="hetag">Hotspot #{sel.item_no ?? "—"}</span>
            <input className="heitem" placeholder="item #" defaultValue={sel.item_no ?? ""} onBlur={(e) => setItem(sel, e.target.value)} />
            {sel.part_id ? <span className="helink">→ {sel.sku} · {sel.name}</span> : <span className="helink unl">no part linked</span>}
            <input className="hesearch" placeholder="assign part: SKU / PN / name…" value={assignQ} onChange={(e) => setAssignQ(e.target.value)} />
            <button className="mini del" onClick={() => delHot(sel.id)}>delete</button>
            {assignHits.length > 0 && (
              <div className="heresults">
                {assignHits.slice(0, 6).map((h) => (
                  <div key={h.id} className="herow" onClick={() => assignPart(sel, h.id)}>
                    <span className="sku">{h.sku}</span> <span className="nm">{h.name}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="dgstage">
          {diag?.image_path ? (
            <div className={"dgcanvas" + (edit && adding ? " placing" : "")} style={{ width: zoom }}>
              <img ref={imgRef} className="dgimg" src={asset(diag.image_path)} alt={diag.title} draggable={false}
                onClick={onCanvasClick}
                onLoad={(e) => { if (!diag.img_w || !diag.img_h) setNatDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight }); }} />
              {(diag.img_w || natDims) && diag.hotspots.map((h) => {
                const p = markPos(h);
                return (
                  <button key={h.id}
                    className={"dgmk" + (h.part_id ? "" : " unl") + (edit && h.id === selHot ? " sel" : "") + (edit ? " drag" : "")}
                    style={{ left: (p.x / effW()) * 100 + "%", top: (p.y / effH()) * 100 + "%" }}
                    title={h.name ? `${h.item_no ? "#" + h.item_no + " · " : ""}${h.name}` : "unlinked"}
                    onPointerDown={(e) => startDrag(h, e)}
                    onClick={(e) => { e.stopPropagation(); if (moved.current) { moved.current = false; return; } if (edit) setSelHot(h.id); else openPart(h.part_id); }}>
                    {h.item_no ?? "•"}
                  </button>
                );
              })}
            </div>
          ) : <div className="dgempty">select or upload a diagram</div>}
        </div>
      </div>

      {detail && <DetailPanel detail={detail} onClose={() => setDetail(null)} onPosted={() => openPart(detail.id)} />}
    </div>
  );
}
