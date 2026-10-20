// CTP Core — the diagram viewer: a drawing and its parts list, side by side.
//
// DIAGRAM_SPEC.md §3–4, reimplemented from the observed behaviour. The drawing
// is DiagramCanvas (one SVG, markers inside the transform); the list is one
// row per PART on the drawing, joined to stock and price at render time —
// never stored in the hotspot. The two sides select the same thing:
//   marker tap → the row scrolls into view and lights up, the marker pulses
//   row tap    → the drawing's attention moves to the part, the marker pulses
// Every part of a row that a finger lands on — the number badge, the thumbnail,
// the name — does the same thing: it points at the callout on the drawing. Only
// the explicit "Open" button leaves the drawing, for the part's detail sheet.
// (Ian, 2026-09-25. The name used to be a link to the part sheet, so looking
// for a callout by name took you off the drawing instead of to it.)
// A part with several callouts (16 appears twice on SEC101; L/H and R/H pairs
// elsewhere) zooms to the rectangle enclosing all of them.
//
// Layout: ≥1024px a split pane with a draggable divider (ratio remembered on
// the device); on release the drawing re-fits. Below that, stacked: drawing
// above, list below — the phone experience as it was.
//
// Deep link: #dg=<drawing_key>&part=<part_id> opens straight onto the part.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as api from "../data/api";
import type { DiagramPart, WebHotspot } from "../data/api";
import { assetUrl } from "../assets";
import { DiagramCanvas, Marker, loadMarkerScale, markerRadius, calloutRect, FOCUS_SCALE, type CanvasApi, type Frame, type Rect } from "./DiagramCanvas";
import { markerState, markerTitle } from "./hotspotState";

export type Drawing = { path: string; label: string; key?: string };

const SPLIT_KEY = "ctp.diagram_split";
const loadSplit = () => { try { const v = Number(localStorage.getItem(SPLIT_KEY)); return v >= 0.35 && v <= 0.75 ? v : 0.57; } catch { return 0.57; } };
const fmtR = (c: number) => "R " + (c / 100).toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** One list row: a part and every marker that points at it. Unlinked or
 *  faulty markers get a row of their own so nothing on the drawing is
 *  invisible in the list. */
type Row = {
  key: string; partId: number | null; hots: WebHotspot[];
  sku: string | null; name: string; badges: string[]; link: WebHotspot["link"];
};

export function DiagramView({ drawings, start, onClose, canEdit, onOpenPart, onEditMarkers, onAddToRequest, inRequest, deepPart }: {
  drawings: Drawing[]; start: number;
  onClose: () => void;
  canEdit?: boolean;
  onOpenPart?: (partId: number) => void;
  onEditMarkers?: (path: string, label: string) => void;
  /** Customers: add to the request list (the confirm step is the qty box + button). */
  onAddToRequest?: (part: DiagramPart, qty: number) => void;
  inRequest?: (partId: number) => number;
  /** Part to land on (deep link). */
  deepPart?: number | null;
}) {
  const [idx, setIdx] = useState(Math.min(Math.max(start, 0), drawings.length - 1));
  const d = drawings[idx];
  const [frame, setFrame] = useState<Frame | null>(null);
  const [hots, setHots] = useState<WebHotspot[]>([]);
  const [key, setKey] = useState<string | null>(null);
  const [parts, setParts] = useState<Record<number, DiagramPart>>({});
  const [sel, setSel] = useState<string | null>(null);           // Row.key
  const [qty, setQty] = useState<Record<number, number>>({});
  const [split, setSplit] = useState(loadSplit);
  const [wide, setWide] = useState(() => window.innerWidth >= 1024);
  const [zoomed, setZoomed] = useState(false);
  const canvas = useRef<CanvasApi | null>(null);
  const bind = useCallback((a: CanvasApi) => { canvas.current = a; }, []);
  const listRef = useRef<HTMLDivElement>(null);
  const pendingDeep = useRef<number | null>(deepPart ?? null);
  const markerScale = loadMarkerScale();

  useEffect(() => {
    const on = () => setWide(window.innerWidth >= 1024);
    window.addEventListener("resize", on); return () => window.removeEventListener("resize", on);
  }, []);

  // ── load the drawing's markers, then the parts they point at ────────────
  useEffect(() => {
    setHots([]); setParts({}); setFrame(null); setKey(null); setSel(null); setZoomed(false);
    let live = true;
    api.listHotspots(d.path).then(async (r) => {
      if (!live) return;
      if (r.img_w && r.img_h) setFrame({ w: r.img_w, h: r.img_h });
      setKey(r.drawing_key ?? null);
      setHots(r.hotspots);
      const ids = [...new Set(r.hotspots.filter((h) => h.link === "ok" && h.part_id != null).map((h) => h.part_id!))];
      const ps = ids.length ? await api.diagramParts(ids) : [];
      if (!live) return;
      setParts(Object.fromEntries(ps.map((p) => [p.id, p])));
    }).catch((e) => console.error("diagram:", e));
    return () => { live = false; };
  }, [d.path]);

  // ── rows: one per part, callouts sorted; faulty/unlinked markers on their own ─
  const rows = useMemo<Row[]>(() => {
    const byPart = new Map<number, WebHotspot[]>();
    const singles: Row[] = [];
    for (const h of hots) {
      if (h.link === "ok" && h.part_id != null) { byPart.set(h.part_id, [...(byPart.get(h.part_id) ?? []), h]); }
      else singles.push({ key: "h" + h.id, partId: null, hots: [h], sku: null, badges: [h.item_no ?? "·"], link: h.link,
        name: h.link === "none" ? "no part linked yet" : h.link === "retired" ? `retired part${h.was_sku ? ` · was ${h.was_sku}` : ""}` : "part no longer exists" });
    }
    const num = (s: string | null) => parseInt(s ?? "", 10) || 999;
    const out: Row[] = [...byPart.entries()].map(([pid, hs]) => {
      const sorted = [...hs].sort((a, b) => num(a.item_no) - num(b.item_no));
      return { key: "p" + pid, partId: pid, hots: sorted, sku: sorted[0].sku, name: sorted[0].name ?? "", link: "ok",
        badges: [...new Set(sorted.map((h) => h.item_no ?? "·"))] };
    });
    out.sort((a, b) => num(a.badges[0]) - num(b.badges[0]) || (a.sku ?? "").localeCompare(b.sku ?? ""));
    return [...out, ...singles];
  }, [hots]);
  const selRow = rows.find((r) => r.key === sel) ?? null;

  // ── the enclosing rectangle of a row's markers, in drawing units ─────────
  const rectOf = useCallback((r: Row): Rect =>
    calloutRect(r.hots, markerRadius(frame?.w ?? 0, markerScale)),
  [frame, markerScale]);

  /** Select from the LIST: mark the row and move the drawing's attention to it.
   *
   *  Ian, 2026-09-25: the number, the name and the thumbnail all do THIS. Only
   *  "Open" leaves the drawing. Before, the name was a link to the part sheet,
   *  so two of the three things a finger lands on went somewhere else.
   *
   *  focus(), not zoomTo(): zoomTo fills the view with the callout, which for a
   *  single marker clamped to MAX_S (8×) and threw the truck away. A part with
   *  several callouts is centred on the rectangle enclosing all of them — at
   *  the same gentle scale, so both are visible rather than framed. */
  const goTo = useCallback((r: Row, instant = false) => {
    setSel(r.key);
    canvas.current?.focus(rectOf(r), FOCUS_SCALE, instant);
    writeHash(key, r.partId);
  }, [rectOf, key]);
  /** Select from the DRAWING: mark the marker and bring the row into view. */
  const pick = useCallback((h: WebHotspot) => {
    const r = rows.find((x) => x.hots.some((y) => y.id === h.id));
    if (!r) return;
    setSel(r.key);
    writeHash(key, r.partId);
    setTimeout(() => {
      listRef.current?.querySelector<HTMLElement>(`[data-row="${CSS.escape(r.key)}"]`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 0);
  }, [rows, key]);

  // deep link: once the rows and the frame exist, land on the part
  useEffect(() => {
    const pid = pendingDeep.current;
    if (pid == null || !frame || rows.length === 0) return;
    const r = rows.find((x) => x.partId === pid);
    pendingDeep.current = null;
    if (r) { goTo(r, true); setTimeout(() => listRef.current?.querySelector<HTMLElement>(`[data-row="${CSS.escape(r.key)}"]`)?.scrollIntoView({ block: "center" }), 0); }
  }, [rows, frame, goTo]);

  // ── the divider ──────────────────────────────────────────────────────────
  const paneRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const onDivDown = (e: React.PointerEvent<HTMLDivElement>) => { dragging.current = true; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); };
  const onDivMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current || !paneRef.current) return;
    const b = paneRef.current.getBoundingClientRect();
    setSplit(Math.min(0.75, Math.max(0.35, (e.clientX - b.left) / b.width)));
  };
  const onDivUp = () => {
    if (!dragging.current) return;
    dragging.current = false;
    try { localStorage.setItem(SPLIT_KEY, String(split)); } catch { /* private mode */ }
    // the pane changed shape under the drawing: re-fit, as the reference does
    canvas.current?.fit();
  };

  const step = (n: number) => { if (n >= 0 && n < drawings.length) { setIdx(n); writeHash(drawings[n].key ?? null, null); } };
  // keyboard: Escape closes, ← → walk the drawings (not while typing a qty)
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") step(idx + 1);
      else if (e.key === "ArrowLeft") step(idx - 1);
    };
    window.addEventListener("keydown", on); return () => window.removeEventListener("keydown", on);
  });
  const r = markerRadius(frame?.w ?? 0, markerScale);

  const list = (
    <div className="dv-list" ref={listRef}>
      {/* The edit entry point lives here as well as in the header: Ian went
          looking for it in the list and did not find it (20 Sep). Staff only;
          a customer login sees neither, by design. */}
      <div className="dv-list-head">
        <span>{rows.length} part{rows.length === 1 ? "" : "s"} on this drawing{rows.length === 0 ? " — none marked up yet" : ""}</span>
        {canEdit && onEditMarkers && (
          <button className="dv-edit" onClick={() => onEditMarkers(d.path, d.label)}>{rows.length ? "✎ Edit markers" : "✎ Add markers"}</button>
        )}
      </div>
      {rows.length === 0 && canEdit && onEditMarkers && (
        <div className="dv-empty">
          <p>No callouts on this drawing yet. Place a ring on each printed callout and link it to its part — the list fills in as you go.</p>
          <button className="mb-chip on" onClick={() => onEditMarkers(d.path, d.label)}>Start marking up</button>
        </div>
      )}
      {rows.map((row) => {
        const p = row.partId != null ? parts[row.partId] : undefined;
        const on = row.key === sel;
        const q = row.partId != null ? (qty[row.partId] ?? 1) : 1;
        const already = row.partId != null && inRequest ? inRequest(row.partId) : 0;
        return (
          <div key={row.key} data-row={row.key} className={"dv-row" + (on ? " on" : "") + (row.link !== "ok" ? " " + (row.link === "none" ? "unl" : "bad") : "")}
            onClick={() => goTo(row)} role="button" tabIndex={0}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); goTo(row); } }}>
            <div className="dv-badges">{row.badges.map((b) => <span key={b} className="dv-badge">{b}</span>)}</div>
            {p?.image ? <img className="dv-thumb" src={assetUrl(p.image)} alt="" loading="lazy" /> : <span className="dv-thumb ph" />}
            <div className="dv-main">
              {/* Plain text, not a link: the name points at the callout with the
                  rest of the row. "Open" in dv-side is the way to the sheet. */}
              <span className={"dv-name" + (row.link !== "ok" ? " dim" : "")}>{row.name}</span>
              <div className="dv-meta">
                {row.sku && <span>Part no. <b className="mono">{row.sku}</b></span>}
                {p && p.on_hand != null && (
                  <span className={"dv-stock" + (p.on_hand > 0 ? " in" : " out")}>{p.on_hand > 0 ? `${p.on_hand} in stock` : "out of stock"}</span>
                )}
                {/* 0050: a customer device has no ledger (on_hand null) but does get the boolean. */}
                {p && p.on_hand == null && p.in_stock != null && (
                  <span className={"dv-stock" + (p.in_stock ? " in" : " out")}>{p.in_stock ? "in stock" : "out of stock"}</span>
                )}
              </div>
            </div>
            <div className="dv-side" onClick={(e) => e.stopPropagation()}>
              {p && p.list_minor != null && <div className="dv-price">{fmtR(p.list_minor)}</div>}
              {/* Open is offered to EVERYONE now, customers included — it is the
                  only way to the part's details, and the detail sheet is where
                  the photo carousel lives. It used to appear for staff only. */}
              {p && onOpenPart && <button className="mb-chip" onClick={() => onOpenPart(p.id)}>Open</button>}
              {p && onAddToRequest && (
                <div className="dv-add">
                  <input className="dv-qty" inputMode="numeric" value={q}
                    onChange={(e) => setQty((s) => ({ ...s, [p.id]: Math.max(1, Math.min(999, parseInt(e.target.value, 10) || 1)) }))} />
                  <button className="mb-chip on" onClick={() => onAddToRequest(p, q)}>{already ? `+ (${already} in list)` : "Add to request"}</button>
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );

  const stage = (
    <div className="dv-stage">
      <DiagramCanvas key={d.path} href={assetUrl(d.path)} frame={frame} onFrame={setFrame} onZoomed={setZoomed} bind={bind}
        onSwipe={!wide && drawings.length > 1 ? (dir) => step(idx + dir) : undefined}>
        {frame && hots.map((h) => (
          <Marker key={h.id} x={h.x} y={h.y} r={r} state={markerState(h)} title={markerTitle(h)}
            pulse={!!selRow && selRow.hots.some((x) => x.id === h.id)}
            onClick={(e) => { e.stopPropagation(); pick(h); }} />
        ))}
      </DiagramCanvas>
      {drawings.length > 1 && (
        <div className="dv-nav">
          <button type="button" aria-label="Previous drawing" disabled={idx === 0} onClick={() => step(idx - 1)}>‹</button>
          <span>{idx + 1} / {drawings.length}</span>
          <button type="button" aria-label="Next drawing" disabled={idx === drawings.length - 1} onClick={() => step(idx + 1)}>›</button>
        </div>
      )}
      {!zoomed && !wide && <div className="mb-lb-hint">pinch, wheel or double-tap to zoom · tap a ring to find it in the list</div>}
    </div>
  );

  return (
    <div className="mb-lb dv">
      <div className="mb-lb-head dv-head">
        <button className="mb-back" onClick={onClose} aria-label="Close">✕</button>
        <nav className="dv-crumb" aria-label="Breadcrumb">
          <span>Diagrams</span><span className="dv-sep">›</span>
          <b>{d.label}</b>
          {key && <><span className="dv-sep">›</span><span className="mono">{key}</span></>}
          {selRow?.sku && <><span className="dv-sep">›</span><span className="mono">{selRow.sku}</span></>}
        </nav>
        <span style={{ flex: 1 }} />
        {selRow?.partId != null && key && (
          <button className="mb-chip" title="Copy a link straight to this part on this drawing"
            onClick={() => { const u = new URL(location.href); u.hash = `dg=${key}&part=${selRow.partId}`; void navigator.clipboard?.writeText(u.toString()); }}>
            Copy link
          </button>
        )}
        {canEdit && onEditMarkers && (
          <button className="mb-chip on" onClick={() => onEditMarkers(d.path, d.label)}>{hots.length ? "Edit markers" : "Add markers"}</button>
        )}
      </div>
      {wide ? (
        <div className="dv-pane" ref={paneRef} style={{ gridTemplateColumns: `${split * 100}% 8px 1fr` }}>
          {stage}
          <div className="dv-divider" role="separator" aria-orientation="vertical" aria-valuenow={Math.round(split * 100)}
            onPointerDown={onDivDown} onPointerMove={onDivMove} onPointerUp={onDivUp} onPointerCancel={onDivUp} />
          {list}
        </div>
      ) : (
        <div className="dv-stack">{stage}{list}</div>
      )}
    </div>
  );
}

/** The address bar follows the selection, so any moment is shareable. */
function writeHash(key: string | null, partId: number | null) {
  if (!key) return;
  const h = `#dg=${key}${partId != null ? `&part=${partId}` : ""}`;
  if (location.hash !== h) history.replaceState(null, "", h);
}
/** Read a deep link. Returns null when the hash is not ours. */
export function readDiagramHash(): { key: string; part: number | null } | null {
  const m = /^#dg=([A-Za-z0-9_-]+)(?:&part=(\d+))?/.exec(location.hash);
  return m ? { key: m[1], part: m[2] ? Number(m[2]) : null } : null;
}
