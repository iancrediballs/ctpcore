// Verification harness for focus() — the 15% zoom-to-hotspot (Ian, 2026-09-25).
//
// NOT a mock. It mounts the REAL DiagramCanvas, the REAL Marker, the REAL
// calloutRect() and the REAL FOCUS_SCALE, over the REAL hotspot coordinates of
// diagram 234 (SEC101, 1983x1317) read out of the live database on 2026-09-25,
// and then MEASURES THE DOM: the transform the component actually wrote, and
// where getBoundingClientRect() actually puts each marker on screen.
//
// It exists because the signed-in app needs a password I will not type, so the
// alternative was to ship the zoom unexercised. The precedent is
// DIAGRAM_STEP1_VERIFICATION.md, which measured the same way.
//
// What it does NOT cover: PowerSync, auth, the parts list, the click wiring in
// DiagramView. Those still need Ian's session.
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { DiagramCanvas, Marker, markerRadius, calloutRect, FOCUS_SCALE, type CanvasApi } from "../mobile/DiagramCanvas";
import { assetUrl } from "../assets";
import "../mobile/mobile.css";

const FRAME = { w: 1983, h: 1317 };          // diagram.img_w / img_h, row 234

// hotspot.x / hotspot.y for diagram 234, deleted_at is null, verbatim.
const HOTS = [
  { id: 95, part: 1009, x: 1066.50913043478, y: 670.772529203576 },
  { id: 96, part: 1007, x: 1544.76220472441, y: 747.243037037037 },
  { id: 97, part: 1008, x: 1215.82362204724, y: 591.154148148148 },
  { id: 100, part: 1004, x: 1448.19090909091, y: 198.302083184806 },
  { id: 101, part: 1005, x: 1850.8, y: 429.053598163489 },
  { id: 102, part: 1006, x: 1483.04363636364, y: 124.990403946787 },
  { id: 104, part: 1010, x: 511.269130434783, y: 1012.19402221722 },
  { id: 105, part: 1011, x: 442.40157480315, y: 1000.10703703704 },
  { id: 106, part: 1012, x: 975, y: 616 },
  { id: 107, part: 1013, x: 644.043913043478, y: 1105.30897485731 },
  { id: 108, part: 1014, x: 954.42652173913, y: 1010.46967124241 },
  { id: 109, part: 1015, x: 653, y: 845 },
  { id: 110, part: 1016, x: 742.331739130435, y: 888.040752030441 },
  { id: 111, part: 1016, x: 860, y: 959 },
  { id: 112, part: 1017, x: 307.07874015748, y: 1100.00392592593 },
  { id: 113, part: 1018, x: 947.259842519685, y: 749.324222222222 },
  { id: 114, part: 1019, x: 711, y: 541 },
  { id: 115, part: 1020, x: 863, y: 1079 },
  { id: 116, part: 1021, x: 504.371739130435, y: 874.24594423191 },
  { id: 120, part: 1001, x: 1355.02280701754, y: 622.301754385965 },
  { id: 376, part: 1002, x: 1128.59283205809, y: 426.64971034871 },
  { id: 377, part: 1003, x: 1652.85999613458, y: 432.675769705911 },
];

const out: string[] = [];
const check = (name: string, ok: boolean, detail?: string) =>
  out.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? "  — " + detail : ""}`);

/** The transform the component actually wrote on the <g>. */
function readTransform(g: SVGGElement) {
  const m = /translate\(([-\d.e]+) ([-\d.e]+)\) scale\(([-\d.e]+)\)/.exec(g.getAttribute("transform") ?? "");
  return m ? { tx: +m[1], ty: +m[2], s: +m[3] } : null;
}

function Harness() {
  const api = useRef<CanvasApi | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (done) return;
    const t = setTimeout(() => {
      const a = api.current;
      const svg = a?.svg();
      const g = svg?.querySelector("g") as SVGGElement | null;
      if (!a || !svg || !g) { out.push("FAIL harness could not reach the canvas"); setDone(true); return; }

      const r = markerRadius(FRAME.w, 1);
      const box = svg.getBoundingClientRect();
      const cx = box.left + box.width / 2, cy = box.top + box.height / 2;
      const centreOf = (id: number) => {
        const el = svg.querySelector(`[data-mk="${id}"]`) as SVGGElement | null;
        const b = el?.getBoundingClientRect();
        return b ? { x: b.left + b.width / 2, y: b.top + b.height / 2 } : null;
      };

      check("FOCUS_SCALE is the 15% Ian asked for", FOCUS_SCALE === 1.15, String(FOCUS_SCALE));

      // ── fit, as the viewer opens ────────────────────────────────────────
      a.reset();
      let t0 = readTransform(g);
      check("opens at fit: scale 1, no pan — the whole drawing on screen",
        !!t0 && t0.s === 1 && t0.tx === 0 && t0.ty === 0, JSON.stringify(t0));
      const allVisibleAtFit = HOTS.every((h) => {
        const c = centreOf(h.id);
        return c && c.x >= box.left - 1 && c.x <= box.right + 1 && c.y >= box.top - 1 && c.y <= box.bottom + 1;
      });
      check("all 22 markers are inside the frame at fit (hotspots visible on arrival)", allVisibleAtFit);

      // ── a marker near the middle of the drawing ─────────────────────────
      // 106 sits at (975, 616); the drawing's centre is (991.5, 658.5).
      const mid = HOTS.find((h) => h.id === 106)!;
      a.focus(calloutRect([mid], r), FOCUS_SCALE, true);
      t0 = readTransform(g);
      check("focus writes scale 1.15 exactly — a nudge, not zoomTo's old 8x clamp",
        !!t0 && Math.abs(t0.s - 1.15) < 1e-9, JSON.stringify(t0));
      const cMid = centreOf(106)!;
      check("a central marker lands at the centre of the view (within 1px)",
        Math.abs(cMid.x - cx) < 1 && Math.abs(cMid.y - cy) < 1,
        `marker (${cMid.x.toFixed(1)}, ${cMid.y.toFixed(1)}) vs centre (${cx.toFixed(1)}, ${cy.toFixed(1)})`);

      // the drawing must still be recognisable: count markers still on screen
      const onScreen = HOTS.filter((h) => {
        const c = centreOf(h.id);
        return c && c.x >= box.left && c.x <= box.right && c.y >= box.top && c.y <= box.bottom;
      }).length;
      check("context kept: most of the drawing's other callouts are still on screen",
        onScreen >= 15, `${onScreen} of 22 still visible at 1.15x`);

      // ── a marker near the edge: the clamp, documented and now measured ──
      // 101 sits at x=1850.8 of 1983 — hard against the right edge.
      const edge = HOTS.find((h) => h.id === 101)!;
      a.focus(calloutRect([edge], r), FOCUS_SCALE, true);
      const t1 = readTransform(g)!;
      const maxTx = FRAME.w * (1 - 1.15);
      check("an edge marker clamps rather than showing past the drawing's edge",
        Math.abs(t1.tx - maxTx) < 1e-6, `tx ${t1.tx.toFixed(3)} = the limit ${maxTx.toFixed(3)}`);
      const cEdge = centreOf(101)!;
      check("…so it is NOT centred, and the pulse ring is what says 'here'",
        cEdge.x > cx, `it sits ${(cEdge.x - cx).toFixed(0)}px right of centre, still on screen: ${cEdge.x <= box.right}`);

      // ── a part with two callouts (item 16) ──────────────────────────────
      const cA0 = () => centreOf(110)!, cB0 = () => centreOf(111)!;
      const pair = HOTS.filter((h) => h.part === 1016);
      check("part 1016 really does have two callouts on this drawing", pair.length === 2);
      a.focus(calloutRect(pair, r), FOCUS_SCALE, true);
      const t2 = readTransform(g)!;
      check("two callouts still zoom to 1.15, not tighter", Math.abs(t2.s - 1.15) < 1e-9, JSON.stringify(t2));
      // It aims at the midpoint of the two, then the clamp has its say — and
      // for this pair the clamp wins on BOTH axes: item 16 sits low and left,
      // so a 1.15x view centred on it would show past the drawing's edge. The
      // honest assertion is therefore "the transform is the clamped ideal",
      // not "it is centred". (The first version of this test asserted centring
      // and failed, which is how the clamp's reach got measured rather than
      // assumed: at 1.15x it governs everything outside the middle ~7% of the
      // drawing, and the pulse ring does the pointing.)
      const rect = calloutRect(pair, r);
      const want = (() => {
        const s = 1.15;
        const ideal = { tx: FRAME.w / 2 - (rect.x + rect.w / 2) * s, ty: FRAME.h / 2 - (rect.y + rect.h / 2) * s };
        return {
          tx: Math.min(0, Math.max(FRAME.w * (1 - s), ideal.tx)),
          ty: Math.min(0, Math.max(FRAME.h * (1 - s), ideal.ty)),
        };
      })();
      check("the view aims at the midpoint of the two callouts, then clamps to the drawing",
        Math.abs(t2.tx - want.tx) < 1e-6 && Math.abs(t2.ty - want.ty) < 1e-6,
        `got (${t2.tx.toFixed(3)}, ${t2.ty.toFixed(3)}), clamped ideal (${want.tx.toFixed(3)}, ${want.ty.toFixed(3)})`);
      const cA = cA0(), cB = cB0();
      check("and both callouts are on screen at once — neither is picked over the other",
        cA.x >= box.left && cA.x <= box.right && cA.y >= box.top && cA.y <= box.bottom &&
        cB.x >= box.left && cB.x <= box.right && cB.y >= box.top && cB.y <= box.bottom,
        `(${cA.x.toFixed(0)}, ${cA.y.toFixed(0)}) and (${cB.x.toFixed(0)}, ${cB.y.toFixed(0)}) in ${box.width.toFixed(0)}x${box.height.toFixed(0)}`);

      // ── focus must not disturb the markers themselves ───────────────────
      // The whole point of one transformed group: nothing repositions a marker.
      a.reset();
      const atFit = HOTS.map((h) => centreOf(h.id)!);
      a.focus(calloutRect([mid], r), FOCUS_SCALE, true);
      a.reset();
      const backAtFit = HOTS.map((h) => centreOf(h.id)!);
      const drift = Math.max(...atFit.map((p, i) => Math.hypot(p.x - backAtFit[i].x, p.y - backAtFit[i].y)));
      check("fit → focus → fit puts all 22 markers back exactly (no drift)", drift < 0.01, `max drift ${drift.toExponential(2)} px`);

      setDone(true);
    }, 600);   // let the bucket image load and lay out
    return () => clearTimeout(t);
  }, [done]);

  return (
    <div>
      <div style={{ height: 420, width: 700, background: "#111" }}>
        <DiagramCanvas
          href={assetUrl("assets/diagrams/section_101.png")}
          frame={FRAME} bind={(a) => { api.current = a; }}>
          {HOTS.map((h) => (
            <g key={h.id} data-mk={h.id}>
              <Marker x={h.x} y={h.y} r={markerRadius(FRAME.w, 1)} />
            </g>
          ))}
        </DiagramCanvas>
      </div>
      <pre id="results" style={{ color: "#ddd", background: "#000", padding: 12, fontSize: 13, whiteSpace: "pre-wrap" }}>
        {done ? out.join("\n") + `\n\n${out.filter((l) => l.startsWith("PASS")).length}/${out.length} passed` : "running…"}
      </pre>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
