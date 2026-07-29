// CTP Core — 3D Parts Explorer.
// Ported from the standalone FAW_JH6_3D_Explorer.html into a React/Tauri view.
// The truck GLB + section "blobs" are rendered with three.js; parts data is
// pulled live from the DB (list_parts) and grouped by category_code, and
// clicking a part opens the shared DetailPanel — same panel Parts/Diagrams use.
import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { DetailPanel, type PartDetail, stockClass } from "./App";

const TRUCK_URL = "/assets/models/truck_pbr.glb";

type PartRow = {
  id: number; sku: string; locator: string | null; name: string; side: string | null;
  category_code: string | null; catalogue_pn: string | null; inventory_pn: string | null;
  status: string | null; match_status: string | null; qty_on_hand: number; bin: string | null;
  price_cents: number | null; has_photo: boolean; has_diagram: boolean; has_model: boolean;
};

type Shape = "box" | "sph" | "cyl";
type Layout = { color: string; shape: Shape; size: [number, number, number]; spread: [number, number, number] };

// 3D layout for each catalogue section, keyed by the leading category code
// (101 FRONT BUMPER … 116 AIR CONDITIONING). Colour/shape/position only —
// the part contents come from the DB.
const SECTION_LAYOUT: Record<string, Layout> = {
  "101": { color: "#FF6B6B", shape: "box", size: [0.55, 0.12, 0.32], spread: [-2.5, -0.8, -2.3] },
  "102": { color: "#4ECDC4", shape: "box", size: [0.72, 0.08, 0.56], spread: [0, -2.3, 0] },
  "103": { color: "#FFE66D", shape: "sph", size: [0.22, 0, 0], spread: [-2.5, 1.5, -2.0] },
  "104": { color: "#95E1D3", shape: "cyl", size: [0.14, 0, 0.42], spread: [0.5, -1.9, 1.5] },
  "105": { color: "#F38181", shape: "box", size: [0.42, 0.30, 0.14], spread: [2.6, -0.5, -1.5] },
  "106": { color: "#A8D8EA", shape: "box", size: [0.30, 0.20, 0.38], spread: [2.3, 0.2, 1.2] },
  "107": { color: "#AA96DA", shape: "box", size: [0.36, 0.46, 0.30], spread: [-1.0, 0.8, 2.4] },
  "108": { color: "#FCBAD3", shape: "box", size: [0.52, 0.42, 0.08], spread: [0, 0.5, -3.0] },
  "109": { color: "#B8F7B8", shape: "box", size: [0.10, 0.52, 0.42], spread: [-3.0, 0.5, 0] },
  "110": { color: "#FFF3B0", shape: "sph", size: [0.18, 0, 0], spread: [3.0, 1.8, -0.8] },
  "111": { color: "#E8C4B8", shape: "box", size: [0.48, 0.08, 0.28], spread: [1.6, -1.5, -1.2] },
  "112": { color: "#C8E6C9", shape: "box", size: [0.42, 0.06, 0.28], spread: [1.8, -1.5, 1.8] },
  "113": { color: "#A7C5BD", shape: "cyl", size: [0.06, 0, 0.52], spread: [0, 2.3, -2.0] },
  "114": { color: "#E8D4B0", shape: "box", size: [0.52, 0.58, 0.42], spread: [0, 1.8, 0.6] },
  "115": { color: "#C5A3FF", shape: "box", size: [0.58, 0.08, 0.48], spread: [0, 3.0, 0] },
  "116": { color: "#87CEEB", shape: "box", size: [0.32, 0.22, 0.20], spread: [-2.4, 0.5, 1.8] },
};

const FALLBACK_COLORS = ["#FF6B6B", "#4ECDC4", "#FFE66D", "#95E1D3", "#F38181", "#A8D8EA",
  "#AA96DA", "#FCBAD3", "#B8F7B8", "#FFF3B0", "#E8C4B8", "#C8E6C9", "#A7C5BD", "#E8D4B0", "#C5A3FF", "#87CEEB"];

// Status → colour, mirrors the standalone explorer / catalogue palette.
const STATUS_COLOR: Record<string, { c: string; b: string; bg: string }> = {
  "MATCHED": { c: "#3fb950", b: "#238636", bg: "#12291c" },
  "NOT IN CAT": { c: "#bc8cff", b: "#6e40c9", bg: "#1f1533" },
  "VARIANT": { c: "#e3b341", b: "#9e6a03", bg: "#2a2109" },
  "ERROR": { c: "#ff7b72", b: "#da3633", bg: "#2a1013" },
  "DUPLICATE": { c: "#f0883e", b: "#b46811", bg: "#2a1a0a" },
};

type Section = { code: string; name: string; layout: Layout; parts: PartRow[] };

const ORIGIN = new THREE.Vector3(0, 0.55, 0);
const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

export default function ExplorerView() {
  const [rows, setRows] = useState<PartRow[]>([]);
  const [exploded, setExploded] = useState(false);
  const [selectedCode, setSelectedCode] = useState<string | null>(null);
  const [detail, setDetail] = useState<PartDetail | null>(null);
  const [ready, setReady] = useState(false);
  const [loadPct, setLoadPct] = useState<number | null>(null);

  const mountRef = useRef<HTMLDivElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);

  // Load parts once.
  useEffect(() => {
    invoke<PartRow[]>("list_parts").then(setRows).catch(console.error);
  }, []);

  // Group parts → sections in catalogue order.
  const sections = useMemo<Section[]>(() => {
    const byCode = new Map<string, PartRow[]>();
    for (const r of rows) {
      const code = (r.category_code ?? "misc").trim();
      (byCode.get(code) ?? byCode.set(code, []).get(code)!).push(r);
    }
    let i = 0;
    return Array.from(byCode.entries())
      .sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))
      .map(([code, parts]) => {
        const layout = SECTION_LAYOUT[code] ?? ringLayout(i, FALLBACK_COLORS[i % FALLBACK_COLORS.length]);
        i++;
        return { code, name: parts[0]?.category_code ? sectionName(code, parts) : code, layout, parts };
      });
  }, [rows]);

  // Mutable mirror of React state for the imperative render loop.
  const stateRef = useRef({ exploded: false, selectedCode: null as string | null, sections: [] as Section[] });
  useEffect(() => { stateRef.current.exploded = exploded; }, [exploded]);
  useEffect(() => { stateRef.current.selectedCode = selectedCode; }, [selectedCode]);
  useEffect(() => { stateRef.current.sections = sections; }, [sections]);

  const openPart = useCallback(async (id: number) => {
    try { setDetail(await invoke<PartDetail>("part_detail", { partId: id })); }
    catch (e) { console.error(e); }
  }, []);

  // ─── three.js scene (built once, rebuilt when sections first arrive) ───────
  useEffect(() => {
    const mount = mountRef.current, labelDiv = labelsRef.current;
    if (!mount || !labelDiv || !sections.length) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x111316);
    scene.fog = new THREE.FogExp2(0x0d0f12, 0.02);

    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.set(2.5, 1.6, 3.8);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMappingExposure = 1.15;
    mount.appendChild(renderer.domElement);

    // Image-based lighting — the model's materials are fully metallic (metalness=1),
    // so they render black without an environment to reflect. RoomEnvironment gives
    // a neutral studio IBL that makes the PBR shading read correctly.
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
    scene.environment = envRT.texture;
    scene.environmentIntensity = 1.15;

    const resize = () => {
      const w = mount.clientWidth, h = mount.clientHeight;
      if (!w || !h) return;
      camera.aspect = w / h; camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    resize();
    const ro = new ResizeObserver(resize); ro.observe(mount);

    // Studio lighting (three-point + section highlight).
    scene.add(new THREE.HemisphereLight(0x7799cc, 0x221408, 0.6));
    scene.add(new THREE.AmbientLight(0xffffff, 0.25));
    const key = new THREE.DirectionalLight(0xfff4e0, 1.4);
    key.position.set(3.5, 9, 5); key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.near = 0.5; key.shadow.camera.far = 30;
    key.shadow.camera.left = -4; key.shadow.camera.right = 4;
    key.shadow.camera.top = 5; key.shadow.camera.bottom = -3;
    key.shadow.bias = -0.0003; scene.add(key);
    const fill = new THREE.DirectionalLight(0xb0ccff, 0.7); fill.position.set(-5, 4, 3); scene.add(fill);
    const rim = new THREE.DirectionalLight(0xffffff, 1.2); rim.position.set(-0.5, 4, -8); scene.add(rim);
    const kick = new THREE.DirectionalLight(0xffcc88, 0.3); kick.position.set(5, -1, 2); scene.add(kick);
    const sectionLight = new THREE.PointLight(0xffffff, 0, 8); scene.add(sectionLight);

    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(10, 64),
      new THREE.MeshStandardMaterial({ color: 0x0e1014, roughness: 1 }));
    floor.rotation.x = -Math.PI / 2; floor.position.y = -0.02; floor.receiveShadow = true;
    scene.add(floor);
    const grid = new THREE.GridHelper(16, 32, 0x1c2128, 0x161b22); grid.position.y = -0.015; scene.add(grid);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 0.55, 0);
    controls.enableDamping = true; controls.dampingFactor = 0.06;
    controls.minDistance = 1.5; controls.maxDistance = 12;
    controls.update();

    // ── Blobs + labels, one per section ──
    const secs = stateRef.current.sections;
    const dirs = secs.map((s) => new THREE.Vector3(...s.layout.spread).normalize());
    const blobs: THREE.Mesh[] = [];
    const labelEls: HTMLDivElement[] = [];
    secs.forEach((s, i) => {
      const L = s.layout;
      const geo: THREE.BufferGeometry =
        L.shape === "sph" ? new THREE.SphereGeometry(L.size[0], 16, 12)
          : L.shape === "cyl" ? new THREE.CylinderGeometry(L.size[0], L.size[0], L.size[2], 16)
            : new THREE.BoxGeometry(L.size[0], L.size[1], L.size[2]);
      const mat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(L.color), emissive: new THREE.Color(L.color),
        emissiveIntensity: 0.18, metalness: 0.15, roughness: 0.55, transparent: true, opacity: 0,
      });
      const m = new THREE.Mesh(geo, mat);
      m.position.copy(ORIGIN); m.visible = false; m.userData.i = i;
      scene.add(m); blobs.push(m);

      const el = document.createElement("div");
      el.className = "exp-label";
      el.innerHTML = `<div class="exp-pill">${s.name}</div><div class="exp-count">${s.parts.length} part${s.parts.length !== 1 ? "s" : ""}</div>`;
      el.addEventListener("click", () => { setExploded(true); setSelectedCode(s.code); });
      labelDiv.appendChild(el); labelEls.push(el);
    });

    // ── Truck model ──
    const truckMeshes: THREE.Mesh[] = [];
    let truckGroup: THREE.Object3D | null = null;
    const fit = (g: THREE.Object3D) => {
      const box = new THREE.Box3().setFromObject(g);
      const ctr = box.getCenter(new THREE.Vector3());
      const sz = box.getSize(new THREE.Vector3());
      const sc = 2.2 / Math.max(sz.x, sz.y, sz.z);
      g.scale.setScalar(sc);
      g.position.sub(ctr.multiplyScalar(sc));
      g.position.y -= new THREE.Box3().setFromObject(g).min.y;
    };
    const registerTruck = (g: THREE.Object3D) => {
      g.traverse((c) => {
        const mesh = c as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.castShadow = true;
        truckMeshes.push(mesh);
      });
    };
    new GLTFLoader().load(
      TRUCK_URL,
      (gltf) => {
        truckGroup = gltf.scene; fit(truckGroup); registerTruck(truckGroup);
        scene.add(truckGroup); setReady(true); setLoadPct(null);
      },
      (xhr) => { if (xhr.total) setLoadPct(Math.round((xhr.loaded / xhr.total) * 100)); },
      () => { buildFallback(); setReady(true); setLoadPct(null); }
    );
    function buildFallback() {
      const g = new THREE.Group();
      const cab = new THREE.MeshStandardMaterial({ color: 0xb8c8d4, roughness: 0.6 });
      const dark = new THREE.MeshStandardMaterial({ color: 0x2a3040, roughness: 0.8 });
      const box = (x: number, y: number, z: number, w: number, h: number, d: number, mt = cab) => {
        const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mt); m.position.set(x, y, z); g.add(m);
      };
      box(0, 0.06, 0.10, 0.80, 0.12, 2.0); box(0, 0.53, -0.40, 0.79, 0.95, 1.05);
      box(0, 1.06, -0.40, 0.76, 0.09, 0.58); box(0, 0.20, -0.96, 0.84, 0.18, 0.06);
      box(0, 0.62, -0.97, 0.70, 0.55, 0.06); box(-0.38, 0.48, -0.40, 0.04, 0.55, 0.95);
      box(0.38, 0.48, -0.40, 0.04, 0.55, 0.95);
      [[-0.44, -0.74], [0.44, -0.74], [-0.44, 0.70], [0.44, 0.70]].forEach(([x, z]) => {
        const w = new THREE.Mesh(new THREE.CylinderGeometry(0.195, 0.195, 0.14, 18), dark);
        w.rotation.z = Math.PI / 2; w.position.set(x, 0.195, z); g.add(w);
      });
      scene.add(g); truckGroup = g; registerTruck(g);
    }
    const setTruckAlpha = (a: number) => {
      truckMeshes.forEach((m) => {
        const mats = Array.isArray(m.material) ? m.material : [m.material];
        mats.forEach((mat: any) => { mat.transparent = a < 1; mat.opacity = a; mat.depthWrite = a >= 0.99; });
      });
    };

    // ── Hover tint (emissive save/restore) ──
    const origEm = new WeakMap<any, { col: THREE.Color; int: number }>();
    const tint = (m: THREE.Mesh, hex: string, intensity: number) =>
      (Array.isArray(m.material) ? m.material : [m.material]).forEach((mat: any) => {
        if (!origEm.has(mat)) origEm.set(mat, { col: mat.emissive.clone(), int: mat.emissiveIntensity || 0 });
        mat.emissive.set(hex); mat.emissiveIntensity = intensity;
      });
    const untint = (m: THREE.Mesh) =>
      (Array.isArray(m.material) ? m.material : [m.material]).forEach((mat: any) => {
        const o = origEm.get(mat); if (o) { mat.emissive.copy(o.col); mat.emissiveIntensity = o.int; }
      });

    const ray = new THREE.Raycaster();
    const tip = document.createElement("div"); tip.className = "exp-tip"; labelDiv.appendChild(tip);
    let hoverMesh: THREE.Mesh | null = null;
    const secIdxByDir = (pt: THREE.Vector3) => {
      const d = pt.clone().sub(ORIGIN).normalize();
      let best = 0, bd = -Infinity;
      dirs.forEach((v, i) => { const dot = d.dot(v); if (dot > bd) { bd = dot; best = i; } });
      return best;
    };
    const ndc = (e: PointerEvent) => {
      const r = renderer.domElement.getBoundingClientRect();
      return { x: ((e.clientX - r.left) / r.width) * 2 - 1, y: -((e.clientY - r.top) / r.height) * 2 + 1, cx: e.clientX - r.left, cy: e.clientY - r.top };
    };

    const onMove = (e: PointerEvent) => {
      const p = ndc(e);
      if (!stateRef.current.exploded) {
        ray.setFromCamera(new THREE.Vector2(p.x, p.y), camera);
        const hits = ray.intersectObjects(truckMeshes, true);
        if (hits.length) {
          const mesh = hits[0].object as THREE.Mesh;
          const si = secIdxByDir(hits[0].point);
          if (mesh !== hoverMesh) { if (hoverMesh) untint(hoverMesh); hoverMesh = mesh; tint(mesh, secs[si].layout.color, 0.45); }
          tip.innerHTML = `<span style="color:${secs[si].layout.color}">●</span> ${secs[si].name} <span class="exp-tipsub">${secs[si].parts.length} parts</span>`;
          tip.style.borderColor = secs[si].layout.color + "99";
          tip.style.left = p.cx + "px"; tip.style.top = p.cy + "px"; tip.style.display = "block";
        } else { if (hoverMesh) { untint(hoverMesh); hoverMesh = null; } tip.style.display = "none"; }
      } else { tip.style.display = "none"; }
    };
    const onClick = (e: PointerEvent) => {
      const p = ndc(e);
      ray.setFromCamera(new THREE.Vector2(p.x, p.y), camera);
      if (!stateRef.current.exploded) {
        if (ray.intersectObjects(truckMeshes, true).length) {
          if (hoverMesh) { untint(hoverMesh); hoverMesh = null; }
          setExploded(true);
        }
      } else {
        const bh = ray.intersectObjects(blobs, false);
        if (bh.length) setSelectedCode(secs[(bh[0].object as THREE.Mesh).userData.i].code);
      }
    };
    let downXY = { x: 0, y: 0 };
    const onDown = (e: PointerEvent) => { downXY = { x: e.clientX, y: e.clientY }; };
    const onUp = (e: PointerEvent) => {
      if (Math.hypot(e.clientX - downXY.x, e.clientY - downXY.y) < 5) onClick(e);
    };
    const dom = renderer.domElement;
    dom.addEventListener("pointermove", onMove);
    dom.addEventListener("pointerdown", onDown);
    dom.addEventListener("pointerup", onUp);

    // ── Animation loop ──
    const v = new THREE.Vector3();
    let progress = 0; // 0 truck … 1 exploded
    let raf = 0;
    const clock = new THREE.Clock();
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const dt = Math.min(clock.getDelta(), 0.05);
      const target = stateRef.current.exploded ? 1 : 0;
      progress += (target - progress) * Math.min(1, dt * 4);
      const e = easeInOut(Math.max(0, Math.min(1, progress)));

      setTruckAlpha(1 - e * 0.82);
      blobs.forEach((b, i) => {
        const L = secs[i].layout;
        b.visible = e > 0.01;
        // lerp origin → spread position
        b.position.set(ORIGIN.x + L.spread[0] * e, ORIGIN.y + (L.spread[1] - ORIGIN.y) * e, ORIGIN.z + L.spread[2] * e);
        (b.material as THREE.MeshStandardMaterial).opacity = e;
        const sel = stateRef.current.selectedCode === secs[i].code;
        (b.material as THREE.MeshStandardMaterial).emissiveIntensity = sel ? 0.6 : 0.18;
        b.scale.setScalar(sel ? 1.14 : 1);
      });

      // Section highlight light follows selection.
      const selIdx = secs.findIndex((s) => s.code === stateRef.current.selectedCode);
      if (selIdx >= 0 && e > 0.3) {
        const L = secs[selIdx].layout;
        sectionLight.position.set(L.spread[0], L.spread[1], L.spread[2]);
        sectionLight.color.set(L.color); sectionLight.intensity = 2.2; sectionLight.distance = 8;
      } else sectionLight.intensity = 0;

      // Project labels to screen.
      const w = mount.clientWidth, h = mount.clientHeight;
      labelEls.forEach((el, i) => {
        if (e < 0.55) { el.style.display = "none"; return; }
        v.copy(blobs[i].position).project(camera);
        if (v.z > 1) { el.style.display = "none"; return; }
        el.style.display = "flex";
        el.style.left = ((v.x * 0.5 + 0.5) * w) + "px";
        el.style.top = ((-v.y * 0.5 + 0.5) * h) + "px";
        el.classList.toggle("sel", stateRef.current.selectedCode === secs[i].code);
        el.style.opacity = String((e - 0.55) / 0.45);
      });

      controls.update();
      renderer.render(scene, camera);
    };
    loop();

    // ── Cleanup ──
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      dom.removeEventListener("pointermove", onMove);
      dom.removeEventListener("pointerdown", onDown);
      dom.removeEventListener("pointerup", onUp);
      controls.dispose();
      envRT.dispose();
      pmrem.dispose();
      renderer.dispose();
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        if (m.material) (Array.isArray(m.material) ? m.material : [m.material]).forEach((x: any) => x.dispose?.());
      });
      labelEls.forEach((el) => el.remove());
      tip.remove();
      if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
    };
  }, [sections]);

  const backToTruck = useCallback(() => { setExploded(false); setSelectedCode(null); }, []);
  const selected = sections.find((s) => s.code === selectedCode) || null;

  return (
    <div className="exp3d">
      <div className="exp-stage">
        <div ref={mountRef} className="exp-canvas" />
        <div ref={labelsRef} className="exp-labels" />
        {!ready && (
          <div className="exp-loading">
            <div className="exp-spin" />
            <div className="exp-loadtxt">{loadPct != null ? `Loading model… ${loadPct}%` : "Loading 3D model"}</div>
          </div>
        )}
        {ready && (
          <div className="exp-hint">
            {exploded
              ? <>Click a <b>section</b> to view its parts</>
              : <><b>Click the truck</b> to explode into sections · drag to orbit</>}
          </div>
        )}
        {exploded && (
          <button className="exp-back" onClick={backToTruck}>← Back to truck</button>
        )}
        <div className="exp-legend">
          <span className="exp-legval" style={{ color: "#3fb950" }}>{rows.length}</span> parts ·{" "}
          <span className="exp-legval">{sections.length}</span> sections
        </div>
      </div>

      {/* Section parts panel */}
      <aside className={"exp-panel" + (selected ? " open" : "")}>
        {selected && (
          <>
            <div className="exp-panel-bar" style={{ background: selected.layout.color }} />
            <div className="exp-panel-hdr">
              <div>
                <div className="exp-panel-title">{selected.name}</div>
                <div className="exp-panel-meta">{selected.parts.length} parts · section {selected.code}</div>
              </div>
              <button className="exp-x" onClick={() => setSelectedCode(null)} title="Close">✕</button>
            </div>
            <div className="exp-parts">
              {selected.parts.map((p) => {
                const sc = STATUS_COLOR[(p.match_status || p.status || "").toUpperCase()];
                return (
                  <div key={p.id} className="exp-pi" onClick={() => openPart(p.id)}>
                    <div className="exp-pi-top">
                      <span className="exp-pname">{p.name}</span>
                      <span className={"exp-qty " + stockClass(p.qty_on_hand)}>{p.qty_on_hand}</span>
                    </div>
                    <div className="exp-ppn">{p.inventory_pn || p.catalogue_pn || p.sku}</div>
                    <div className="exp-prow">
                      {p.side && <span className="exp-side">{p.side}</span>}
                      {sc && <span className="exp-badge" style={{ color: sc.c, background: sc.bg, borderColor: sc.b }}>{p.match_status || p.status}</span>}
                      {p.has_photo && <span className="exp-ico" title="Photo">📷</span>}
                      {p.has_diagram && <span className="exp-ico" title="Diagram">▤</span>}
                      {p.has_model && <span className="exp-ico" title="3D model">◳</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </aside>

      {detail && <DetailPanel detail={detail} onClose={() => setDetail(null)} onPosted={() => openPart(detail.id)} />}
    </div>
  );
}

// ── helpers ──
function sectionName(code: string, _parts: PartRow[]): string {
  const known: Record<string, string> = {
    "101": "Front Bumper", "102": "Chassis", "103": "Lighting", "104": "Cab Suspension",
    "105": "Fender", "106": "Side Toolbox", "107": "Cab Exterior", "108": "Front Wall",
    "109": "Front Door", "110": "Mirror", "111": "Steps & Trim", "112": "Mudguard",
    "113": "Wiper", "114": "Cab Body", "115": "Roof Deflector", "116": "Air Conditioning",
  };
  return known[code] ?? `Section ${code}`;
}
function ringLayout(i: number, color: string): Layout {
  const a = (i / 8) * Math.PI * 2;
  return { color, shape: "box", size: [0.34, 0.24, 0.24], spread: [Math.cos(a) * 2.8, 0.4 + (i % 3) * 0.6, Math.sin(a) * 2.8] };
}
