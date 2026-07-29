// CTP Core — counter / sales / accounting shell + part detail with media.
import { useEffect, useRef, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import SalesView from "./SalesView";
import AccountingView from "./AccountingView";
import DiagramsView from "./DiagramsView";
import PartsView from "./PartsView";
import ExplorerView from "./ExplorerView";
import JefreyView from "./jefrey/JefreyView";

export type Hit = {
  id: number;
  sku: string;
  name: string;
  brand: string | null;
  on_hand: number;
  price_cents: number | null;
  matched_on: string;
};

type StockLine = {
  location_id: number;
  location_code: string;
  location_name: string;
  on_hand: number;
  bin: string | null;
  reorder_point: number | null;
  reorder_qty: number | null;
};

type LedgerRow = {
  id: number;
  location_code: string;
  delta: number;
  reason: string;
  created_at: string;
};

type PartImage = { id: number; path: string; kind: string; is_primary: boolean };

export type PartDetail = {
  id: number;
  sku: string;
  locator: string | null;
  catalogue_pn: string | null;
  inventory_pn: string | null;
  mpn: string | null;
  name: string;
  side: string | null;
  make: string | null;
  model: string | null;
  drawing_no: string | null;
  diagram_item_no: number | null;
  category_code: string | null;
  category_name: string | null;
  match_status: string | null;
  notes: string | null;
  status: string | null;
  brand: string | null;
  description: string | null;
  price_cents: number | null;
  list_price_minor: number | null;
  total_on_hand: number;
  stock: StockLine[];
  ledger: LedgerRow[];
  images: PartImage[];
  diagram_image: string | null;
  diagram_item: string | null;
  model_3d: string | null;
};

// public/ assets are served from the web root; DB stores "assets/…" paths.
const asset = (p: string | null) => (p ? (/^https?:\/\//.test(p) ? p : "/" + p.replace(/^\/+/, "")) : "");
const SIDE_LABEL: Record<string, string> = { L: "L/H", R: "R/H", C: "Centre", B: "Both" };

// ---- view preferences (persisted locally, broadcast on change) ----
type Prefs = { showStatus: boolean; showNotes: boolean };
const PREFS_KEY = "ctp_prefs";
function loadPrefs(): Prefs {
  try { return { showStatus: true, showNotes: true, ...JSON.parse(localStorage.getItem(PREFS_KEY) || "{}") }; }
  catch { return { showStatus: true, showNotes: true }; }
}
function savePrefs(p: Prefs) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* ignore */ }
  window.dispatchEvent(new Event("ctp-prefs"));
}
export function usePrefs(): Prefs {
  const [p, setP] = useState<Prefs>(loadPrefs);
  useEffect(() => {
    const h = () => setP(loadPrefs());
    window.addEventListener("ctp-prefs", h);
    return () => window.removeEventListener("ctp-prefs", h);
  }, []);
  return p;
}

type PostResult = {
  movement_id: number;
  location_id: number;
  on_hand: number;
  duplicate: boolean;
};

export const money = (c: number | null) => (c == null ? "—" : "$" + (c / 100).toFixed(2));
export const stockClass = (n: number) => (n <= 0 ? "s-out" : n <= 5 ? "s-low" : "s-ok");

type View = "counter" | "parts" | "sales" | "accounting" | "diagrams" | "explorer" | "jefrey";

type Company = {
  name: string; address: string | null; phone: string | null; email: string | null;
  tax_id: string | null; currency: string; terms: string | null;
};

export default function App() {
  const [view, setView] = useState<View>("counter");
  const [settings, setSettings] = useState(false);
  return (
    <div className={"wrap" + (view === "parts" || view === "diagrams" || view === "explorer" || view === "jefrey" ? " wide" : "")}>
      <div className="brandbar">
        <img className="brandlogo" src="/assets/brand/ctp_logo_light.svg" alt="China Truck Parts" />
        <span className="corewm">Core</span>
        <nav className="nav">
          <button className={"navbtn" + (view === "counter" ? " on" : "")} onClick={() => setView("counter")}>Counter</button>
          <button className={"navbtn" + (view === "parts" ? " on" : "")} onClick={() => setView("parts")}>Parts</button>
          <button className={"navbtn" + (view === "sales" ? " on" : "")} onClick={() => setView("sales")}>Sales</button>
          <button className={"navbtn" + (view === "accounting" ? " on" : "")} onClick={() => setView("accounting")}>Accounting</button>
          <button className={"navbtn" + (view === "diagrams" ? " on" : "")} onClick={() => setView("diagrams")}>Diagrams</button>
          <button className={"navbtn" + (view === "explorer" ? " on" : "")} onClick={() => setView("explorer")}>3D&nbsp;Explorer</button>
          <button className={"navbtn" + (view === "jefrey" ? " on" : "")} onClick={() => setView("jefrey")}>Jefrey</button>
        </nav>
        <span className="kpi">local · offline-ready</span>
        <button className="gear" title="Company settings" onClick={() => setSettings(true)}>{"⚙"}</button>
      </div>
      {view === "counter" && <CounterView />}
      {view === "parts" && <PartsView />}
      {view === "sales" && <SalesView />}
      {view === "accounting" && <AccountingView />}
      {view === "diagrams" && <DiagramsView />}
      {view === "explorer" && <ExplorerView />}
      {view === "jefrey" && <JefreyView />}
      {settings && <SettingsModal onClose={() => setSettings(false)} />}
    </div>
  );
}

function SettingsModal({ onClose }: { onClose: () => void }) {
  const [c, setC] = useState<Company | null>(null);
  const [msg, setMsg] = useState("");
  const prefs = usePrefs();
  useEffect(() => { invoke<Company>("get_company").then(setC).catch(console.error); }, []);
  if (!c) return null;
  const f = (k: keyof Company) => (e: { target: { value: string } }) => setC({ ...c, [k]: e.target.value });
  const save = async () => {
    try { await invoke("set_company", { company: c }); setMsg("✓ saved"); }
    catch (e) { setMsg("✕ " + String(e)); }
  };
  return (
    <div className="overlay" onClick={onClose}>
      <div className="panel narrow" onClick={(ev) => ev.stopPropagation()}>
        <div className="phead">
          <span className="sku big">Company profile</span>
          <span className="spacer" />
          <button className="x" onClick={onClose}>{"✕"}</button>
        </div>
        <div className="sub">appears as the letterhead on quotes &amp; invoices</div>
        <label className="fld">Name<input value={c.name} onChange={f("name")} /></label>
        <label className="fld">Address<input value={c.address ?? ""} onChange={f("address")} /></label>
        <label className="fld">Phone<input value={c.phone ?? ""} onChange={f("phone")} /></label>
        <label className="fld">Email<input value={c.email ?? ""} onChange={f("email")} /></label>
        <label className="fld">Tax ID<input value={c.tax_id ?? ""} onChange={f("tax_id")} /></label>
        <label className="fld">Currency<input value={c.currency} onChange={f("currency")} /></label>
        <label className="fld">Terms<textarea rows={3} value={c.terms ?? ""} onChange={f("terms")} /></label>
        <button className="post" style={{ marginTop: 14 }} onClick={save}>Save</button>
        {msg && <div className={"msg" + (msg.startsWith("✕") ? " err" : "")}>{msg}</div>}

        <div className="sub" style={{ marginTop: 20 }}>Display &mdash; part detail</div>
        <label className="chk">
          <input type="checkbox" checked={prefs.showStatus}
            onChange={(e) => savePrefs({ ...prefs, showStatus: e.target.checked })} />
          Show Status tag (MATCHED / NOT IN CAT)
        </label>
        <label className="chk">
          <input type="checkbox" checked={prefs.showNotes}
            onChange={(e) => savePrefs({ ...prefs, showNotes: e.target.checked })} />
          Show Discrepancy Notes
        </label>
      </div>
    </div>
  );
}

function CounterView() {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState(0);
  const [detail, setDetail] = useState<PartDetail | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setHits([]); return; }
    let cancelled = false;
    setBusy(true);
    const t = setTimeout(async () => {
      try {
        const rows = await invoke<Hit[]>("search_parts", { query: term });
        if (!cancelled) { setHits(rows); setSel(0); }
      } catch (e) { console.error(e); }
      finally { if (!cancelled) setBusy(false); }
    }, 120);
    return () => { cancelled = true; clearTimeout(t); };
  }, [q]);

  const openDetail = useCallback(async (partId: number) => {
    try { setDetail(await invoke<PartDetail>("part_detail", { partId })); }
    catch (e) { console.error(e); }
  }, []);
  const refresh = useCallback(() => { if (detail) openDetail(detail.id); }, [detail, openDetail]);

  return (
    <div>
      <span className="tag">// parts counter {busy ? "· searching…" : ""}</span>
      <div className="searchbox">
        <input ref={inputRef} value={q} autoFocus
          placeholder="SKU, locator, OEM part no, name…"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, hits.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
            else if (e.key === "Enter" && hits[sel]) { e.preventDefault(); openDetail(hits[sel].id); }
          }} />
      </div>
      <div className="hint">Search by <b>any</b> number — public SKU, locator, OEM / inventory PN, or name.</div>
      <div className="count">{q.trim().length < 2 ? "" : `${hits.length} result${hits.length !== 1 ? "s" : ""}`}</div>
      {hits.map((h, i) => (
        <div className={"card" + (i === sel ? " active" : "")} key={h.id} onClick={() => openDetail(h.id)}>
          <div className="row1">
            <span className="sku">{h.sku}</span>
            <span className="nm">{h.name}</span>
            {h.brand && <span className="brand">{h.brand}</span>}
            <span className="spacer" />
            <span className={"stock " + stockClass(h.on_hand)}>{h.on_hand <= 0 ? "OUT" : h.on_hand + " on hand"}</span>
            <span className="price">{money(h.price_cents)}</span>
          </div>
          <div className="why">matched {h.matched_on} → {h.sku}</div>
        </div>
      ))}
      {q.trim().length >= 2 && hits.length === 0 && !busy && (
        <div className="empty">no cross-reference found for “{q}”</div>
      )}
      {detail && <DetailPanel detail={detail} onClose={() => setDetail(null)} onPosted={refresh} />}
    </div>
  );
}

type Action = "receipt" | "sale" | "adjustment";
const ACTIONS: { key: Action; label: string }[] = [
  { key: "receipt", label: "Receive" },
  { key: "sale", label: "Issue / Sell" },
  { key: "adjustment", label: "Adjust" },
];

// Visual identification: three-tier identity + photo + exploded diagram (with
// the part's callout number) + optional 3D model. For sales / admin / stock-take.
function PartMedia({ detail, onChanged }: { detail: PartDetail; onChanged?: () => void }) {
  const [sel, setSel] = useState(0);
  const [zoom, setZoom] = useState<string | null>(null);
  const prefs = usePrefs();
  const fileRef = useRef<HTMLInputElement>(null);
  const imgs = detail.images ?? [];
  const photo = imgs[sel]?.path ?? (imgs[0]?.path ?? null);
  // Open an image in an in-app lightbox. window.open() is blocked inside the
  // Tauri webview, so clicks did nothing — the overlay below replaces it.
  const open = (p: string | null) => { if (p) setZoom(asset(p)); };
  const addPhoto = async (file: File) => {
    const buf = new Uint8Array(await file.arrayBuffer());
    try {
      await invoke("save_part_image", { partId: detail.id, filename: file.name, bytes: Array.from(buf), kind: "photo" });
      onChanged?.();
    } catch (e) { console.error(e); }
  };
  const removeImg = async (id: number) => {
    try { await invoke("remove_part_image", { imageId: id }); setSel(0); onChanged?.(); } catch (e) { console.error(e); }
  };
  const makePrimary = async (id: number) => {
    try { await invoke("set_primary_image", { imageId: id }); onChanged?.(); } catch (e) { console.error(e); }
  };

  return (
    <div className="media">
      <div className="ident">
        {detail.locator && (
          <span className="idtok locator" title="Internal locator — find on the exploded diagram">{detail.locator}</span>
        )}
        {detail.catalogue_pn && (
          <span className="idtok oem" title="OEM catalogue PN — order more stock with this">OEM {detail.catalogue_pn}</span>
        )}
        {detail.inventory_pn && detail.inventory_pn !== detail.catalogue_pn && (
          <span className="idtok inv" title="Exact variant received">{detail.inventory_pn}</span>
        )}
        {detail.side && <span className="idtok side">{SIDE_LABEL[detail.side] ?? detail.side}</span>}
        {detail.category_name && <span className="idtok cat">{detail.category_name}</span>}
        {prefs.showStatus && detail.match_status && (
          <span className={"idtok ms " + (detail.match_status === "MATCHED" ? "ok" : "warn")}>{detail.match_status}</span>
        )}
        {detail.list_price_minor != null && (
          <span className="idtok list">List R{(detail.list_price_minor / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
        )}
      </div>

      <div className="mediagrid">
        <div className="mcell">
          <div className="mlabel">Photo
            <span className="spacer" />
            <button className="mini" title="Add photo" onClick={() => fileRef.current?.click()}>+ add</button>
            <input ref={fileRef} type="file" accept="image/*" style={{ display: "none" }}
              onChange={(e) => { const fl = e.target.files?.[0]; if (fl) addPhoto(fl); e.currentTarget.value = ""; }} />
          </div>
          {photo
            ? <img className="mimg" src={asset(photo)} alt={detail.name} onClick={() => open(photo)} />
            : <div className="mph">no photo yet</div>}
          {imgs.length > 0 && (
            <div className="thumbs">
              {imgs.map((im, i) => (
                <div key={im.id} className={"thumbw" + (i === sel ? " on" : "")}>
                  <img className="thumb" src={asset(im.path)} alt="" onClick={() => setSel(i)} />
                  {!im.is_primary && <button className="tbtn star" title="Set as primary" onClick={() => makePrimary(im.id)}>★</button>}
                  <button className="tbtn del" title="Remove" onClick={() => removeImg(im.id)}>✕</button>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="mcell">
          <div className="mlabel">
            Diagram{detail.drawing_no ? " · " + detail.drawing_no : ""}
            {detail.diagram_item != null && <span className="callout">▸ item {detail.diagram_item}</span>}
          </div>
          {detail.diagram_image
            ? <img className="mimg" src={asset(detail.diagram_image)} alt="exploded view" referrerPolicy="no-referrer"
                onClick={() => open(detail.diagram_image)}
                onError={(e) => (e.currentTarget as HTMLImageElement).classList.add("broken")} />
            : <div className="mph">no diagram</div>}
        </div>
      </div>
      {detail.model_3d && (
        <button className="model3d" onClick={() => open(detail.model_3d)}>◳ 3D model — {detail.inventory_pn ?? detail.sku} ⇗</button>
      )}
      {(detail.catalogue_pn || detail.inventory_pn) && (
        <button className="srcbtn" title="Look this part up on the supplier catalogue (rusauto43) — live price & isolated exploded view"
          onClick={() => invoke("open_url", { url: "https://www.google.com/search?q=" +
            encodeURIComponent("site:rusauto43.ru " + (detail.catalogue_pn || detail.inventory_pn)) }).catch(console.error)}>
          ₽ Check price &amp; supplier exploded view ⇗
        </button>
      )}
      {prefs.showNotes && detail.notes && <div className="pnote">⚠ {detail.notes}</div>}
      {zoom && (
        <div className="lightbox" onClick={() => setZoom(null)}>
          <img src={zoom} alt="enlarged" referrerPolicy="no-referrer" onClick={(e) => e.stopPropagation()} />
          <button className="lbx" title="Close (Esc)" onClick={() => setZoom(null)}>✕</button>
        </div>
      )}
    </div>
  );
}

// Edit every field of a part. Loads category list; can auto-build the locator
// from Make-Model-Drawing-Item per the naming convention.
function PartEditForm({ detail, onSaved, onCancel }: {
  detail: PartDetail; onSaved: () => void; onCancel: () => void;
}) {
  const [cats, setCats] = useState<{ id: number; code: string; name: string }[]>([]);
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
    invoke<{ id: number; code: string; name: string }[]>("list_categories").then((c) => {
      setCats(c);
      const cur = c.find((x) => x.name === detail.category_name);
      setF((p) => ({ ...p, category_id: cur?.id ?? (c[0]?.id ?? 0) }));
    }).catch(console.error);
  }, []);
  const set = (k: string) => (e: { target: { value: string } }) => setF((p) => ({ ...p, [k]: e.target.value }));
  const autoLoc = () => setF((p) => (p.make && p.model && p.drawing_no && p.diagram_item_no
    ? { ...p, locator: `${p.make}-${p.model}-${p.drawing_no}-${p.diagram_item_no.padStart(3, "0")}` } : p));
  const save = async () => {
    try {
      await invoke("update_part", { partId: detail.id, patch: {
        name: f.name, side: f.side || null, make: f.make || null, model: f.model || null,
        drawing_no: f.drawing_no || null, diagram_item_no: f.diagram_item_no ? parseInt(f.diagram_item_no, 10) : null,
        locator: f.locator || null, catalogue_pn: f.catalogue_pn || null, inventory_pn: f.inventory_pn || null,
        mpn: f.mpn || null, description: f.description || null, status: f.status,
        match_status: f.match_status || null, notes: f.notes || null, category_id: f.category_id,
        list_price_minor: f.list_price ? Math.round(parseFloat(f.list_price) * 100) : null,
      } });
      onSaved();
    } catch (e) { setMsg("✕ " + String(e)); }
  };
  return (
    <div className="editform">
      <label className="fld2">Name<input value={f.name} onChange={set("name")} /></label>
      <div className="efrow">
        <label className="fld2">Side
          <select value={f.side} onChange={set("side")}>
            <option value="">—</option><option value="L">L/H</option><option value="R">R/H</option>
            <option value="C">Centre</option><option value="B">Both</option>
          </select>
        </label>
        <label className="fld2">Category
          <select value={f.category_id} onChange={(e) => setF((p) => ({ ...p, category_id: Number(e.target.value) }))}>
            {cats.map((c) => <option key={c.id} value={c.id}>{c.code} — {c.name}</option>)}
          </select>
        </label>
        <label className="fld2">Status
          <select value={f.status} onChange={set("status")}>
            <option value="active">active</option><option value="superseded">superseded</option><option value="discontinued">discontinued</option>
          </select>
        </label>
      </div>
      <div className="efrow">
        <label className="fld2">Make<input value={f.make} onChange={set("make")} /></label>
        <label className="fld2">Model<input value={f.model} onChange={set("model")} /></label>
        <label className="fld2">Drawing<input value={f.drawing_no} onChange={set("drawing_no")} /></label>
        <label className="fld2">Item #<input value={f.diagram_item_no} onChange={set("diagram_item_no")} /></label>
      </div>
      <div className="efrow">
        <label className="fld2 grow">Locator<input value={f.locator} onChange={set("locator")} /></label>
        <button className="ghost" onClick={autoLoc} title="Build from Make-Model-Drawing-Item">auto</button>
      </div>
      <div className="efrow">
        <label className="fld2">Catalogue PN (reorder)<input value={f.catalogue_pn} onChange={set("catalogue_pn")} /></label>
        <label className="fld2">Inventory PN (variant)<input value={f.inventory_pn} onChange={set("inventory_pn")} /></label>
      </div>
      <div className="efrow">
        <label className="fld2">MPN<input value={f.mpn} onChange={set("mpn")} /></label>
        <label className="fld2">Match status<input value={f.match_status} onChange={set("match_status")} /></label>
        <label className="fld2">List Price (ZAR)<input value={f.list_price} onChange={set("list_price")} placeholder="0.00" /></label>
      </div>
      <label className="fld2">Description<textarea rows={2} value={f.description} onChange={set("description")} /></label>
      <label className="fld2">Notes<textarea rows={2} value={f.notes} onChange={set("notes")} /></label>
      <div className="efactions">
        <button className="post" onClick={save}>Save changes</button>
        <button className="ghost" onClick={onCancel}>Cancel</button>
        {msg && <span className="msg err">{msg}</span>}
      </div>
    </div>
  );
}

export function DetailPanel({ detail, onClose, onPosted }: {
  detail: PartDetail; onClose: () => void; onPosted: () => void;
}) {
  const [action, setAction] = useState<Action>("receipt");
  const [editing, setEditing] = useState(false);
  const [locId, setLocId] = useState<number>(detail.stock[0]?.location_id ?? 1);
  const [qty, setQty] = useState<string>("");
  const [msg, setMsg] = useState<string>("");
  const [posting, setPosting] = useState(false);
  const qtyRef = useRef<HTMLInputElement>(null);

  useEffect(() => { qtyRef.current?.focus(); }, [action]);

  const post = useCallback(async () => {
    const n = parseInt(qty, 10);
    if (!Number.isFinite(n) || n === 0) { setMsg("enter a quantity"); return; }
    let delta: number;
    if (action === "receipt") delta = Math.abs(n);
    else if (action === "sale") delta = -Math.abs(n);
    else delta = n;

    setPosting(true); setMsg("");
    try {
      const res = await invoke<PostResult>("post_movement", {
        partId: detail.id, locationId: locId, delta, reason: action,
        clientUuid: crypto.randomUUID(), actorId: null,
      });
      setMsg(res.duplicate
        ? "already posted (idempotent) — on hand " + res.on_hand
        : `posted · ${delta > 0 ? "+" : ""}${delta} → ${res.on_hand} on hand`);
      setQty(""); onPosted();
    } catch (e) { setMsg("✕ " + String(e)); } finally { setPosting(false); }
  }, [qty, action, locId, detail.id, onPosted]);

  return (
    <div className="overlay" onClick={onClose}>
      <div className="panel" onClick={(e) => e.stopPropagation()}>
        <div className="phead">
          <span className="sku big">{detail.sku}</span>
          <span className="nm">{detail.name}</span>
          {detail.brand && <span className="brand">{detail.brand}</span>}
          <span className="spacer" />
          <span className="price big">{money(detail.price_cents)}</span>
          <button className="x" onClick={() => setEditing((v) => !v)} title="Edit part">{editing ? "↩" : "✎"}</button>
          <button className="x" onClick={onClose} title="Esc">{"✕"}</button>
        </div>
        {editing
          ? <PartEditForm detail={detail} onSaved={() => { setEditing(false); onPosted(); }} onCancel={() => setEditing(false)} />
          : <PartMedia detail={detail} onChanged={onPosted} />}

        <div className="stockgrid">
          {detail.stock.map((s) => (
            <div className="sloc" key={s.location_id}>
              <div className="slabel">{s.location_name}</div>
              <div className={"sbig " + stockClass(s.on_hand)}>{s.on_hand}</div>
              <div className="smeta">
                {s.bin ? "bin " + s.bin : "no bin"}
                {s.reorder_point != null && (<> · ROP {s.reorder_point}
                  {s.on_hand <= s.reorder_point && <span className="flag"> REORDER</span>}</>)}
              </div>
            </div>
          ))}
        </div>

        <div className="mvbar">
          <div className="seg">
            {ACTIONS.map((a) => (
              <button key={a.key} className={"segbtn" + (action === a.key ? " on" : "")}
                onClick={() => setAction(a.key)}>{a.label}</button>
            ))}
          </div>
          <select className="locsel" value={locId} onChange={(e) => setLocId(Number(e.target.value))}>
            {detail.stock.map((s) => (<option key={s.location_id} value={s.location_id}>{s.location_code}</option>))}
          </select>
          <input ref={qtyRef} className="qty" value={qty} onChange={(e) => setQty(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); post(); } }}
            placeholder={action === "adjustment" ? "± qty" : "qty"} inputMode="numeric" />
          <button className="post" onClick={post} disabled={posting}>{posting ? "…" : "Post ⏎"}</button>
        </div>
        {msg && <div className={"msg" + (msg.startsWith("✕") ? " err" : "")}>{msg}</div>}

        <div className="count">ledger · {detail.total_on_hand} total on hand</div>
        <div className="ledger">
          {detail.ledger.map((r) => (
            <div className="lrow" key={r.id}>
              <span className="lwhen">{r.created_at}</span>
              <span className="lloc">{r.location_code}</span>
              <span className={"lreason r-" + r.reason}>{r.reason}</span>
              <span className={"ldelta " + (r.delta >= 0 ? "pos" : "neg")}>{r.delta > 0 ? "+" : ""}{r.delta}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
