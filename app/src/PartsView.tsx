import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { DetailPanel, type PartDetail, money, stockClass, usePrefs } from "./App";

type PartRow = {
  id: number; sku: string; locator: string | null; name: string; side: string | null;
  category_code: string | null; catalogue_pn: string | null; inventory_pn: string | null;
  status: string | null; match_status: string | null; qty_on_hand: number; bin: string | null;
  price_cents: number | null; has_photo: boolean; has_diagram: boolean; has_model: boolean;
};
type SortKey = "sku" | "name" | "category_code" | "qty_on_hand" | "status";
type Cat = { id: number; code: string; name: string };

type DeleteCheck = {
  part_id: number; sku: string; name: string; on_hand: number;
  open_orders: number; open_order_refs: string[]; historic_lines: number; blocked: boolean;
};
type DeletedRow = {
  id: number; sku: string; name: string;
  category_code: string | null; inventory_pn: string | null; deleted_at: string | null;
};

export default function PartsView() {
  const [rows, setRows] = useState<PartRow[]>([]);
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("sku");
  const [dir, setDir] = useState<1 | -1>(1);
  const [detail, setDetail] = useState<PartDetail | null>(null);
  const prefs = usePrefs();

  const [cats, setCats] = useState<Cat[]>([]);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newCat, setNewCat] = useState<number | null>(null);
  const newRef = useRef<HTMLInputElement>(null);

  const [bin, setBin] = useState(false);
  const [deleted, setDeleted] = useState<DeletedRow[]>([]);
  const [note, setNote] = useState<{ text: string; undo?: number; bad?: boolean } | null>(null);
  const noteTimer = useRef<number | undefined>(undefined);

  const load = useCallback(() => {
    invoke<PartRow[]>("list_parts").then(setRows).catch(console.error);
    invoke<DeletedRow[]>("list_deleted_parts").then(setDeleted).catch(console.error);
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { invoke<Cat[]>("list_categories").then(setCats).catch(console.error); }, []);

  /* A retirement is reversible, so the right affordance is an undo, not a
     confirmation dialog nobody reads. Blocked deletes say why instead. */
  const say = useCallback((raw: string, undo?: number, bad?: boolean) => {
    // Tauri rejects with the plain string our command returned; a thrown JS
    // Error arrives prefixed. Strip it so the operator sees the message only.
    const text = raw.replace(/^Error:\s*/, "");
    window.clearTimeout(noteTimer.current);
    setNote({ text, undo, bad });
    noteTimer.current = window.setTimeout(() => setNote(null), undo ? 9000 : 5000);
  }, []);

  const openPart = useCallback(async (partId: number) => {
    try { setDetail(await invoke<PartDetail>("part_detail", { partId })); }
    catch (e) { console.error(e); }
  }, []);

  const catCodes = useMemo(
    () => Array.from(new Set(rows.map((r) => r.category_code).filter(Boolean))).sort() as string[],
    [rows]
  );

  const view = useMemo(() => {
    const t = q.trim().toLowerCase();
    const v = rows.filter((r) =>
      (!cat || r.category_code === cat) &&
      (!t ||
        r.sku.toLowerCase().includes(t) ||
        r.name.toLowerCase().includes(t) ||
        (r.locator ?? "").toLowerCase().includes(t) ||
        (r.catalogue_pn ?? "").toLowerCase().includes(t) ||
        (r.inventory_pn ?? "").toLowerCase().includes(t)));
    return [...v].sort((a, b) => {
      const av = a[sortKey] ?? "", bv = b[sortKey] ?? "";
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
  }, [rows, q, cat, sortKey, dir]);

  const sortBy = (k: SortKey) => { if (k === sortKey) setDir((d) => (d === 1 ? -1 : 1)); else { setSortKey(k); setDir(1); } };
  const arrow = (k: SortKey) => (k === sortKey ? (dir === 1 ? " ▲" : " ▼") : "");

  /* ---- add ------------------------------------------------------------- */
  const startAdd = () => {
    setNewCat(cats.find((c) => c.code === cat)?.id ?? cats[0]?.id ?? null);
    setNewName("");
    setAdding(true);
    window.setTimeout(() => newRef.current?.focus(), 0);
  };
  const commitAdd = async () => {
    const name = newName.trim();
    if (!name || !newCat) { setAdding(false); return; }
    try {
      const id = await invoke<number>("create_part", { name, categoryId: newCat });
      setAdding(false);
      load();
      openPart(id);            // straight into the editor — no extra click
      say(`Added "${name}".`);
    } catch (e) { say(String(e), undefined, true); }
  };

  /* ---- delete / restore ------------------------------------------------ */
  const removePart = async (r: PartRow, ev: React.MouseEvent) => {
    ev.stopPropagation();
    try {
      const chk = await invoke<DeleteCheck>("delete_part", { partId: r.id });
      load();
      if (detail?.id === r.id) setDetail(null);
      const stock = chk.on_hand !== 0 ? ` — it still had ${chk.on_hand} on hand` : "";
      const hist = chk.historic_lines > 0 ? `, and ${chk.historic_lines} past order line(s) still point at it` : "";
      say(`Retired ${chk.sku}${stock}${hist}.`, r.id);
    } catch (e) { say(String(e), undefined, true); }
  };

  const restore = async (id: number) => {
    try {
      await invoke("restore_part", { partId: id });
      load();
      say("Restored.");
    } catch (e) { say(String(e), undefined, true); }
  };

  return (
    <div>
      <div className="ptbar">
        <input className="dgsearch" style={{ maxWidth: 320 }} placeholder="Search SKU, locator, OEM PN, name…"
          value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="locsel" value={cat} onChange={(e) => setCat(e.target.value)}>
          <option value="">All categories</option>
          {catCodes.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>

        {adding ? (
          <span className="addinline">
            <select className="locsel" value={newCat ?? ""} onChange={(e) => setNewCat(Number(e.target.value))}>
              {cats.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}
            </select>
            <input ref={newRef} className="dgsearch" style={{ maxWidth: 260 }} placeholder="Part name…"
              value={newName} onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void commitAdd(); if (e.key === "Escape") setAdding(false); }} />
            <button className="mini go" onClick={() => void commitAdd()}>Create</button>
            <button className="mini" onClick={() => setAdding(false)}>Cancel</button>
          </span>
        ) : (
          <button className="mini" onClick={startAdd}>＋ New part</button>
        )}

        <span className="spacer" />
        {deleted.length > 0 && (
          <button className={"mini" + (bin ? " on" : "")} onClick={() => setBin((b) => !b)}>
            🗑 Deleted ({deleted.length})
          </button>
        )}
        <span className="ptcount">{view.length} of {rows.length} parts</span>
      </div>

      {bin && (
        <div className="binpanel">
          <div className="binhead">Retired parts — the row is kept so old invoices still resolve</div>
          <table>
            <thead><tr><th>SKU</th><th>Name</th><th>Cat</th><th>OEM PN</th><th>Retired</th><th></th></tr></thead>
            <tbody>
              {deleted.map((d) => (
                <tr key={d.id}>
                  <td className="mono acc">{d.sku}</td>
                  <td>{d.name}</td>
                  <td className="dim">{d.category_code ?? "—"}</td>
                  <td className="mono dim">{d.inventory_pn ?? "—"}</td>
                  <td className="mono dim">{d.deleted_at ?? "—"}</td>
                  <td className="num"><button className="mini" onClick={() => void restore(d.id)}>Restore</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="pttable">
        <table>
          <thead>
            <tr>
              <th className="srt" onClick={() => sortBy("sku")}>SKU{arrow("sku")}</th>
              <th>Locator</th>
              <th className="srt" onClick={() => sortBy("name")}>Name{arrow("name")}</th>
              <th>Side</th>
              <th className="srt" onClick={() => sortBy("category_code")}>Cat{arrow("category_code")}</th>
              <th>OEM PN</th>
              <th className="srt num" onClick={() => sortBy("qty_on_hand")}>Qty{arrow("qty_on_hand")}</th>
              <th>Bin</th>
              {prefs.showStatus && <th className="srt" onClick={() => sortBy("status")}>Status{arrow("status")}</th>}
              <th>Media</th>
              <th className="num">Price</th>
              <th className="rmcol"></th>
            </tr>
          </thead>
          <tbody>
            {view.map((r) => (
              <tr key={r.id} onClick={() => openPart(r.id)}>
                <td className="mono acc">{r.sku}</td>
                <td className="mono dim">{r.locator ?? "—"}</td>
                <td>{r.name}</td>
                <td className="dim">{r.side ?? ""}</td>
                <td className="dim">{r.category_code}</td>
                <td className="mono dim">{r.catalogue_pn ?? "—"}</td>
                <td className="num"><span className={"qpill " + stockClass(r.qty_on_hand)}>{r.qty_on_hand}</span></td>
                <td className="mono dim">{r.bin ?? "—"}</td>
                {prefs.showStatus && (
                  <td><span className={"stat " + (r.match_status === "NOT IN CAT" ? "warn" : "")}>{r.status}</span></td>
                )}
                <td className="media-ico">
                  <span className={r.has_photo ? "on" : ""} title="photo">▦</span>
                  <span className={r.has_diagram ? "on" : ""} title="diagram">◎</span>
                  <span className={r.has_model ? "on" : ""} title="3D model">◳</span>
                </td>
                <td className="num mono">{money(r.price_cents)}</td>
                <td className="rmcol">
                  <button className="rmbtn" title={`Retire ${r.sku}`} onClick={(e) => void removePart(r, e)}>✕</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {note && (
        <div className={"ptnote" + (note.bad ? " bad" : "")}>
          <span>{note.text}</span>
          {note.undo !== undefined && (
            <button className="mini" onClick={() => { const id = note.undo!; setNote(null); void restore(id); }}>Undo</button>
          )}
        </div>
      )}

      {detail && <DetailPanel detail={detail} onClose={() => setDetail(null)} onPosted={() => { openPart(detail.id); load(); }} />}
    </div>
  );
}
