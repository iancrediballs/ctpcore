// CTP Core — the drawing and its markers as ONE object.
//
// This is the structural fix for the marker-drift bug (14 Sep, twice). The
// old viewer positioned markers in a sibling layer and tried to keep that
// layer in step with a transformed <img>; the old editor positioned them as
// percentages of whatever box happened to contain them. Both asked two
// coordinate systems to agree, and both drifted.
//
// Here there is one coordinate system: the drawing's own. The <svg> has a
// viewBox of `0 0 frame.w frame.h` — the drawing's natural units, the same
// units hotspot.x / hotspot.y are stored in (diagram.img_w × img_h). The
// image is painted to fill that box, every marker is a child of the same <g>
// as the image, and pan/zoom is a single transform on that <g>. A marker at
// (x, y) stays at (x, y) at every zoom level because nothing ever repositions
// it — the browser moves the group, and the marker is in the group.
//
// Screen → drawing goes through the SVG's own matrix (getScreenCTM), then the
// inverse of our pan/zoom. No rendered widths, no offset*, no percentages.
// If any code in this file reads a rendered pixel size to place a marker, the
// design has been broken.
//
// Markers scale with the drawing (spec §2). A counter-scale would reintroduce
// per-marker maths; accepted as-is.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

export type Frame = { w: number; h: number };
export type Pt = { x: number; y: number };

const MIN_S = 1;
const MAX_S = 8;

export type DiagramCanvasProps = {
  href: string;
  /** The drawing's natural units. If null the canvas measures the image once
   *  it loads and reports it through onFrame (photos; diagrams with no
   *  recorded img_w/h). */
  frame: Frame | null;
  onFrame?: (f: Frame) => void;
  /** Rendered INSIDE the transformed group, in drawing units. */
  children?: ReactNode;
  /** A tap on the drawing (not on a marker) — drawing units. */
  onTap?: (p: Pt) => void;
  /** Swipe at fit scale, for photo galleries. Diagrams ignore it. */
  onSwipe?: (dir: -1 | 1) => void;
  /** Report zoomed state (for "Fit" chips etc). */
  onZoomed?: (zoomed: boolean) => void;
  className?: string;
  /** Show the + − ⟲ buttons. */
  controls?: boolean;
  /** Called with a converter so a parent can run its own drags in drawing
   *  units (the editor moves markers with it). */
  bind?: (api: CanvasApi) => void;
};

export type CanvasApi = {
  /** Screen point → drawing units, or null before the frame is known. */
  toDrawing: (clientX: number, clientY: number) => Pt | null;
  /** The SVG element. */
  svg: () => SVGSVGElement | null;
  /** Capture a pointer on the SVG so a marker drag keeps receiving moves
   *  wherever the pointer wanders. Never throws. */
  capture: (pointerId: number) => void;
  reset: () => void;
};

/** setPointerCapture throws NotFoundError if the pointer has already gone
 *  (released between the event and the call) — nothing to do in that case. */
function capturePointer(el: Element | null, pointerId: number) {
  try { el?.setPointerCapture(pointerId); } catch { /* pointer gone */ }
}

export function DiagramCanvas({ href, frame, onFrame, children, onTap, onSwipe, onZoomed, className, controls = true, bind }: DiagramCanvasProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const gRef = useRef<SVGGElement>(null);
  // Pan/zoom, in drawing units. s is uniform; (tx, ty) is where the drawing's
  // origin sits inside the viewBox.
  const t = useRef({ s: 1, tx: 0, ty: 0 });
  const [zoomed, setZoomedState] = useState(false);
  const zoomedRef = useRef(false);
  const ptrs = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ d0: number; s0: number; c: Pt } | null>(null);
  const drag = useRef<{ sx: number; sy: number; tx0: number; ty0: number; moved: boolean; onMarker: boolean } | null>(null);
  const lastTap = useRef(0);
  const [measured, setMeasured] = useState<Frame | null>(null);
  const fr = frame ?? measured;

  // ── paint: one attribute write, nothing read ──────────────────────────────
  // Written synchronously. There is no layout read anywhere in this file, so
  // there is nothing to thrash; a transform attribute on a <g> is the cheapest
  // thing the browser can be asked to change, and the compositor coalesces.
  const apply = useCallback(() => {
    const g = gRef.current;
    if (g) {
      const { s, tx, ty } = t.current;
      g.setAttribute("transform", `translate(${tx} ${ty}) scale(${s})`);
    }
    const z = t.current.s > 1.01;
    if (z !== zoomedRef.current) { zoomedRef.current = z; setZoomedState(z); onZoomed?.(z); }
  }, [onZoomed]);

  /** Keep the drawing inside the viewBox: at scale s it spans w·s, and the
   *  visible box is w, so its origin may sit anywhere in [w − w·s, 0]. */
  const clamp = useCallback(() => {
    if (!fr) return;
    const { s } = t.current;
    const mx = fr.w * (1 - s), my = fr.h * (1 - s);           // ≤ 0 when s ≥ 1
    t.current.tx = Math.min(0, Math.max(mx, t.current.tx));
    t.current.ty = Math.min(0, Math.max(my, t.current.ty));
    apply();
  }, [fr, apply]);

  const reset = useCallback(() => { t.current = { s: 1, tx: 0, ty: 0 }; apply(); }, [apply]);

  // ── screen → viewBox → drawing ───────────────────────────────────────────
  /** Screen point in viewBox units (the browser's own matrix, so letterboxing
   *  from preserveAspectRatio is accounted for without us measuring anything). */
  const toView = useCallback((clientX: number, clientY: number): Pt | null => {
    const svg = svgRef.current;
    if (!svg) return null;
    const m = svg.getScreenCTM();
    if (!m) return null;
    const p = new DOMPoint(clientX, clientY).matrixTransform(m.inverse());
    return { x: p.x, y: p.y };
  }, []);
  const toDrawing = useCallback((clientX: number, clientY: number): Pt | null => {
    const v = toView(clientX, clientY);
    if (!v || !fr) return null;
    const { s, tx, ty } = t.current;
    const cl = (val: number, max: number) => Math.min(max, Math.max(0, val));
    return { x: cl((v.x - tx) / s, fr.w), y: cl((v.y - ty) / s, fr.h) };
  }, [toView, fr]);

  useEffect(() => { bind?.({ toDrawing, svg: () => svgRef.current, capture: (id) => capturePointer(svgRef.current, id), reset }); }, [bind, toDrawing, reset]);

  /** Zoom so the viewBox point `v` stays under the pointer. */
  const zoomAt = useCallback((v: Pt, sNew: number) => {
    const s1 = Math.min(MAX_S, Math.max(MIN_S, sNew));
    const { s, tx, ty } = t.current;
    // drawing point under the pointer: d = (v − t)/s ; keep it: t' = v − d·s'
    const dx = (v.x - tx) / s, dy = (v.y - ty) / s;
    t.current = { s: s1, tx: v.x - dx * s1, ty: v.y - dy * s1 };
    if (s1 <= 1.001) t.current = { s: 1, tx: 0, ty: 0 };
    clamp();
  }, [clamp]);

  const zoomCentre = (factor: number) => {
    if (!fr) return;
    zoomAt({ x: fr.w / 2, y: fr.h / 2 }, t.current.s * factor);
  };

  // ── wheel: zoom the drawing, never scroll the page ──────────────────────
  // React's onWheel is passive; preventDefault there is ignored. Attach a real
  // non-passive listener so the page under the viewer does not jump (spec §4).
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const v = toView(e.clientX, e.clientY);
      if (!v) return;
      zoomAt(v, t.current.s * (e.deltaY < 0 ? 1.18 : 1 / 1.18));
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [toView, zoomAt]);

  // ── pointers: pan, pinch, double-tap, swipe ─────────────────────────────
  const onDown = (e: React.PointerEvent) => {
    const onMarker = !!(e.target as Element).closest("[data-marker]");
    capturePointer(svgRef.current, e.pointerId);
    ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.current.size === 2) {
      const [a, b] = [...ptrs.current.values()];
      const mid = toView((a.x + b.x) / 2, (a.y + b.y) / 2);
      if (!mid) return;
      const { s, tx, ty } = t.current;
      pinch.current = { d0: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), s0: s, c: { x: (mid.x - tx) / s, y: (mid.y - ty) / s } };
      drag.current = null;
    } else if (ptrs.current.size === 1) {
      const now = Date.now();
      if (!onMarker && now - lastTap.current < 300) {
        const v = toView(e.clientX, e.clientY);
        if (v) zoomAt(v, t.current.s > 1.01 ? 1 : 2.6);
        lastTap.current = 0;
        return;
      }
      lastTap.current = now;
      drag.current = { sx: e.clientX, sy: e.clientY, tx0: t.current.tx, ty0: t.current.ty, moved: false, onMarker };
    }
  };
  const onMove = (e: React.PointerEvent) => {
    if (!ptrs.current.has(e.pointerId)) return;
    ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch.current && ptrs.current.size >= 2) {
      const [a, b] = [...ptrs.current.values()];
      const mid = toView((a.x + b.x) / 2, (a.y + b.y) / 2);
      if (!mid) return;
      const s = Math.min(MAX_S, Math.max(MIN_S, pinch.current.s0 * (Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)) / pinch.current.d0)));
      t.current = { s, tx: mid.x - pinch.current.c.x * s, ty: mid.y - pinch.current.c.y * s };
      apply();
    } else if (drag.current && !drag.current.onMarker) {
      const dxs = e.clientX - drag.current.sx, dys = e.clientY - drag.current.sy;
      if (Math.abs(dxs) + Math.abs(dys) > 6) drag.current.moved = true;
      if (t.current.s > 1.01) {
        // screen delta → viewBox delta through the CTM scale (uniform, so one axis suffices)
        const m = svgRef.current?.getScreenCTM();
        const k = m ? 1 / m.a : 1;
        t.current.tx = drag.current.tx0 + dxs * k;
        t.current.ty = drag.current.ty0 + dys * k;
        apply();
      }
    }
  };
  const onUp = (e: React.PointerEvent) => {
    const d = drag.current;
    ptrs.current.delete(e.pointerId);
    if (ptrs.current.size < 2) pinch.current = null;
    if (ptrs.current.size === 0) {
      if (t.current.s > 1.01) clamp();
      else if (d && d.moved && !d.onMarker && onSwipe) {
        const dx = e.clientX - d.sx;
        if (dx < -60) onSwipe(1); else if (dx > 60) onSwipe(-1);
      }
      if (d && !d.moved && !d.onMarker && onTap) {
        const p = toDrawing(e.clientX, e.clientY);
        if (p) onTap(p);
      }
      drag.current = null;
    }
  };

  const onImgLoad = (e: React.SyntheticEvent<SVGImageElement>) => {
    if (frame) return;
    // Only when nothing is recorded: measure the file once and tell the parent.
    const img = new Image();
    img.onload = () => { const f = { w: img.naturalWidth, h: img.naturalHeight }; setMeasured(f); onFrame?.(f); };
    img.src = (e.currentTarget as SVGImageElement).href.baseVal;
  };

  return (
    <div className={"dg-wrap" + (className ? " " + className : "")}>
      <svg ref={svgRef} className="dg-svg"
        viewBox={fr ? `0 0 ${fr.w} ${fr.h}` : "0 0 1 1"}
        preserveAspectRatio="xMidYMid meet"
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
        <g ref={gRef}>
          {fr && (
            <image href={href} x={0} y={0} width={fr.w} height={fr.h}
              preserveAspectRatio="none" onLoad={onImgLoad} />
          )}
          {!fr && <image href={href} x={0} y={0} width={1} height={1} opacity={0} onLoad={onImgLoad} />}
          {fr && children}
        </g>
      </svg>
      {controls && fr && (
        <div className="dg-ctl" onPointerDown={(e) => e.stopPropagation()}>
          <button type="button" aria-label="Zoom in" onClick={() => zoomCentre(1.4)}>+</button>
          <button type="button" aria-label="Zoom out" onClick={() => zoomCentre(1 / 1.4)}>−</button>
          <button type="button" aria-label="Fit" onClick={reset} disabled={!zoomed}>⟲</button>
        </div>
      )}
    </div>
  );
}

/** A callout marker in drawing units. Radius is the hotspot's own (58 by
 *  default), so it scales with the drawing like everything else. */
export function Marker({ x, y, r, label, state, title, onPointerDown, onClick }: {
  x: number; y: number; r: number; label: string;
  /** unl = placed, no part yet. bad = points at a retired or missing part:
   *  drawn loud (red, dashed) so it gets fixed, never hidden. */
  state?: "" | "unl" | "bad" | "sel" | "dirty" | "new";
  title?: string;
  onPointerDown?: (e: React.PointerEvent<SVGGElement>) => void;
  onClick?: (e: React.MouseEvent<SVGGElement>) => void;
}) {
  return (
    <g className={"dg-mk" + (state ? " " + state : "")} transform={`translate(${x} ${y})`}
      data-marker="1" onPointerDown={onPointerDown} onClick={onClick}>
      {title && <title>{title}</title>}
      <circle r={r} />
      <text textAnchor="middle" dominantBaseline="central" fontSize={r * 1.1}>{label}</text>
    </g>
  );
}
