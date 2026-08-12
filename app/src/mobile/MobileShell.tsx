// CTP Core — the mobile shell. What a phone gets instead of the desktop App.
//
// This is the warehouse-floor surface: one hand, gloves, bad light. Design
// rules it is built around (approved prototype v3):
//   * the BIN is the hero — the answer to "where do I walk?" reads from 2m away
//   * one search field, every identifier (SKU / OEM pn / locator / xref / name)
//   * the counter posts to the append-only ledger with no confirm step —
//     a mistake is one Undo away (the inverse movement), so don't make every
//     correct tap pay a "are you sure?" tax
//   * nothing desktop-only leaks in: everything rendered here runs through
//     src/data/api and the commands backend.web.ts actually ports
//
// It renders ONLY in a browser (AuthedApp routes isTauri to the desktop App),
// so assetUrl() always resolves to Supabase Storage here, and PowerSync is
// always the data source underneath.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStatus } from "@powersync/react";
import * as api from "../data/api";
import { assetUrl } from "../assets";
import { makeUuid } from "../data/uuid";
import { useAuth } from "../auth/AuthProvider";
import "./mobile.css";

// ─── shapes (mirror backend.web.ts returns) ──────────────────────────────────

type Cat = { id: number; code: string; name: string };

type PartRow = {
  id: number; sku: string; name: string; category_code: string | null;
  qty_on_hand: number; bin: string | null; price_cents: number | null;
  image?: string | null;
};

type Hit = {
  id: number; sku: string; name: string; brand: string | null;
  on_hand: number; price_cents: number | null; matched_on: string;
  bin?: string | null; thumb?: string | null;
};

type StockLine = {
  location_id: number; location_code: string; location_name: string;
  on_hand: number; bin: string | null;
};

type LedgerLine = {
  id: number; location_code: string; delta: number; reason: string; created_at: string;
};

type Detail = {
  id: number; sku: string; name: string; locator: string | null;
  catalogue_pn: string | null; inventory_pn: string | null; brand: string | null;
  category_name: string | null; drawing_no: string | null; notes: string | null;
  price_cents: number | null; total_on_hand: number;
  stock: StockLine[]; ledger: LedgerLine[];
  images: { id: number; path: string; is_primary: boolean }[];
  diagram_image: string | null; diagram_item: string | null;
};

type Toast = { text: string; err?: boolean; undo?: () => void };

// ─── tiny helpers ────────────────────────────────────────────────────────────

const fmtR = (cents: number | null | undefined): string =>
  cents == null ? "—" : "R " + (cents / 100).toLocaleString("en-ZA", {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });

const qtyClass = (n: number): string => (n <= 0 ? " zero" : n <= 2 ? " low" : "");

const timeAgo = (iso: string): string => {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(t).toLocaleDateString("en-ZA");
};

// The brand mark lives in the same bucket as every other asset.
const LOGO = "assets/brand/ctp_logo_dark.png";

// ─── icons (inline so the shell has zero icon deps) ──────────────────────────

const IcSearch = () => (
  <svg viewBox="0 0 24 24"><path d="M15.5 14h-.79l-.28-.27a6.5 6.5 0 1 0-.7.7l.27.28v.79l5 4.99L20.49 19zm-6 0A4.5 4.5 0 1 1 14 9.5 4.5 4.5 0 0 1 9.5 14z"/></svg>
);
const IcPin = () => (
  <svg viewBox="0 0 24 24"><path d="M12 2a7 7 0 0 0-7 7c0 5.25 7 13 7 13s7-7.75 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 14.5 9 2.5 2.5 0 0 1 12 11.5z"/></svg>
);
const TabFind = () => (
  <svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/></svg>
);
const TabShelf = () => (
  <svg viewBox="0 0 24 24"><path d="M3 4h18M3 12h18M3 20h18M6 4v8M14 4v8M10 12v8M17 12v8"/></svg>
);
const TabInfo = () => (
  <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8v.01"/></svg>
);

// ─── the shell ───────────────────────────────────────────────────────────────

export default function MobileShell() {
  const status = useStatus();
  const { session, signOut } = useAuth();

  const [tab, setTab] = useState<"find" | "shelf" | "info">("find");
  const [parts, setParts] = useState<PartRow[]>([]);
  const [cats, setCats] = useState<Cat[]>([]);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null); // null = not searching
  const [chip, setChip] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [counterOpen, setCounterOpen] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);

  // ── data loads (all local SQLite via PowerSync — cheap to re-run) ──
  const refresh = useCallback(() => {
    api.listParts<PartRow[]>().then(setParts).catch(console.error);
  }, []);
  useEffect(() => {
    refresh();
    api.listCategories<Cat[]>().then(setCats).catch(console.error);
  }, [refresh]);

  // Re-pull the catalogue when sync completes a cycle, so counts posted by
  // someone else's phone show up without a manual action.
  const lastSynced = status.lastSyncedAt?.getTime() ?? 0;
  useEffect(() => { if (lastSynced) refresh(); }, [lastSynced, refresh]);

  // ── search (debounced; empty query = browse) ──
  useEffect(() => {
    const term = q.trim();
    if (term.length < 3) { setHits(null); return; }
    let stale = false;
    const t = window.setTimeout(() => {
      api.searchParts<Hit[]>(term)
        .then((r) => { if (!stale) setHits(r); })
        .catch(console.error);
    }, 150);
    return () => { stale = true; window.clearTimeout(t); };
  }, [q]);

  const showToast = useCallback((t: Toast) => {
    window.clearTimeout(toastTimer.current);
    setToast(t);
    toastTimer.current = window.setTimeout(() => setToast(null), 6000);
  }, []);

  const openPart = useCallback(async (partId: number) => {
    try {
      setDetail(await api.partDetail<Detail>(partId));
      setSheetOpen(true);
      setCounterOpen(false);
    } catch (e) {
      console.error(e);
      showToast({ text: "Could not open that part.", err: true });
    }
  }, [showToast]);

  const reloadDetail = useCallback(async (partId: number) => {
    try { setDetail(await api.partDetail<Detail>(partId)); } catch (e) { console.error(e); }
    refresh();
  }, [refresh]);

  // ── posting to the ledger (the whole point of the phone) ──
  const post = useCallback(async (
    d: Detail, locationId: number, delta: number, reason: string, label: string
  ) => {
    try {
      await api.postMovement(d.id, locationId, delta, reason, makeUuid(), null);
      const undo = async () => {
        try {
          await api.postMovement(d.id, locationId, -delta, "adjustment", makeUuid(), null);
          showToast({ text: `Undone — ${d.sku} back to where it was.` });
          reloadDetail(d.id);
        } catch (e) { console.error(e); }
      };
      showToast({ text: label, undo });
      reloadDetail(d.id);
    } catch (e) {
      console.error(e);
      showToast({ text: "Post failed — nothing was booked.", err: true });
    }
  }, [showToast, reloadDetail]);

  /** "Issue 1": one unit out of the first location that has stock. */
  const issueOne = useCallback((d: Detail) => {
    const line = d.stock.find((s) => s.on_hand > 0) ?? d.stock[0];
    if (!line) { setCounterOpen(true); return; }
    post(d, line.location_id, 1, "sale", `−1 ${d.sku} issued from ${line.location_code}`);
  }, [post]);

  // ── which rows the list shows ──
  const cards: PartRow[] = useMemo(() => {
    if (hits) {
      return hits.map((h) => ({
        id: h.id, sku: h.sku, name: h.name, category_code: null,
        qty_on_hand: h.on_hand, bin: h.bin ?? null, price_cents: h.price_cents,
        image: h.thumb ?? null,
      }));
    }
    let rows = parts;
    if (chip) rows = rows.filter((p) => p.category_code === chip);
    if (tab === "shelf") {
      rows = [...rows].sort((a, b) =>
        a.bin && b.bin ? a.bin.localeCompare(b.bin, undefined, { numeric: true })
        : a.bin ? -1 : b.bin ? 1 : a.sku.localeCompare(b.sku));
    }
    return rows;
  }, [hits, parts, chip, tab]);

  const connected = status.connected;

  // ─── views ─────────────────────────────────────────────────────────────────

  const listView = (
    <div className="mb-view">
      <div className="mb-top">
        <div className="mb-brandrow">
          <img className="mb-logo" src={assetUrl(LOGO)} alt="CTP"
            onError={(e) => { e.currentTarget.style.display = "none"; }} />
          <span className="mb-vlabel">{tab === "shelf" ? "Shelf walk" : "Warehouse"}</span>
          <span className={"mb-sync" + (connected ? "" : " off")}>
            <span className="mb-dot" />{connected ? "synced" : "offline"}
          </span>
        </div>
        {tab === "find" && (
          <div className="mb-searchwrap">
            <div className="mb-sbox">
              <IcSearch />
              <input className="mb-q" value={q} inputMode="search" enterKeyHint="search"
                placeholder="SKU · part no · bin · name…"
                onChange={(e) => setQ(e.target.value)} />
              {q && <button className="mb-clr" onClick={() => setQ("")}>✕</button>}
            </div>
          </div>
        )}
      </div>

      {!hits && (
        <div className="mb-chips">
          <button className={"mb-chip" + (chip == null ? " on" : "")} onClick={() => setChip(null)}>All</button>
          {cats.map((c) => (
            <button key={c.id} className={"mb-chip" + (chip === c.code ? " on" : "")}
              title={c.name} onClick={() => setChip(chip === c.code ? null : c.code)}>
              {c.name}
            </button>
          ))}
        </div>
      )}

      <div className="mb-body">
        <div className="mb-count">
          {hits ? `${cards.length} match${cards.length === 1 ? "" : "es"}` : `${cards.length} parts`}
        </div>
        {cards.map((p) => (
          <button key={p.id} className="mb-card" onClick={() => openPart(p.id)}>
            {p.image
              ? <img className="mb-thumb" src={assetUrl(p.image)} alt="" loading="lazy" />
              : <span className="mb-thumb ph"><IcPin /></span>}
            <span className="mb-cbody">
              <span className="mb-cname">{p.name}</span>
              <span className="mb-csku mb-mono">{p.sku}</span>
              <span className="mb-cmeta">
                {p.bin && <span className="mb-bin"><IcPin />{p.bin}</span>}
                <span className={"mb-qty" + qtyClass(p.qty_on_hand)}>
                  {p.qty_on_hand <= 0 ? "out" : `${p.qty_on_hand} on hand`}
                </span>
              </span>
            </span>
          </button>
        ))}
        {cards.length === 0 && (
          <div className="mb-empty">
            <h3>{hits ? "No matches" : "Nothing synced yet"}</h3>
            <p>{hits
              ? "Try fewer characters, or a different number — search covers SKU, OEM numbers, locators, cross-references and names."
              : "Once the first sync completes the catalogue appears here by itself."}</p>
          </div>
        )}
      </div>
    </div>
  );

  const infoView = (
    <div className="mb-view">
      <div className="mb-top">
        <div className="mb-brandrow">
          <img className="mb-logo" src={assetUrl(LOGO)} alt="CTP"
            onError={(e) => { e.currentTarget.style.display = "none"; }} />
          <span className="mb-vlabel">This device</span>
          <span className={"mb-sync" + (connected ? "" : " off")}>
            <span className="mb-dot" />{connected ? "synced" : "offline"}
          </span>
        </div>
      </div>
      <div className="mb-body">
        <div className="mb-rows">
          <div className="mb-row"><span className="mb-rk">Signed in</span>
            <span className="mb-rv">{session?.user.email ?? "—"}</span></div>
          <div className="mb-row"><span className="mb-rk">Sync</span>
            <span className="mb-rv">{connected ? "connected" : "offline — writes queue locally"}</span></div>
          <div className="mb-row"><span className="mb-rk">Last synced</span>
            <span className="mb-rv">{status.lastSyncedAt ? timeAgo(status.lastSyncedAt.toISOString()) : "never"}</span></div>
          <div className="mb-row"><span className="mb-rk">Catalogue</span>
            <span className="mb-rv">{parts.length} parts</span></div>
        </div>
        <button className="mb-btn s" style={{ width: "100%" }} onClick={() => { void signOut(); }}>
          Sign out
        </button>
        <div className="mb-note">
          Counts posted here go to the <b>stock ledger</b> — nothing is ever
          overwritten. Working offline is fine: movements queue on the phone and
          post themselves when signal returns.
        </div>
      </div>
    </div>
  );

  // ─── part sheet ────────────────────────────────────────────────────────────

  const d = detail;
  const hero = d?.images.find((i) => i.is_primary)?.path ?? d?.images[0]?.path ?? null;
  const mainBin = d?.stock.find((s) => s.bin)?.bin ?? null;

  const sheet = (
    <div className={"mb-sheet" + (sheetOpen ? " open" : "")}>
      {d && (
        <>
          <div className="mb-shead">
            <button className="mb-back" onClick={() => { setSheetOpen(false); setCounterOpen(false); }}>‹</button>
            <span className="mb-shead-t">{d.category_name ?? "Part"}</span>
          </div>
          <div className="mb-sbody">
            {hero && (
              <div className="mb-hero"><img src={assetUrl(hero)} alt={d.name} /></div>
            )}
            <h1 className="mb-pname">{d.name}</h1>
            <div className="mb-psku mb-mono">
              {d.sku}{d.locator ? `  ·  ${d.locator}` : ""}
            </div>

            <div className="mb-2col">
              <div className="mb-box hi">
                <div className="mb-k">Bin</div>
                <div className="mb-v">{mainBin ?? "—"}</div>
                {d.stock.length > 1 && <div className="mb-sub">{d.stock.length} locations</div>}
              </div>
              <div className="mb-box">
                <div className="mb-k">On hand</div>
                <div className={"mb-v" + (d.total_on_hand <= 0 ? " z" : " g")}>{d.total_on_hand}</div>
                <div className="mb-sub">{fmtR(d.price_cents)} list</div>
              </div>
            </div>

            {d.diagram_image && (
              <div className="mb-dgm">
                <img src={assetUrl(d.diagram_image)} alt="Section diagram" loading="lazy" />
                <div className="mb-dgm-cap">
                  {d.diagram_item && <span className="mb-itembdg">{d.diagram_item}</span>}
                  <span>
                    <div className="mb-dgm-k">Diagram</div>
                    <div className="mb-dgm-v">{d.drawing_no ?? d.category_name ?? ""}</div>
                  </span>
                </div>
              </div>
            )}

            <div className="mb-rows">
              {d.catalogue_pn && <div className="mb-row"><span className="mb-rk">OEM No</span><span className="mb-rv mb-mono">{d.catalogue_pn}</span></div>}
              {d.inventory_pn && d.inventory_pn !== d.catalogue_pn &&
                <div className="mb-row"><span className="mb-rk">Received as</span><span className="mb-rv mb-mono">{d.inventory_pn}</span></div>}
              {d.brand && <div className="mb-row"><span className="mb-rk">Brand</span><span className="mb-rv">{d.brand}</span></div>}
              {d.stock.filter((s) => s.on_hand !== 0 || s.bin).map((s) => (
                <div className="mb-row" key={s.location_id}>
                  <span className="mb-rk">{s.location_code}</span>
                  <span className="mb-rv">{s.on_hand} on hand{s.bin ? ` · bin ${s.bin}` : ""}</span>
                </div>
              ))}
              {d.notes && <div className="mb-row"><span className="mb-rk">Notes</span><span className="mb-rv">{d.notes}</span></div>}
            </div>

            {d.ledger.length > 0 && (
              <>
                <div className="mb-count">Recent movements</div>
                <div className="mb-rows">
                  {d.ledger.slice(0, 8).map((m) => (
                    <div className="mb-row" key={m.id}>
                      <span className="mb-rk">{m.location_code}</span>
                      <span className="mb-rv">
                        <b style={{ color: m.delta > 0 ? "var(--green)" : "var(--red)" }}>
                          {m.delta > 0 ? `+${m.delta}` : m.delta}
                        </b>
                        {"  "}{m.reason} · {timeAgo(m.created_at)}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>

          <div className="mb-actions">
            <button className="mb-btn p" onClick={() => issueOne(d)}
              disabled={d.stock.length === 0}>Issue 1</button>
            <button className="mb-btn s" onClick={() => setCounterOpen(true)}
              disabled={d.stock.length === 0}>Count / receive</button>
          </div>
        </>
      )}
      {d && counterOpen && <Counter d={d} onPost={post} onClose={() => setCounterOpen(false)} />}
    </div>
  );

  return (
    <div className="mb-root">
      {tab === "info" ? infoView : listView}
      {sheet}

      {toast && (
        <div className={"mb-toast" + (toast.err ? " err" : "")}
          style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ flex: 1 }}>{toast.text}</span>
          {toast.undo && (
            <button className="mb-chip on" onClick={() => { setToast(null); toast.undo?.(); }}>
              Undo
            </button>
          )}
        </div>
      )}

      <nav className="mb-tabs">
        <button className={"mb-tab" + (tab === "find" ? " on" : "")}
          onClick={() => { setTab("find"); setSheetOpen(false); }}>
          <TabFind />Find
        </button>
        <button className={"mb-tab" + (tab === "shelf" ? " on" : "")}
          onClick={() => { setTab("shelf"); setQ(""); setSheetOpen(false); }}>
          <TabShelf />Shelf
        </button>
        <button className={"mb-tab" + (tab === "info" ? " on" : "")}
          onClick={() => { setTab("info"); setSheetOpen(false); }}>
          <TabInfo />Info
        </button>
      </nav>
    </div>
  );
}

// ─── the counter ─────────────────────────────────────────────────────────────
// Pick a location, set a quantity with the big paddles, then Receive or Issue.
// The sign is decided by the BUTTON, not the stepper — the stepper is always a
// positive "how many", which survives gloves and hurry better than a signed
// number ever did.

function Counter({ d, onPost, onClose }: {
  d: Detail;
  onPost: (d: Detail, locationId: number, delta: number, reason: string, label: string) => Promise<void>;
  onClose: () => void;
}) {
  const [locId, setLocId] = useState<number | null>(
    d.stock.find((s) => s.on_hand > 0)?.location_id ?? d.stock[0]?.location_id ?? null
  );
  const [n, setN] = useState(1);
  const loc = d.stock.find((s) => s.location_id === locId) ?? null;

  const fire = (reason: "receipt" | "sale", label: string) => {
    if (locId == null) return;
    void onPost(d, locId, n, reason, label);
    onClose();
  };

  return (
    <div className="mb-sheet open" style={{ zIndex: 55 }}>
      <div className="mb-shead">
        <button className="mb-back" onClick={onClose}>‹</button>
        <span className="mb-shead-t">Count — {d.sku}</span>
      </div>
      <div className="mb-sbody">
        <div className="mb-locrow" style={{ marginTop: 18 }}>
          {d.stock.map((s) => (
            <button key={s.location_id}
              className={"mb-chip" + (s.location_id === locId ? " on" : "")}
              onClick={() => setLocId(s.location_id)}>
              {s.location_code} · {s.on_hand}{s.bin ? ` · ${s.bin}` : ""}
            </button>
          ))}
        </div>

        <div className="mb-stepper">
          <button className="mb-sbtn" onClick={() => setN((v) => Math.max(1, v - 1))}>−</button>
          <div className="mb-sval">{n}</div>
          <button className="mb-sbtn" onClick={() => setN((v) => Math.min(999, v + 1))}>+</button>
        </div>

        {loc && (
          <div className="mb-count" style={{ textAlign: "center" }}>
            {loc.location_code} has {loc.on_hand} now → {loc.on_hand + n} after receive,{" "}
            {loc.on_hand - n} after issue
          </div>
        )}

        <div className="mb-note">
          <b>Receive</b> books stock in (a delivery, a return to shelf).{" "}
          <b>Issue</b> books it out (sold or taken for a job). Both write a
          ledger line — Undo posts the opposite line, nothing is deleted.
        </div>
      </div>
      <div className="mb-actions">
        <button className="mb-btn s" disabled={locId == null}
          onClick={() => fire("receipt", `+${n} ${d.sku} received into ${loc?.location_code ?? ""}`)}>
          + Receive {n}
        </button>
        <button className="mb-btn p" disabled={locId == null}
          onClick={() => fire("sale", `−${n} ${d.sku} issued from ${loc?.location_code ?? ""}`)}>
          − Issue {n}
        </button>
      </div>
    </div>
  );
}
