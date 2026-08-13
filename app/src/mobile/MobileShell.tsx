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

type Section = {
  id: number; code: string; name: string;
  image: string | null;    // truck locator (section lit up)
  diagram: string | null;  // OEM exploded view — fallback + shown on the section page
  parts: number;
};

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

type MyLine = {
  id: number; qty: number; unit_price_minor: number | null;
  sku: string; name: string; catalogue_pn: string | null;
};
type StaffLine = {
  id: number; part_id: number; qty: number; unit_price_minor: number;
  sku: string; name: string; catalogue_pn: string | null;
};
type StaffOrder = {
  id: number; number: string; status: string;
  customer_name: string; customer_contact: string | null;
  notes: string | null; created_at: string;
  client_response: string | null; client_responded_at: string | null;
  unpriced: number; total_minor: number;
  stage: "to_price" | "with_customer" | "to_pick" | string;
  lines: StaffLine[];
};

type MyRequest = {
  id: number; number: string; status: string; currency: string;
  notes: string | null; created_at: string;
  client_response: string | null; client_responded_at: string | null;
  priced: boolean; total_minor: number; lines: MyLine[];
};

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
//
// It ships as TWO layers on one shared canvas — the wordmark + stripes, and
// the truck alone — so the truck can drive off and back without the rest of
// the logo moving. Same dimensions, stacked, so there is no alignment maths:
// see .mb-brand in mobile.css.
const LOGO_BODY = "assets/brand/ctp_logo_body_v1.png";
const LOGO_TRUCK = "assets/brand/ctp_truck_v1.png";

/** The logo, with a truck that occasionally goes for a drive. */
function Brand() {
  return (
    <span className="mb-brand" aria-label="China Truck Parts">
      <img className="mb-brand-body" src={assetUrl(LOGO_BODY)} alt=""
        onError={(e) => { e.currentTarget.style.display = "none"; }} />
      <img className="mb-brand-truck" src={assetUrl(LOGO_TRUCK)} alt="" aria-hidden="true"
        onError={(e) => { e.currentTarget.style.display = "none"; }} />
    </span>
  );
}

/**
 * The `user_role` claim out of the access token, or null.
 *
 * This is the claim the SYNC STREAMS gate on (migration 0019 + the Custom
 * Access Token hook), and it is not the same thing as the role AuthProvider
 * reads from the app_user table — that one is a database read this device
 * makes, while this one is what the token actually carries. When they
 * disagree, sync follows the token. Printing it in Info is the only way to
 * see, from the device, whether the hook is live and the session is new
 * enough to have picked it up.
 *
 * Read-only display. Nothing is authorised on the strength of it: a JWT is
 * signed, but this decode does NOT verify that signature, so treating it as
 * proof of anything would be trusting a string the client could edit.
 */
function tokenRole(accessToken: string | undefined): string | null {
  if (!accessToken) return null;
  try {
    const body = accessToken.split(".")[1];
    if (!body) return null;
    const json = atob(body.replace(/-/g, "+").replace(/_/g, "/"));
    const claim = JSON.parse(json)?.user_role;
    return typeof claim === "string" ? claim : null;
  } catch {
    return null;
  }
}

// ─── icons (inline so the shell has zero icon deps) ──────────────────────────

const IcSearch = () => (
  <svg viewBox="0 0 24 24"><path d="M15.5 14h-.79l-.28-.27a6.5 6.5 0 1 0-.7.7l.27.28v.79l5 4.99L20.49 19zm-6 0A4.5 4.5 0 1 1 14 9.5 4.5 4.5 0 0 1 9.5 14z"/></svg>
);
const IcPin = () => (
  <svg viewBox="0 0 24 24"><path d="M12 2a7 7 0 0 0-7 7c0 5.25 7 13 7 13s7-7.75 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 14.5 9 2.5 2.5 0 0 1 12 11.5z"/></svg>
);
const TabHome = () => (
  <svg viewBox="0 0 24 24"><path d="M3 10.5 12 3l9 7.5M5 9.5V21h14V9.5M9.5 21v-6h5v6"/></svg>
);
const TabFind = () => (
  <svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/></svg>
);
const TabShelf = () => (
  <svg viewBox="0 0 24 24"><path d="M3 4h18M3 12h18M3 20h18M6 4v8M14 4v8M10 12v8M17 12v8"/></svg>
);
const TabCart = () => (
  <svg viewBox="0 0 24 24"><path d="M4 5h2l2.2 9.5a2 2 0 0 0 2 1.5h6.4a2 2 0 0 0 2-1.5L20.5 8H7"/><circle cx="10" cy="20" r="1"/><circle cx="18" cy="20" r="1"/></svg>
);
const TabInfo = () => (
  <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8v.01"/></svg>
);

// ─── the shell ───────────────────────────────────────────────────────────────

export default function MobileShell() {
  const status = useStatus();
  const { session, signOut } = useAuth();

  const [tab, setTab] = useState<"home" | "find" | "shelf" | "cart" | "info">("home");
  const [parts, setParts] = useState<PartRow[]>([]);
  const [cats, setCats] = useState<Cat[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null); // null = not searching
  const [chip, setChip] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [counterOpen, setCounterOpen] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [viewer, setViewer] = useState<{ items: { path: string; label: string }[]; idx: number } | null>(null);
  const [cart, setCart] = useState<{ id: number; sku: string; name: string; qty: number }[]>([]);
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [audit, setAudit] = useState<{ table: string; rows: number }[] | null>(null);
  const [mine, setMine] = useState<MyRequest[] | null>(null);
  const [answering, setAnswering] = useState<number | null>(null);
  const [orders, setOrders] = useState<StaffOrder[] | null>(null);
  const [openOrder, setOpenOrder] = useState<number | null>(null);
  const [draftPrices, setDraftPrices] = useState<Record<number, string>>({});
  const [savingOrder, setSavingOrder] = useState(false);
  const toastTimer = useRef<number | undefined>(undefined);

  // ── who is this? ──
  //
  // The TOKEN's role, not the app_user read, because the token is what decides
  // which sync stream fed this device — so it is also the honest answer to
  // "what is this person allowed to see?". A customer's phone has no prices,
  // no bins and no stock movements in its database at all; the UI below hides
  // those fields to match, but hiding them is cosmetic. The stream is the
  // control. Anything not gated there is not protected by this.
  const role = tokenRole(session?.access_token);
  const isClient = role === "customer";

  // ── data loads (all local SQLite via PowerSync — cheap to re-run) ──
  const refresh = useCallback(() => {
    api.listParts<PartRow[]>().then(setParts).catch(console.error);
    api.listSections<Section[]>().then(setSections).catch(console.error);
  }, []);
  useEffect(() => {
    refresh();
    api.listCategories<Cat[]>().then(setCats).catch(console.error);
    api.listSections<Section[]>().then(setSections).catch(console.error);
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

  // ── the request basket (clients only) ──
  const inCart = (id: number) => cart.find((c) => c.id === id)?.qty ?? 0;
  const addToCart = (d: Detail, n = 1) =>
    setCart((c) => {
      const at = c.findIndex((x) => x.id === d.id);
      if (at < 0) return [...c, { id: d.id, sku: d.sku, name: d.name, qty: Math.max(1, n) }];
      const next = [...c];
      const qty = next[at].qty + n;
      if (qty <= 0) return next.filter((x) => x.id !== d.id);
      next[at] = { ...next[at], qty: Math.min(999, qty) };
      return next;
    });
  const setCartQty = (id: number, qty: number) =>
    setCart((c) => (qty <= 0 ? c.filter((x) => x.id !== id)
      : c.map((x) => (x.id === id ? { ...x, qty: Math.min(999, qty) } : x))));

  const loadMine = useCallback(() => {
    if (!isClient) return;
    api.myRequests<MyRequest[]>().then(setMine).catch(console.error);
  }, [isClient]);
  // Refresh when sync lands: the moment staff price the quote, it appears.
  useEffect(() => { if (isClient) loadMine(); }, [isClient, lastSynced, loadMine]);

  // ── staff order desk ──
  const loadOrders = useCallback(() => {
    if (isClient) return;
    api.staffOrders<StaffOrder[]>().then(setOrders).catch(console.error);
  }, [isClient]);
  useEffect(() => { if (!isClient) loadOrders(); }, [isClient, lastSynced, loadOrders]);

  const savePrices = useCallback(async (o: StaffOrder) => {
    setSavingOrder(true);
    try {
      const lines = o.lines
        .map((l) => {
          const typed = draftPrices[l.id];
          const rand = typed == null || typed === "" ? l.unit_price_minor / 100 : Number(typed);
          return { line_id: l.id, unit_price_minor: Math.round(rand * 100) };
        })
        .filter((l) => l.unit_price_minor > 0);
      const res = await api.priceQuote<{ unpriced_left?: number; total_minor?: number }>(o.id, lines);
      const left = Number(res?.unpriced_left ?? 0);
      showToast({ text: left > 0
        ? `Saved — ${left} line${left === 1 ? "" : "s"} still without a price, so ${o.number} can't be accepted yet.`
        : `${o.number} priced: ${fmtR(Number(res?.total_minor ?? 0))}. It's on their phone now.` });
      setDraftPrices({});
      loadOrders();
    } catch (e) {
      console.error(e);
      const msg = e instanceof Error ? e.message.replace(/^\[CTP web\] could not save prices: /, "") : "Could not save.";
      showToast({ text: msg, err: true });
    } finally {
      setSavingOrder(false);
    }
  }, [draftPrices, showToast, loadOrders]);

  const fillList = useCallback(async (o: StaffOrder) => {
    setSavingOrder(true);
    try {
      const res = await api.fillQuoteFromList<{ unpriced_left?: number; total_minor?: number }>(o.id);
      const left = Number(res?.unpriced_left ?? 0);
      showToast({ text: left > 0
        ? `Filled from list — ${left} part${left === 1 ? " has" : "s have"} no list price, fill by hand.`
        : `Filled from list: ${fmtR(Number(res?.total_minor ?? 0))}.` });
      setDraftPrices({});
      loadOrders();
    } catch (e) {
      console.error(e);
      showToast({ text: e instanceof Error ? e.message : "Could not fill.", err: true });
    } finally {
      setSavingOrder(false);
    }
  }, [showToast, loadOrders]);

  const answerQuote = useCallback(async (r: MyRequest, accept: boolean) => {
    setAnswering(r.id);
    try {
      await api.respondToQuote(r.id, accept);
      showToast({ text: accept
        ? `${r.number} accepted — we'll get it ready.`
        : `${r.number} declined.` });
      loadMine();
    } catch (e) {
      console.error(e);
      const msg = e instanceof Error
        ? e.message.replace(/^\[CTP web\] could not send your answer: /, "")
        : "Could not send your answer.";
      showToast({ text: msg, err: true });
    } finally {
      setAnswering(null);
    }
  }, [showToast, loadMine]);

  const submitRequest = useCallback(async () => {
    if (cart.length === 0 || sending) return;
    setSending(true);
    try {
      const res = await api.requestParts<{ number?: string; lines?: number }>(
        cart.map((c) => ({ part_id: c.id, qty: c.qty })),
        note.trim() || null
      );
      setCart([]);
      setNote("");
      showToast({ text: `Request ${res?.number ?? "sent"} — we'll come back to you with prices.` });
      loadMine();
    } catch (e) {
      console.error(e);
      // The server refuses for readable reasons (login not linked to a
      // customer, unknown part). Show them: "something went wrong" would send
      // the person round in circles.
      const msg = e instanceof Error ? e.message.replace(/^\[CTP web\] request failed: /, "") : "Could not send.";
      showToast({ text: msg, err: true });
    } finally {
      setSending(false);
    }
  }, [cart, note, sending, showToast]);

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

  // The front page: every section of the truck as a big card — the SEC
  // exploded-view drawing IS the picture of "this part of the truck" — plus
  // one search box and an All-parts card. Tap a section → the list, filtered.
  const openSection = (code: string | null) => {
    setChip(code);
    setQ("");
    setTab("find");
  };

  const homeView = (
    <div className="mb-view">
      <div className="mb-top">
        <div className="mb-brandrow">
          <Brand />
          <span className="mb-vlabel">Catalogue</span>
          <span className={"mb-sync" + (connected ? "" : " off")}>
            <span className="mb-dot" />{connected ? "synced" : "offline"}
          </span>
        </div>
        <div className="mb-searchwrap">
          <div className="mb-sbox">
            <IcSearch />
            <input className="mb-q" value={q} inputMode="search" enterKeyHint="search"
              placeholder="Search everything…"
              onFocus={() => setTab("find")}
              onChange={(e) => { setQ(e.target.value); setTab("find"); }} />
          </div>
        </div>
      </div>
      <div className="mb-body">
        <button className="mb-secall" onClick={() => openSection(null)}>
          <span className="mb-secall-t">All parts</span>
          <span className="mb-secall-n">{parts.length} in the catalogue →</span>
        </button>
        <div className="mb-secgrid">
        {sections.filter((s) => s.parts > 0).map((s) => (
          <button key={s.id} className="mb-seccard" onClick={() => openSection(s.code)}>
            <img className="mb-secimg" src={assetUrl(s.image)} alt="" loading="lazy"
              onError={(e) => {
                // locator missing (new category, nothing generated yet) → the
                // OEM drawing still says more than an empty box does
                const el = e.currentTarget;
                if (s.diagram && !el.dataset.fell) {
                  el.dataset.fell = "1";
                  el.classList.add("dgm");   // white plate: the OEM art is black-on-white
                  el.src = assetUrl(s.diagram);
                } else el.style.visibility = "hidden";
              }} />
            <span className="mb-secbar">
              <span className="mb-secname">{s.name}</span>
              <span className="mb-seccount">{s.parts} parts</span>
            </span>
          </button>
        ))}
        </div>
      </div>
    </div>
  );

  const listView = (
    <div className="mb-view">
      <div className="mb-top">
        <div className="mb-brandrow">
          <Brand />
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
        {/* Came in from a section card: lead with that section's exploded view,
            tappable into the zoom viewer. This is the "and then it breaks
            down" half of the home page. */}
        {!hits && chip && (() => {
          const s = sections.find((x) => x.code === chip);
          if (!s?.diagram) return null;
          return (
            <div className="mb-dgm" role="button" style={{ marginTop: 4 }}
              onClick={() => setViewer({ items: [{ path: s.diagram!, label: s.name }], idx: 0 })}>
              <img src={assetUrl(s.diagram)} alt={s.name} loading="lazy" />
              <span className="mb-zoomtag">⤢</span>
              <div className="mb-dgm-cap">
                <span>
                  <div className="mb-dgm-k">Section</div>
                  <div className="mb-dgm-v">{s.name}</div>
                </span>
              </div>
            </div>
          );
        })()}
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
              {/* A client's device holds no bins and no stock movements, so
                  these would not merely be private — they would be WRONG
                  (every count would read zero). Omitted, not blanked. */}
              {!isClient && (
                <span className="mb-cmeta">
                  {p.bin && <span className="mb-bin"><IcPin />{p.bin}</span>}
                  <span className={"mb-qty" + qtyClass(p.qty_on_hand)}>
                    {p.qty_on_hand <= 0 ? "out" : `${p.qty_on_hand} on hand`}
                  </span>
                </span>
              )}
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
          <Brand />
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
          <div className="mb-row"><span className="mb-rk">Access level</span>
            <span className="mb-rv">
              {tokenRole(session?.access_token)
                ?? <span style={{ color: "var(--warn)" }}>not in your token</span>}
            </span></div>
          <div className="mb-row"><span className="mb-rk">Sync</span>
            <span className="mb-rv">{connected ? "connected" : "offline — writes queue locally"}</span></div>
          <div className="mb-row"><span className="mb-rk">Last synced</span>
            <span className="mb-rv">{status.lastSyncedAt ? timeAgo(status.lastSyncedAt.toISOString()) : "never"}</span></div>
          <div className="mb-row"><span className="mb-rk">Catalogue</span>
            <span className="mb-rv">{parts.length} parts</span></div>
        </div>
        {/* What this device actually holds. The sync rules are the only thing
            keeping cost and margin off a customer's phone, and a rule that
            syncs nothing is indistinguishable from a rule that was never
            written — except from here. */}
        <div className="mb-count">Data on this device</div>
        {audit === null ? (
          <button className="mb-btn s" style={{ width: "100%" }}
            onClick={() => { api.deviceAudit<{ table: string; rows: number }[]>()
              .then(setAudit).catch((e) => { console.error(e); setAudit([]); }); }}>
            Check what synced
          </button>
        ) : (
          <div className="mb-rows">
            {audit.map((a) => {
              // On a client device these must be zero. Anything else is a leak,
              // so it is coloured like one rather than left to be noticed.
              const shouldBeEmpty = isClient && [
                "part_cost", "price", "price_tier", "stock_policy", "stock_movement",
                "location", "customer", "sales_order", "sales_line", "part_alias",
              ].includes(a.table);
              const bad = shouldBeEmpty && a.rows > 0;
              return (
                <div className="mb-row" key={a.table}>
                  <span className="mb-rk mb-mono" style={{ flex: 1 }}>{a.table}</span>
                  <span className="mb-rv" style={{
                    color: bad ? "var(--red)" : a.rows > 0 ? "var(--green)" : "var(--dimmer)",
                  }}>
                    {a.rows < 0 ? "not synced" : a.rows}{bad ? "  ⚠ should be 0" : ""}
                  </span>
                </div>
              );
            })}
          </div>
        )}
        <button className="mb-btn s" style={{ width: "100%", marginTop: 14 }}
          onClick={() => { void signOut(); }}>
          Sign out
        </button>
        <div className="mb-note">
          Counts posted here go to the <b>stock ledger</b> — nothing is ever
          overwritten. Working offline is fine: movements queue on the phone and
          post themselves when signal returns.
        </div>
        {!tokenRole(session?.access_token) && (
          <div className="mb-note">
            <b>Access level missing.</b> Your sign-in token doesn't carry a role
            yet, which is what decides the data this device is allowed to hold.
            Until the access-token hook is switched on, every signed-in device
            receives everything. Sign out and back in after it is enabled.
          </div>
        )}
      </div>
    </div>
  );

  // ─── staff: the order desk ─────────────────────────────────────────────────
  const STAGES: { key: string; label: string; hint: string }[] = [
    { key: "to_price",      label: "Needs pricing",   hint: "came in from a customer" },
    { key: "with_customer", label: "With the customer", hint: "quoted, waiting on their answer" },
    { key: "to_pick",       label: "Ready to pick",   hint: "accepted — pull the stock" },
  ];

  const ordersView = (
    <div className="mb-view">
      <div className="mb-top">
        <div className="mb-brandrow">
          <Brand />
          <span className="mb-vlabel">Orders</span>
          <span className={"mb-sync" + (connected ? "" : " off")}>
            <span className="mb-dot" />{connected ? "synced" : "offline"}
          </span>
        </div>
      </div>
      <div className="mb-body">
        {orders === null && <div className="mb-count">Loading…</div>}
        {orders && STAGES.map((s) => {
          const inStage = orders.filter((o) => o.stage === s.key);
          if (inStage.length === 0) return null;
          return (
            <div key={s.key}>
              <div className="mb-count">{s.label} · {inStage.length} — {s.hint}</div>
              {inStage.map((o) => {
                const open = openOrder === o.id;
                return (
                  <div className="mb-rows" key={o.id} style={{ marginBottom: 12 }}>
                    <button className="mb-row" style={{ width: "100%", background: "none", border: 0, textAlign: "left" }}
                      onClick={() => { setOpenOrder(open ? null : o.id); setDraftPrices({}); }}>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <div className="mb-cname">{o.customer_name}</div>
                        <div className="mb-csku mb-mono">{o.number} · {o.lines.length} line{o.lines.length === 1 ? "" : "s"}</div>
                      </span>
                      <span className="mb-rv">
                        {o.total_minor > 0 ? fmtR(o.total_minor) : <span style={{ color: "var(--warn)" }}>no price</span>}
                      </span>
                    </button>

                    {open && (
                      <>
                        {o.notes && (
                          <div className="mb-row">
                            <span className="mb-rk">Their note</span>
                            <span className="mb-rv">{o.notes}</span>
                          </div>
                        )}
                        {o.lines.map((l) => (
                          <div className="mb-row" key={l.id}>
                            <span style={{ flex: 1, minWidth: 0 }}>
                              <div className="mb-cname">{l.qty} × {l.name}</div>
                              <div className="mb-csku mb-mono">{l.catalogue_pn ?? l.sku}</div>
                            </span>
                            {o.stage === "to_price" ? (
                              <input className="mb-price-in" inputMode="decimal" placeholder="0.00"
                                value={draftPrices[l.id] ?? (l.unit_price_minor > 0 ? String(l.unit_price_minor / 100) : "")}
                                onChange={(e) => setDraftPrices((d) => ({ ...d, [l.id]: e.target.value }))} />
                            ) : (
                              <span className="mb-rv">{fmtR(l.unit_price_minor * l.qty)}</span>
                            )}
                          </div>
                        ))}
                        {o.stage === "to_price" && (
                          <div className="mb-row" style={{ gap: 10 }}>
                            <button className="mb-btn s" style={{ height: 46 }} disabled={savingOrder}
                              onClick={() => { void fillList(o); }}>Fill from list</button>
                            <button className="mb-btn p" style={{ height: 46 }} disabled={savingOrder}
                              onClick={() => { void savePrices(o); }}>
                              {savingOrder ? "Saving…" : "Send quote"}
                            </button>
                          </div>
                        )}
                        {o.stage === "with_customer" && (
                          <div className="mb-row">
                            <span className="mb-rk">Waiting</span>
                            <span className="mb-rv">sent {timeAgo(o.created_at)} · they see it on their phone</span>
                          </div>
                        )}
                        {o.stage === "to_pick" && (
                          <div className="mb-row">
                            <span className="mb-rk">Accepted</span>
                            <span className="mb-rv" style={{ color: "var(--green)" }}>
                              {o.client_responded_at ? timeAgo(o.client_responded_at) : "by the customer"}
                            </span>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
        {orders && orders.length === 0 && (
          <div className="mb-empty">
            <h3>No orders yet</h3>
            <p>Customer requests land here the moment they're sent.</p>
          </div>
        )}
        <div className="mb-note">
          Pricing here writes to the cloud, so the customer sees it. The desktop
          app keeps its own separate database — pricing there does <b>not</b>
          reach anyone's phone.
        </div>
      </div>
    </div>
  );

  const cartView = (
    <div className="mb-view">
      <div className="mb-top">
        <div className="mb-brandrow">
          <Brand />
          <span className="mb-vlabel">Your request</span>
          <span className={"mb-sync" + (connected ? "" : " off")}>
            <span className="mb-dot" />{connected ? "online" : "offline"}
          </span>
        </div>
      </div>
      <div className="mb-body">
        {cart.length === 0 ? (
          // The full pitch only when there is nothing else on this screen —
          // with quotes listed below it, a big "nothing here" panel reads as
          // if their history had vanished.
          (mine && mine.length > 0) ? (
            <div className="mb-count">Nothing new in your basket</div>
          ) : (
            <div className="mb-empty">
              <h3>Nothing in your request yet</h3>
              <p>Find the parts you need and tap <b>Add to request</b>. Send the
                lot in one go and we'll come back to you with prices and
                availability.</p>
            </div>
          )
        ) : (
          <>
            <div className="mb-count">{cart.length} part{cart.length === 1 ? "" : "s"}</div>
            <div className="mb-rows">
              {cart.map((c) => (
                <div className="mb-row" key={c.id}>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <div className="mb-cname">{c.name}</div>
                    <div className="mb-csku mb-mono">{c.sku}</div>
                  </span>
                  <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <button className="mb-chip" onClick={() => setCartQty(c.id, c.qty - 1)}>−</button>
                    <b style={{ minWidth: 24, textAlign: "center" }}>{c.qty}</b>
                    <button className="mb-chip" onClick={() => setCartQty(c.id, c.qty + 1)}>+</button>
                  </span>
                </div>
              ))}
            </div>
            <textarea className="mb-note-in" rows={3} value={note} maxLength={2000}
              placeholder="Anything else we should know? Vehicle, urgency, delivery…"
              onChange={(e) => setNote(e.target.value)} />
            <div className="mb-note">
              We'll price this and come back to you. Nothing is ordered or
              charged by sending it.
            </div>
          </>
        )}

        {/* Everything they have already sent, and any quote waiting on them. */}
        {mine && mine.length > 0 && (
          <>
            <div className="mb-count" style={{ marginTop: 22 }}>Sent to us</div>
            {mine.map((r) => {
              const awaiting = r.status === "quote" && r.priced;
              return (
                <div className="mb-rows" key={r.id} style={{ marginBottom: 12 }}>
                  <div className="mb-row">
                    <span className="mb-rk mb-mono" style={{ flex: "0 0 auto" }}>{r.number}</span>
                    <span className="mb-rv">
                      {awaiting ? <b style={{ color: "var(--amber)" }}>Quote ready</b>
                        : r.status === "quote" ? "With us for pricing"
                        : r.status === "confirmed" ? <b style={{ color: "var(--green)" }}>Accepted</b>
                        : r.status === "cancelled" ? "Declined"
                        : r.status === "fulfilled" ? "Ready for collection"
                        : r.status === "invoiced" ? "Invoiced"
                        : r.status}
                    </span>
                  </div>
                  {r.lines.map((l) => (
                    <div className="mb-row" key={l.id}>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <div className="mb-cname">{l.qty} × {l.name}</div>
                        <div className="mb-csku mb-mono">{l.catalogue_pn ?? l.sku}</div>
                      </span>
                      {/* Only ever their OWN quoted price — never the price list */}
                      {(l.unit_price_minor ?? 0) > 0 && (
                        <span className="mb-rv">{fmtR((l.unit_price_minor ?? 0) * l.qty)}</span>
                      )}
                    </div>
                  ))}
                  {r.priced && (
                    <div className="mb-row">
                      <span className="mb-rk">Total</span>
                      <span className="mb-rv"><b>{fmtR(r.total_minor)}</b> excl VAT</span>
                    </div>
                  )}
                  {awaiting && (
                    <div className="mb-row" style={{ gap: 10 }}>
                      <button className="mb-btn s" style={{ height: 46 }}
                        disabled={answering === r.id}
                        onClick={() => { void answerQuote(r, false); }}>Decline</button>
                      <button className="mb-btn p" style={{ height: 46 }}
                        disabled={answering === r.id}
                        onClick={() => { void answerQuote(r, true); }}>
                        {answering === r.id ? "Sending…" : "Accept quote"}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </>
        )}
      </div>
      {cart.length > 0 && (
        <div className="mb-actions">
          <button className="mb-btn s" style={{ flex: "0 0 96px" }}
            onClick={() => setCart([])} disabled={sending}>Clear</button>
          <button className="mb-btn p" onClick={() => { void submitRequest(); }} disabled={sending}>
            {sending ? "Sending…" : `Send request (${cart.length})`}
          </button>
        </div>
      )}
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
              <div className="mb-hero" role="button"
                onClick={() => setViewer({
                  items: d.images.map((i, n) => ({ path: i.path, label: `${d.sku} · photo ${n + 1} of ${d.images.length}` })),
                  idx: Math.max(0, d.images.findIndex((i) => i.path === hero)),
                })}>
                <img src={assetUrl(hero)} alt={d.name} />
                <span className="mb-zoomtag">⤢</span>
              </div>
            )}
            <h1 className="mb-pname">{d.name}</h1>
            <div className="mb-psku mb-mono">
              {d.sku}{d.locator ? `  ·  ${d.locator}` : ""}
            </div>

            {isClient ? (
              <div className="mb-box">
                <div className="mb-k">Part number</div>
                <div className="mb-v mono-pn">{d.catalogue_pn ?? d.sku}</div>
                <div className="mb-sub">Add it to your request and we'll quote you</div>
              </div>
            ) : (
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
            )}

            {d.diagram_image && (
              <div className="mb-dgm" role="button"
                onClick={() => setViewer({
                  items: [{ path: d.diagram_image!, label: `${d.drawing_no ?? d.category_name ?? "Diagram"}${d.diagram_item ? ` · item ${d.diagram_item}` : ""}` }],
                  idx: 0,
                })}>
                <img src={assetUrl(d.diagram_image)} alt="Section diagram" loading="lazy" />
                <span className="mb-zoomtag">⤢</span>
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
              {!isClient && d.stock.filter((s) => s.on_hand !== 0 || s.bin).map((s) => (
                <div className="mb-row" key={s.location_id}>
                  <span className="mb-rk">{s.location_code}</span>
                  <span className="mb-rv">{s.on_hand} on hand{s.bin ? ` · bin ${s.bin}` : ""}</span>
                </div>
              ))}
              {!isClient && d.notes && <div className="mb-row"><span className="mb-rk">Notes</span><span className="mb-rv">{d.notes}</span></div>}
            </div>

            {!isClient && d.ledger.length > 0 && (
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
            {isClient ? (
              inCart(d.id) > 0 ? (
                <>
                  <button className="mb-btn s" onClick={() => addToCart(d, -1)}>−</button>
                  <button className="mb-btn s" style={{ flex: "0 0 96px" }}
                    onClick={() => setTab("cart")}>{inCart(d.id)} in list</button>
                  <button className="mb-btn p" onClick={() => addToCart(d, 1)}>+</button>
                </>
              ) : (
                <button className="mb-btn p" onClick={() => addToCart(d, 1)}>Add to request</button>
              )
            ) : (
              <>
                <button className="mb-btn p" onClick={() => issueOne(d)}
                  disabled={d.stock.length === 0}>Issue 1</button>
                <button className="mb-btn s" onClick={() => setCounterOpen(true)}
                  disabled={d.stock.length === 0}>Count / receive</button>
              </>
            )}
          </div>
        </>
      )}
      {d && counterOpen && <Counter d={d} onPost={post} onClose={() => setCounterOpen(false)} />}
    </div>
  );

  return (
    <div className="mb-root">
      {tab === "home" ? homeView
        : tab === "info" ? infoView
        : tab === "cart" ? (isClient ? cartView : ordersView)
        : listView}
      {sheet}
      {viewer && (
        <Lightbox items={viewer.items} start={viewer.idx} onClose={() => setViewer(null)} />
      )}

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
        <button className={"mb-tab" + (tab === "home" ? " on" : "")}
          onClick={() => { setTab("home"); setQ(""); setChip(null); setSheetOpen(false); }}>
          <TabHome />Home
        </button>
        <button className={"mb-tab" + (tab === "find" ? " on" : "")}
          onClick={() => { setTab("find"); setSheetOpen(false); }}>
          <TabFind />Find
        </button>
        {isClient ? (
          <button className={"mb-tab" + (tab === "cart" ? " on" : "")}
            onClick={() => { setTab("cart"); setSheetOpen(false); }}>
            <span className="mb-tabwrap">
              <TabCart />
              {cart.length > 0 && <span className="mb-tabbadge">{cart.length}</span>}
            </span>
            Request
          </button>
        ) : (
          <>
            <button className={"mb-tab" + (tab === "shelf" ? " on" : "")}
              onClick={() => { setTab("shelf"); setQ(""); setSheetOpen(false); }}>
              <TabShelf />Shelf
            </button>
            <button className={"mb-tab" + (tab === "cart" ? " on" : "")}
              onClick={() => { setTab("cart"); setSheetOpen(false); }}>
              <span className="mb-tabwrap">
                <TabCart />
                {/* Only what is waiting on US — a badge for someone else's
                    homework is noise you learn to ignore. */}
                {(() => {
                  const n = (orders ?? []).filter((o) => o.stage === "to_price" || o.stage === "to_pick").length;
                  return n > 0 ? <span className="mb-tabbadge">{n}</span> : null;
                })()}
              </span>
              Orders
            </button>
          </>
        )}
        <button className={"mb-tab" + (tab === "info" ? " on" : "")}
          onClick={() => { setTab("info"); setSheetOpen(false); }}>
          <TabInfo />Info
        </button>
      </nav>
    </div>
  );
}

// ─── the lightbox ────────────────────────────────────────────────────────────
// Fullscreen viewer for photos and diagrams. Hand-rolled gestures, no deps:
//   pinch = zoom (1×–6×) · one finger = pan when zoomed, swipe to change photo
//   at 1× · double-tap = zoom in on that spot / back out · mouse wheel on PC.
//
// The transform model: the image sits centred in the stage with
// `translate(x,y) scale(s)` (origin centre), so a screen point q and an image
// point c relate as q = c·s + T. Every gesture below is just solving that for
// T while holding some c fixed — the point under your fingers stays under
// your fingers.

function Lightbox({ items, start, onClose }: {
  items: { path: string; label: string }[];
  start: number;
  onClose: () => void;
}) {
  const [idx, setIdx] = useState(Math.min(Math.max(start, 0), items.length - 1));
  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const t = useRef({ s: 1, x: 0, y: 0 });
  const ptrs = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ d0: number; s0: number; cx: number; cy: number } | null>(null);
  const drag = useRef<{ px: number; py: number; x0: number; y0: number; moved: boolean } | null>(null);
  const lastTap = useRef(0);
  const [zoomed, setZoomed] = useState(false);

  const apply = (animate = false) => {
    const el = imgRef.current;
    if (!el) return;
    el.style.transition = animate ? "transform .18s ease-out" : "none";
    el.style.transform = `translate(${t.current.x}px, ${t.current.y}px) scale(${t.current.s})`;
    setZoomed(t.current.s > 1.01);
  };
  const resetView = (animate = false) => { t.current = { s: 1, x: 0, y: 0 }; apply(animate); };

  /** Pointer position relative to the stage centre. */
  const rel = (e: { clientX: number; clientY: number }) => {
    const r = stageRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left - r.width / 2, y: e.clientY - r.top - r.height / 2 };
  };

  /** Keep the image from being panned out of reach. */
  const clampPan = (animate: boolean) => {
    const img = imgRef.current, stage = stageRef.current;
    if (!img || !stage) return;
    const mx = Math.max(0, (img.offsetWidth * t.current.s - stage.clientWidth) / 2);
    const my = Math.max(0, (img.offsetHeight * t.current.s - stage.clientHeight) / 2);
    t.current.x = Math.min(mx, Math.max(-mx, t.current.x));
    t.current.y = Math.min(my, Math.max(-my, t.current.y));
    apply(animate);
  };

  const zoomAt = (p: { x: number; y: number }, sNew: number) => {
    const { s, x, y } = t.current;
    const c = { x: (p.x - x) / s, y: (p.y - y) / s };
    t.current = { s: sNew, x: p.x - c.x * sNew, y: p.y - c.y * sNew };
    if (sNew <= 1.01) t.current = { s: 1, x: 0, y: 0 };
    clampPan(true);
  };

  const onDown = (e: React.PointerEvent) => {
    stageRef.current?.setPointerCapture(e.pointerId);
    ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.current.size === 2) {
      const [a, b] = [...ptrs.current.values()];
      const d0 = Math.hypot(a.x - b.x, a.y - b.y);
      const m = rel({ clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2 });
      const { s, x, y } = t.current;
      pinch.current = { d0: Math.max(d0, 1), s0: s, cx: (m.x - x) / s, cy: (m.y - y) / s };
      drag.current = null;
    } else if (ptrs.current.size === 1) {
      const now = Date.now();
      if (now - lastTap.current < 300) {
        // double-tap: zoom into that spot, or all the way back out
        zoomAt(rel(e), t.current.s > 1.01 ? 1 : 2.6);
        lastTap.current = 0;
        return;
      }
      lastTap.current = now;
      drag.current = { px: e.clientX, py: e.clientY, x0: t.current.x, y0: t.current.y, moved: false };
    }
  };

  const onMove = (e: React.PointerEvent) => {
    if (!ptrs.current.has(e.pointerId)) return;
    ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch.current && ptrs.current.size >= 2) {
      const [a, b] = [...ptrs.current.values()];
      const d = Math.max(Math.hypot(a.x - b.x, a.y - b.y), 1);
      const m = rel({ clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2 });
      const s = Math.min(6, Math.max(1, pinch.current.s0 * (d / pinch.current.d0)));
      t.current = { s, x: m.x - pinch.current.cx * s, y: m.y - pinch.current.cy * s };
      apply();
    } else if (drag.current) {
      const dx = e.clientX - drag.current.px, dy = e.clientY - drag.current.py;
      if (Math.abs(dx) + Math.abs(dy) > 6) drag.current.moved = true;
      if (t.current.s > 1.01) {
        t.current.x = drag.current.x0 + dx;
        t.current.y = drag.current.y0 + dy;
        apply();
      }
    }
  };

  const onUp = (e: React.PointerEvent) => {
    const wasDrag = drag.current;
    ptrs.current.delete(e.pointerId);
    if (ptrs.current.size < 2) pinch.current = null;
    if (ptrs.current.size === 0) {
      if (t.current.s > 1.01) {
        clampPan(true);
      } else if (wasDrag && wasDrag.moved && items.length > 1) {
        // swipe left/right at 1× flips through the photos
        const dx = e.clientX - wasDrag.px;
        if (dx < -60 && idx < items.length - 1) { setIdx(idx + 1); resetView(); }
        else if (dx > 60 && idx > 0) { setIdx(idx - 1); resetView(); }
      }
      drag.current = null;
    }
  };

  const onWheel = (e: React.WheelEvent) => {
    zoomAt(rel(e), Math.min(6, Math.max(1, t.current.s * (e.deltaY < 0 ? 1.18 : 0.85))));
  };

  const item = items[idx];
  return (
    <div className="mb-lb">
      <div className="mb-lb-head">
        <button className="mb-back" onClick={onClose}>✕</button>
        <span className="mb-lb-cap">{item.label}</span>
        {zoomed && <button className="mb-chip" onClick={() => resetView(true)}>Fit</button>}
      </div>
      <div ref={stageRef} className="mb-lb-stage"
        onPointerDown={onDown} onPointerMove={onMove}
        onPointerUp={onUp} onPointerCancel={onUp} onWheel={onWheel}>
        <img ref={imgRef} className="mb-lb-img" src={assetUrl(item.path)} alt={item.label}
          draggable={false} onLoad={() => resetView()} />
      </div>
      {items.length > 1 && (
        <div className="mb-lb-dots">
          {items.map((_, n) => (
            <span key={n} className={"mb-lb-dot" + (n === idx ? " on" : "")}
              onClick={() => { setIdx(n); resetView(); }} />
          ))}
        </div>
      )}
      {!zoomed && <div className="mb-lb-hint">pinch or double-tap to zoom{items.length > 1 ? " · swipe for more" : ""}</div>}
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
