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
import { assetUrl, photoWebUrl } from "../assets";
import { DiagramCanvas, Marker, loadMarkerScale, saveMarkerScale, markerRadius, MARKER_SCALE_MIN, MARKER_SCALE_MAX, type CanvasApi, type Frame, type Pt } from "./DiagramCanvas";
import { DiagramView, readDiagramHash, type Drawing } from "./DiagramView";
import { markerState, markerTitle } from "./hotspotState";
import type { DiagramPart } from "../data/api";
import { makeUuid } from "../data/uuid";
import { buildDocHTML, openPrintWindow, type DocCompany, type DocOrder } from "../invoiceDoc";
import { ShelfRefusedError } from "../data/errors";
import type { WebHotspot } from "../data/api";
import { useAuth, type Role } from "../auth/AuthProvider";
import SettingsView from "../admin/SettingsView";
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
  // 0050: the one stock fact a customer gets. null = not synced yet (unknown).
  in_stock?: boolean | null;
  image?: string | null;
};

type Hit = {
  id: number; sku: string; name: string; brand: string | null;
  on_hand: number; in_stock?: boolean | null; price_cents: number | null; matched_on: string;
  bin?: string | null; thumb?: string | null;
};

type StockLine = {
  location_id: number; location_code: string; location_name: string;
  on_hand: number; bin: string | null;
  // 0047: holds for accepted orders. available = on_hand − reserved.
  reserved?: number; available?: number;
};

type LedgerLine = {
  id: number; location_code: string; delta: number; reason: string; created_at: string;
};

type Detail = {
  id: number; sku: string; name: string; locator: string | null;
  catalogue_pn: string | null; inventory_pn: string | null; brand: string | null;
  category_name: string | null; drawing_no: string | null; notes: string | null;
  price_cents: number | null; total_on_hand: number; in_stock?: boolean | null;
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
  customer_phone: string | null; customer_email: string | null; location_code: string | null;
  notes: string | null; created_at: string; fulfilled_at: string | null; tax_rate_bps: number;
  invoice_no: string | null; invoiced_at: string | null;
  // 0047: the Zoho Books sales order raised when the customer accepted
  zoho_salesorder_number?: string | null;
  client_response: string | null; client_responded_at: string | null;
  unpriced: number; total_minor: number;
  stage: "to_price" | "with_customer" | "to_pick" | "fulfilled" | string;
  lines: StaffLine[];
};

type MyRequest = {
  id: number; number: string; status: string; currency: string;
  notes: string | null; created_at: string;
  client_response: string | null; client_responded_at: string | null;
  // 0047: the sales order raised in Zoho Books when they accepted — their proforma
  zoho_salesorder_number?: string | null;
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

// The brand mark ships IN the app bundle (public/brand/), not the asset
// bucket — the logo should draw even before the first sync or with no signal,
// and bundling it means a redeploy updates it with no bucket credentials.
// v2 (2026-08-13): rebuilt from the refined "Logo Main.svg" — spill specks
// removed, slashes re-cut as clean geometry, edges smoothed.
//
// It ships as TWO layers on one shared canvas — the wordmark + stripes, and
// the truck alone — so the truck can drive off and back without the rest of
// the logo moving. Same dimensions, stacked, so there is no alignment maths:
// see .mb-brand in mobile.css.
const LOGO_BODY = "/brand/ctp_logo_body_v2.png";
const LOGO_TRUCK = "/brand/ctp_truck_v2.png";

/** The logo, with a truck that occasionally goes for a drive. */
function Brand() {
  return (
    <span className="mb-brand" aria-label="China Truck Parts">
      <img className="mb-brand-body" src={LOGO_BODY} alt=""
        onError={(e) => { e.currentTarget.style.display = "none"; }} />
      <img className="mb-brand-truck" src={LOGO_TRUCK} alt="" aria-hidden="true"
        onError={(e) => { e.currentTarget.style.display = "none"; }} />
    </span>
  );
}

/** ≥1024 CSS px: the one shell switch (DESKTOP_AUDIT.md §2.2), the same
 *  boundary mobile.css uses for the desktop skin. Tracks live resizes. */
function useIsDesktop(): boolean {
  const [on, setOn] = useState<boolean>(
    () => window.matchMedia?.("(min-width: 1024px)").matches ?? false
  );
  useEffect(() => {
    const mq = window.matchMedia?.("(min-width: 1024px)");
    if (!mq) return;
    const onChange = (e: MediaQueryListEvent) => setOn(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return on;
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

// ─── appearance ──────────────────────────────────────────────────────────────
//
// One device-local preference: "auto" follows the phone's own light/dark
// setting live (sunset flips the app with the OS), the other two pin it.
// localStorage rather than the database on purpose — which THEME a device
// draws is that device's business, needs no sync, and must work signed-out.
type ThemePref = "auto" | "light" | "dark";
const THEME_KEY = "ctp.theme";

function loadThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === "light" || v === "dark" ? v : "auto";
  } catch {
    return "auto";
  }
}

// ─── camera → bucket-sized image ─────────────────────────────────────────────
//
// A phone camera hands over 8–12MB; the catalogue needs ~200KB. Longest side
// capped at 1600px and re-encoded as JPEG on a WHITE canvas — every surface
// (thumbs, hero, lightbox) renders photos on white, so transparency would
// only ever turn into surprise black in some other viewer.
async function shrinkImage(file: File, maxSide = 1600): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const el = new Image();
      el.onload = () => res(el);
      el.onerror = () => rej(new Error("That file is not an image this phone can read."));
      el.src = url;
    });
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const cv = document.createElement("canvas");
    cv.width = w; cv.height = h;
    const cx = cv.getContext("2d");
    if (!cx) throw new Error("Could not process the photo on this device.");
    cx.fillStyle = "#fff";
    cx.fillRect(0, 0, w, h);
    cx.drawImage(img, 0, 0, w, h);
    const blob = await new Promise<Blob | null>((res) => cv.toBlob(res, "image/jpeg", 0.85));
    if (!blob) throw new Error("Could not encode the photo.");
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ─── a part photo: web variant first, master if that 404s ────────────────────
//
// Thumbs, the hero and the admin gallery all show the cropped web variant
// (see photoWebUrl). The lightbox deliberately does NOT — it is the "see the
// original" surface, and pinch-zoom on the master gives the same pixels the
// crop would. The fallback is keyed on the path so a re-render with a new
// photo starts again from the variant rather than inheriting a stale "failed".
function PhotoImg({ path, alt, className, onClick }: {
  path: string; alt: string; className?: string; onClick?: () => void;
}) {
  const web = photoWebUrl(path);
  const [failed, setFailed] = useState<string | null>(null);
  const useWeb = !!web && failed !== path;
  return (
    <img className={className} src={useWeb ? web : assetUrl(path)} alt={alt} loading="lazy"
      onClick={onClick}
      onError={useWeb ? () => setFailed(path) : undefined} />
  );
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
  const { session, role: dbRole, signOut } = useAuth();

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
  const [viewer, setViewer] = useState<{ items: { path: string; label: string; diagram?: boolean }[]; idx: number } | null>(null);
  const [cart, setCart] = useState<{ id: number; sku: string; name: string; qty: number }[]>([]);
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [audit, setAudit] = useState<{ table: string; rows: number }[] | null>(null);
  const [mine, setMine] = useState<MyRequest[] | null>(null);
  const [answering, setAnswering] = useState<number | null>(null);
  const [orders, setOrders] = useState<StaffOrder[] | null>(null);
  // A load that fails must say so. Before this, a rejected promise left `orders`
  // at null forever and the view sat on "Loading…" with no way out — one bad row
  // anywhere in the batch silently took down the whole order desk.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [hotspotEditor, setHotspotEditor] = useState<{ path: string; label: string } | null>(null);
  // The diagram viewer (split pane, parts list). Photos keep the lightbox.
  const [diagram, setDiagram] = useState<{ idx: number; part: number | null } | null>(null);
  // Every section that has a drawing, in code order — prev/next walks this.
  const drawings = useMemo<Drawing[]>(() => sections.filter((s) => s.diagram).map((s) => ({ path: s.diagram!, label: s.name, key: "SEC" + s.id })), [sections]);
  const openDiagram = useCallback((path: string, part: number | null = null) => {
    const i = drawings.findIndex((x) => x.path === path);
    if (i >= 0) setDiagram({ idx: i, part });
    else setViewer({ items: [{ path, label: "Diagram", diagram: true }], idx: 0 });   // a drawing with no section row
  }, [drawings]);
  // Deep link on load: #dg=SEC101&part=1019 lands on the part once the
  // sections have synced.
  const deepDone = useRef(false);
  useEffect(() => {
    if (deepDone.current || drawings.length === 0) return;
    const h = readDiagramHash(); if (!h) { deepDone.current = true; return; }
    const i = drawings.findIndex((x) => x.key === h.key);
    if (i >= 0) { setDiagram({ idx: i, part: h.part }); setTab("find"); }
    deepDone.current = true;
  }, [drawings]);
  const [ordersErr, setOrdersErr] = useState<string | null>(null);
  const [mineErr, setMineErr] = useState<string | null>(null);
  const [openOrder, setOpenOrder] = useState<number | null>(null);
  // A blocked save is held here until the person chooses. Clearing it is the
  // only way past, so the choice cannot be missed by looking away.
  const [floorBlock, setFloorBlock] = useState<{ order: StaffOrder; message: string } | null>(null);
  // Fulfil and invoice each ask once before they write. Neither can be undone
  // from the phone: fulfilment appends to the ledger, invoicing spends a
  // number. The strip names what is about to happen and the person taps the
  // verb, not "OK".
  const [pendingAct, setPendingAct] = useState<{ order: StaffOrder; kind: "fulfil" | "invoice" } | null>(null);
  const [draftPrices, setDraftPrices] = useState<Record<number, string>>({});
  const [savingOrder, setSavingOrder] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);
  // The search box (home or find — only one is mounted at a time).
  const qRef = useRef<HTMLInputElement | null>(null);
  // True while WE focus the search box, so the home box's onFocus (which
  // jumps to Find for a person who tapped it) ignores a focus it did not ask for.
  const quietFocus = useRef(false);
  const isDesktop = useIsDesktop();

  // ── appearance ──
  const [themePref, setThemePref] = useState<ThemePref>(loadThemePref);
  const [sysLight, setSysLight] = useState<boolean>(
    () => window.matchMedia?.("(prefers-color-scheme: light)").matches ?? false
  );
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-color-scheme: light)");
    if (!mq) return;
    const onChange = (e: MediaQueryListEvent) => setSysLight(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  const light = themePref === "light" || (themePref === "auto" && sysLight);
  const pickTheme = (t: ThemePref) => {
    setThemePref(t);
    try { localStorage.setItem(THEME_KEY, t); } catch { /* private mode: lives for the session */ }
  };
  // Keep the browser chrome (status bar, PWA title bar) the same colour as
  // the app behind it, or light mode gets a black cap on every screen.
  useEffect(() => {
    document.querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", light ? "#EEF1F5" : "#0B0D10");
  }, [light]);

  // ── who is this? ──
  //
  // The TOKEN's role, not the app_user read, because the token is what decides
  // which sync stream fed this device — so it is also the honest answer to
  // "what is this person allowed to see?". A customer's phone has no prices,
  // no bins and no stock movements in its database at all; the UI below hides
  // those fields to match, but hiding them is cosmetic. The stream is the
  // control. Anything not gated there is not protected by this.
  //
  // Two sources, deliberately ordered. The token claim is authoritative when it
  // is there, because it is what actually selected this device's sync stream.
  // When it is absent — the access-token hook not enabled yet, or a session
  // minted before it was — fall back to the app_user row AuthProvider read.
  //
  // The order matters less than the ending: an unknown role resolves to the
  // CLIENT view, never the staff one. Getting this backwards means a device we
  // cannot identify is shown the staff interface — bins, cost, margin, the
  // order desk. Least privilege is the only safe default for a value that can
  // legitimately be missing.
  const role = tokenRole(session?.access_token) ?? dbRole;
  const isClient = role == null || role === "customer";

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

  // 0049: a movement this device booked while its ledger was stale, refused by
  // the server's shelf guard on upload. It was dropped, not retried; say so.
  useEffect(() => {
    const h = (ev: Event) => {
      const msg = (ev as CustomEvent<{ message: string }>).detail?.message;
      showToast({ text: (msg ?? "A stock movement was refused by the shelf guard.") + " That entry was not booked.", err: true });
      refresh();
    };
    window.addEventListener("ctp-sync-refused", h);
    return () => window.removeEventListener("ctp-sync-refused", h);
  }, [showToast, refresh]);

  // ── desktop keyboard (P12a) ──
  // A mouse-and-keyboard user expects the cursor to be in the search box, and
  // Escape to close whatever is on top. Both are desktop-only: a phone has no
  // Escape key, and focusing an input there would raise the keyboard uninvited.
  useEffect(() => {
    if (!isDesktop || (tab !== "home" && tab !== "find")) return;
    const el = qRef.current;
    if (!el || document.activeElement === el) return;
    quietFocus.current = true;
    el.focus();
    quietFocus.current = false;
  }, [isDesktop, tab]);
  useEffect(() => {
    if (!isDesktop) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // top-most first: the zoom viewer, then the counter, then the part sheet
      if (viewer && !hotspotEditor) { setViewer(null); e.preventDefault(); return; }
      if (hotspotEditor) return;                 // has its own ✕ and a part picker; leave it
      if (counterOpen) { setCounterOpen(false); e.preventDefault(); return; }
      if (sheetOpen) { setSheetOpen(false); e.preventDefault(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isDesktop, viewer, hotspotEditor, counterOpen, sheetOpen]);

  // ── staff photo admin ──
  //
  // Every change is a server-side RPC; what this device shows only updates
  // when the changed row comes BACK down the sync stream. So after each call,
  // re-read the local part detail until the change is visible (a second or
  // two), instead of optimistically drawing a state the database hasn't
  // confirmed. The catalogue lists refresh at the end for the same reason.
  const reloadDetailUntil = useCallback(async (
    partId: number, done: (d: Detail) => boolean
  ): Promise<void> => {
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => window.setTimeout(r, i === 0 ? 500 : 1000));
      try {
        const fresh = await api.partDetail<Detail>(partId);
        setDetail(fresh);
        if (done(fresh)) return;
      } catch {
        return; // part unreadable mid-sync; the next pass will settle it
      }
    }
  }, []);

  const makePrimary = async (imageId: number) => {
    const dd = detail;
    if (!dd || photoBusy) return;
    setPhotoBusy(true);
    try {
      await api.adminSetPrimaryPhoto(imageId);
      await reloadDetailUntil(dd.id, (f) => f.images.find((i) => i.id === imageId)?.is_primary === true);
      showToast({ text: "Primary photo updated." });
      refresh();
    } catch (e) {
      console.error(e);
      showToast({ text: e instanceof Error ? e.message : "Could not update the photo.", err: true });
    } finally {
      setPhotoBusy(false);
    }
  };

  const deletePhoto = async (imageId: number) => {
    const dd = detail;
    if (!dd || photoBusy) return;
    if (!window.confirm("Delete this photo? It disappears from every phone. (The desktop app keeps its own local copy.)")) return;
    setPhotoBusy(true);
    try {
      await api.adminDeletePhoto(imageId);
      await reloadDetailUntil(dd.id, (f) => !f.images.some((i) => i.id === imageId));
      showToast({ text: "Photo deleted." });
      refresh();
    } catch (e) {
      console.error(e);
      showToast({ text: e instanceof Error ? e.message : "Could not delete the photo.", err: true });
    } finally {
      setPhotoBusy(false);
    }
  };

  const addPhoto = async (file: File) => {
    const dd = detail;
    if (!dd || photoBusy) return;
    setPhotoBusy(true);
    try {
      const blob = await shrinkImage(file);
      const before = dd.images.length;
      await api.adminAddPhoto(dd.id, blob, file.name);
      showToast({ text: "Photo uploaded — syncing…" });
      await reloadDetailUntil(dd.id, (f) => f.images.length > before);
      refresh();
    } catch (e) {
      console.error(e);
      showToast({ text: e instanceof Error ? e.message : "Upload failed.", err: true });
    } finally {
      setPhotoBusy(false);
    }
  };

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
      showToast({ text: e instanceof ShelfRefusedError ? e.message : "Post failed — nothing was booked.", err: true });
    }
  }, [showToast, reloadDetail]);

  /**
   * Move stock between locations. Undo is the mirror move, not a delete —
   * consistent with everything else here, and it leaves both the mistake and
   * the correction visible in the history.
   */
  const move = useCallback(async (
    d: Detail, fromId: number, toId: number, qty: number, label: string
  ) => {
    try {
      await api.transferStock(d.id, fromId, toId, qty, makeUuid(), makeUuid(), null);
      const undo = async () => {
        try {
          await api.transferStock(d.id, toId, fromId, qty, makeUuid(), makeUuid(), null);
          showToast({ text: `Moved back — ${d.sku} returned.` });
          reloadDetail(d.id);
        } catch (e) { console.error(e); }
      };
      showToast({ text: label, undo });
      reloadDetail(d.id);
    } catch (e) {
      console.error(e);
      showToast({
        text: e instanceof Error ? e.message : "Move failed — nothing was booked.",
        err: true,
      });
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
    setMineErr(null);
    api.myRequests<MyRequest[]>()
      .then((r) => { setMine(r); setMineErr(null); })
      .catch((e) => {
        console.error(e);
        setMine([]);
        setMineErr(e?.message ? String(e.message) : "Could not load your requests.");
      });
  }, [isClient]);
  // Refresh when sync lands: the moment staff price the quote, it appears.
  useEffect(() => { if (isClient) loadMine(); }, [isClient, lastSynced, loadMine]);

  // ── staff order desk ──
  const loadOrders = useCallback(() => {
    if (isClient) return;
    setOrdersErr(null);
    api.staffOrders<StaffOrder[]>()
      .then((r) => { setOrders(r); setOrdersErr(null); })
      .catch((e) => {
        console.error(e);
        setOrders([]);
        setOrdersErr(e?.message ? String(e.message) : "Could not load the order desk.");
      });
  }, [isClient]);
  useEffect(() => { if (!isClient) loadOrders(); }, [isClient, lastSynced, loadOrders]);

  /**
   * "1850", "1850.50", "1 850,50", "R1,850.50" — all of them are money here.
   * South African keyboards produce the decimal COMMA, and Number("1850,00")
   * is NaN, which the first version silently dropped and then reported as
   * "no prices to save" — a message about a different problem than the one
   * the person actually had. When both separators appear, whichever comes
   * last is the decimal point; the other is thousands.
   */
  type PriceFinding = {
  line_id: number; sku: string; severity: "block" | "warn"; code: string;
  message: string;
};

const parseRand = (s: string): number => {
    const t = s.replace(/[Rr\s]/g, "");
    if (t === "") return NaN;
    if (t.includes(",") && t.includes(".")) {
      return t.lastIndexOf(",") > t.lastIndexOf(".")
        ? Number(t.replace(/\./g, "").replace(",", "."))
        : Number(t.replace(/,/g, ""));
    }
    if (t.includes(",")) {
      // Only a comma is ambiguous: "1850,50" is cents, "1,850" is thousands.
      // A comma followed by exactly three digits reads as a thousands mark;
      // one or two digits after it read as cents.
      return /,\d{3}(,\d{3})*$/.test(t)
        ? Number(t.replace(/,/g, ""))
        : Number(t.replace(/,/g, "."));
    }
    return Number(t);
  };

  const savePrices = useCallback(async (o: StaffOrder, overrideFloor = false) => {
    // "Every line must have a price" is TRUE of an order with no lines — the
    // check passes vacuously and the server then rejects the empty list with a
    // message about prices, which is not the problem the person is looking at.
    // (Found live: SO-1001, an old empty demo quote.) Say what is actually
    // wrong instead.
    if (o.lines.length === 0) {
      showToast({ text: `${o.number} has no lines — there is nothing to price.`, err: true });
      return;
    }
    // Resolve every line BEFORE talking to the server, and if any is missing,
    // say which — an early clear message beats a late vague one.
    const resolved = o.lines.map((l) => {
      const typed = draftPrices[l.id];
      const rand = typed == null || typed === ""
        ? l.unit_price_minor / 100
        : parseRand(typed);
      return { line: l, minor: Number.isFinite(rand) ? Math.round(rand * 100) : 0 };
    });
    const missing = resolved.filter((r) => r.minor <= 0);
    if (missing.length > 0) {
      showToast({
        text: `Type a price for every line first — missing: ${missing
          .map((m) => m.line.sku).slice(0, 3).join(", ")}${missing.length > 3 ? "…" : ""}`,
        err: true,
      });
      return;
    }
    setSavingOrder(true);
    try {
      const lines = resolved.map((r) => ({ line_id: r.line.id, unit_price_minor: r.minor }));
      const res = await api.priceQuote<{
        unpriced_left?: number; total_minor?: number;
        warnings?: PriceFinding[]; below_floor_overridden?: boolean;
      }>(o.id, lines, overrideFloor);
      const left = Number(res?.unpriced_left ?? 0);

      // Warnings never block. They ride back with the result so a price that
      // is legal but strange still gets said out loud — which is the whole
      // lesson of the R11 111 door: nothing was wrong with the software's
      // rules, it simply had no opinion about the number it was handed.
      const warns = (res?.warnings ?? []).filter((w) => w.severity === "warn");
      if (warns.length > 0) {
        showToast({ text: warns.map((w) => w.message).join(" "), err: true });
      } else {
        showToast({ text: left > 0
          ? `Saved — ${left} line${left === 1 ? "" : "s"} still without a price, so ${o.number} can't be accepted yet.`
          : `${o.number} priced: ${fmtR(Number(res?.total_minor ?? 0))}. It's on their phone now.` });
      }
      setDraftPrices({});
      setFloorBlock(null);
      loadOrders();
    } catch (e) {
      console.error(e);
      const msg = e instanceof Error ? e.message.replace(/^\[CTP web\] could not save prices: /, "") : "Could not save.";
      // A margin-floor refusal is not a failure to be dismissed — it is a
      // decision to be made, so it gets a strip with two named choices rather
      // than a toast that vanishes.
      if (/below the minimum margin/i.test(msg)) setFloorBlock({ order: o, message: msg });
      else showToast({ text: msg, err: true });
    } finally {
      setSavingOrder(false);
    }
  }, [draftPrices, showToast, loadOrders]);

  /** Stock out. One server transaction (0042): refuses if any line is short,
   *  names the shortfall, writes nothing in that case. Idempotent on retry. */
  const cancelOrder = useCallback(async (o: StaffOrder) => {
    const reason = window.prompt(`Cancel ${o.number}? Any stock held for it is released. Reason:`);
    if (reason == null) return;
    setSavingOrder(true);
    try {
      const r = await api.cancelOrder<{ released: number }>(o.id, reason);
      showToast({ text: `${o.number} cancelled${r.released ? ` — ${r.released} stock hold${r.released === 1 ? "" : "s"} released` : ""}.` });
      loadOrders();
    } catch (e) { showToast({ text: e instanceof Error ? e.message.replace(/^\[CTP web\] could not cancel: /, "") : "Could not cancel.", err: true }); }
    finally { setSavingOrder(false); }
  }, [showToast, loadOrders]);

  const fulfilOrder = useCallback(async (o: StaffOrder) => {
    setSavingOrder(true);
    try {
      const r = await api.fulfilOrder<{ movements: number; already: boolean }>(o.id);
      showToast({ text: r?.already
        ? `${o.number} was already fulfilled — nothing changed.`
        : `${o.number} fulfilled: ${r?.movements ?? 0} line${(r?.movements ?? 0) === 1 ? "" : "s"} taken out of stock.` });
      loadOrders();
    } catch (e) {
      const msg = e instanceof Error ? e.message.replace(/^\[CTP web\] could not fulfil: /, "") : "Could not fulfil.";
      showToast({ text: msg, err: true });
    } finally { setSavingOrder(false); }
  }, [showToast, loadOrders]);

  /** Issue the tax invoice: the database allocates the number now. */
  const invoiceOrder = useCallback(async (o: StaffOrder) => {
    setSavingOrder(true);
    try {
      const r = await api.invoiceOrder<{ invoice_no: string; already: boolean }>(o.id);
      showToast({ text: r?.already
        ? `${o.number} is already invoiced as ${r.invoice_no}.`
        : `Invoice ${r?.invoice_no ?? ""} issued for ${o.number}.` });
      loadOrders();
    } catch (e) {
      const msg = e instanceof Error ? e.message.replace(/^\[CTP web\] could not issue the invoice: /, "") : "Could not issue the invoice.";
      showToast({ text: msg, err: true });
    } finally { setSavingOrder(false); }
  }, [showToast, loadOrders]);

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

  // 0047: why a quote cannot be accepted yet, by order id — read when the
  // quote is ready so the button says so before anyone taps it.
  const [blockers, setBlockers] = useState<Record<number, api.AcceptBlocker[]>>({});
  useEffect(() => {
    if (!isClient) return;
    const ready = (mine ?? []).filter((r) => r.status === "quote" && r.priced);
    let stale = false;
    (async () => {
      const next: Record<number, api.AcceptBlocker[]> = {};
      for (const r of ready) {
        try { const c = await api.quoteAcceptCheck(r.id); next[r.id] = c.ok ? [] : c.blockers; }
        catch (e) { console.error(e); }
      }
      if (!stale) setBlockers(next);
    })();
    return () => { stale = true; };
  }, [isClient, mine]);

  const answerQuote = useCallback(async (r: MyRequest, accept: boolean) => {
    setAnswering(r.id);
    try {
      if (accept) {
        // Zoho sales order + stock hold, both or neither (accept-quote function).
        const res = await api.acceptQuote(r.id);
        showToast({ text: `${r.number} accepted — sales order ${res.zoho_salesorder_number} raised${res.emailed ? ` and emailed to ${res.emailed_to.join(", ")}` : ""}. We'll get it ready.` });
      } else {
        await api.respondToQuote(r.id, false);
        showToast({ text: `${r.number} declined.` });
      }
      loadMine();
    } catch (e) {
      console.error(e);
      const msg = e instanceof Error
        ? e.message.replace(/^\[CTP web\] could not (send your answer|accept): /, "")
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
        qty_on_hand: h.on_hand, in_stock: h.in_stock ?? null, bin: h.bin ?? null, price_cents: h.price_cents,
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
            <input className="mb-q" ref={qRef} value={q} inputMode="search" enterKeyHint="search"
              placeholder="Search everything…"
              onFocus={() => { if (!quietFocus.current) setTab("find"); }}
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
              <input className="mb-q" ref={qRef} value={q} inputMode="search" enterKeyHint="search"
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
              onClick={() => openDiagram(s.diagram!)}>
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
        {/* .mb-cards is a plain block on a phone; at desktop widths it is the
            auto-fill card grid (mobile.css, desktop skin). */}
        <div className="mb-cards">
        {cards.map((p) => (
          <button key={p.id} className="mb-card" onClick={() => openPart(p.id)}>
            {p.image
              ? <PhotoImg className="mb-thumb" path={p.image} alt="" />
              : <span className="mb-thumb ph"><IcPin /></span>}
            <span className="mb-cbody">
              <span className="mb-cname">{p.name}</span>
              <span className="mb-csku mb-mono">{p.sku}</span>
              {/* A client's device holds no bins and no stock movements, so
                  these would not merely be private — they would be WRONG
                  (every count would read zero). Omitted, not blanked. What a
                  customer DOES get is in_stock (0050): yes/no, never a
                  number, derived on the server. Unknown (not synced yet)
                  shows nothing rather than "out". */}
              {isClient ? (
                p.in_stock != null && (
                  <span className="mb-cmeta">
                    <span className={"mb-qty" + (p.in_stock ? "" : " zero")}>{p.in_stock ? "In stock" : "Out of stock"}</span>
                  </span>
                )
              ) : (
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
        </div>
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
        {!isClient && (role === "manager" || role === "admin") && (
          <button className="mb-settings-cta" onClick={() => setSettingsOpen(true)}>
            <span>
              <b>Settings</b>
              <small>Company details, order emails, staff, warehouses, pricing</small>
            </span>
            <span className="mb-chev">›</span>
          </button>
        )}
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
        {/* Device-local settings. "Auto" tracks the phone's own light/dark
            switch live; the choice never syncs — it is this device's alone. */}
        <div className="mb-count">Appearance</div>
        <div className="mb-rows">
          <div className="mb-row">
            <span className="mb-rk">Theme</span>
            <span className="mb-seg">
              {(["auto", "light", "dark"] as const).map((t) => (
                <button key={t} className={"mb-segbtn" + (themePref === t ? " on" : "")}
                  onClick={() => pickTheme(t)}>
                  {t === "auto" ? "Auto" : t === "light" ? "Light" : "Dark"}
                </button>
              ))}
            </span>
          </div>
          {themePref === "auto" && (
            <div className="mb-row">
              <span className="mb-rk">Following</span>
              <span className="mb-rv">{sysLight ? "phone · light" : "phone · dark"}</span>
            </div>
          )}
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

  /** The quote or invoice as a document, from the same builder the desktop
   *  prints with. Title follows status (quote/confirmed → Quotation, else
   *  Tax Invoice); the letterhead is the owner's Settings → Company row. The
   *  arithmetic is the desktop's tax_of(): half-up in cents. */
  const printOrder = async (o: StaffOrder) => {
    try {
      const company = await api.getCompany<DocCompany>();
      const lines = o.lines.map((l) => ({
        sku: l.catalogue_pn ?? l.sku, name: l.name, qty: l.qty,
        unit_price_minor: l.unit_price_minor, line_total_minor: l.unit_price_minor * l.qty,
      }));
      const subtotal_minor = lines.reduce((t, l) => t + l.line_total_minor, 0);
      const tax_minor = Math.floor((subtotal_minor * o.tax_rate_bps + 5000) / 10000);
      const doc: DocOrder = {
        number: o.number, status: o.status, created_at: o.created_at, fulfilled_at: o.fulfilled_at,
        invoice_no: o.invoice_no, invoiced_at: o.invoiced_at,
        customer_name: o.customer_name, customer_contact: o.customer_contact,
        customer_phone: o.customer_phone, customer_email: o.customer_email,
        location_code: o.location_code ?? "",
        lines, subtotal_minor, tax_rate_bps: o.tax_rate_bps, tax_minor, total_minor: subtotal_minor + tax_minor,
      };
      openPrintWindow(buildDocHTML(doc, company));
    } catch (e) { setToast({ text: "Could not build the document: " + String(e), err: true }); }
  };
  // A fulfilled order has no invoice yet: what prints is still the quotation
  // (goods out, number not issued). Only 'invoiced' prints as an invoice.
  const docLabel = (o: StaffOrder) =>
    o.status === "invoiced" ? "Print invoice / PDF" : "Print quote / PDF";

  const STAGES: { key: string; label: string; hint: string }[] = [
    { key: "to_price",      label: "Needs pricing",   hint: "came in from a customer" },
    { key: "with_customer", label: "With the customer", hint: "quoted, waiting on their answer" },
    { key: "to_pick",       label: "Accepted",        hint: "sales order in Zoho — check it is paid there before the goods go" },
    { key: "fulfilled",     label: "Goods out",       hint: "stock taken — Zoho issues the invoice from the sales order" },
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
        {orders === null && !ordersErr && <div className="mb-count">Loading…</div>}
        {ordersErr && (
          <div className="mb-empty">
            <div>Could not load the order desk.</div>
            <div className="mb-csku" style={{ marginTop: 6 }}>{ordersErr}</div>
            <button className="mb-btn s" style={{ marginTop: 14, maxWidth: 220, margin: "14px auto 0" }}
              onClick={loadOrders}>Try again</button>
          </div>
        )}
        {orders !== null && !ordersErr && orders.length === 0 && (
          <div className="mb-empty">No orders on the desk.</div>
        )}
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
                          o.lines.length === 0 ? (
                            <div className="mb-row">
                              <span className="mb-rk">Empty</span>
                              <span className="mb-rv" style={{ color: "var(--warn)" }}>
                                no lines on this order — nothing to price
                              </span>
                            </div>
                          ) : (
                            <div className="mb-row" style={{ gap: 10 }}>
                              <button className="mb-btn s" style={{ height: 46 }} disabled={savingOrder}
                                onClick={() => { void fillList(o); }}>Fill from list</button>
                              <button className="mb-btn p" style={{ height: 46 }} disabled={savingOrder}
                                onClick={() => { void savePrices(o); }}>
                                {savingOrder ? "Saving…" : "Send quote"}
                              </button>
                            </div>
                          )
                        )}
                        {o.stage === "with_customer" && (
                          <div className="mb-row">
                            <span className="mb-rk">Waiting</span>
                            <span className="mb-rv">sent {timeAgo(o.created_at)} · they see it on their phone</span>
                          </div>
                        )}
                        {o.stage !== "to_price" && (
                          <div className="mb-row">
                            <button className="mb-btn s" style={{ height: 46 }} onClick={() => { void printOrder(o); }}>
                              {docLabel(o)}
                            </button>
                          </div>
                        )}
                        {o.stage === "to_pick" && (
                          <div className="mb-row">
                            <span className="mb-rk">Stock</span>
                            <span className="mb-rv">held for this order since acceptance · <button className="mb-chip" disabled={savingOrder} onClick={() => { void cancelOrder(o); }}>Cancel order &amp; release</button></span>
                          </div>
                        )}
                        {o.stage === "to_pick" && (
                          <>
                            <div className="mb-row">
                              <span className="mb-rk">Accepted</span>
                              <span className="mb-rv" style={{ color: "var(--green)" }}>
                                {o.client_responded_at ? timeAgo(o.client_responded_at) : "by the customer"}
                                {o.zoho_salesorder_number
                                  ? <> · sales order <b className="mb-mono">{o.zoho_salesorder_number}</b> in Zoho Books — payment and the tax invoice live there</>
                                  : <> · <span style={{ color: "var(--amber)" }}>no Zoho sales order on this one (accepted before the Zoho link) — raise it by hand</span></>}
                              </span>
                            </div>
                            <div className="mb-row">
                              <button className="mb-btn p" style={{ height: 46 }} disabled={savingOrder}
                                onClick={() => setPendingAct({ order: o, kind: "fulfil" })}>
                                Fulfil — take stock out
                              </button>
                            </div>
                          </>
                        )}
                        {o.stage === "fulfilled" && (
                          <>
                            <div className="mb-row">
                              <span className="mb-rk">Goods out</span>
                              <span className="mb-rv">{o.fulfilled_at ? timeAgo(o.fulfilled_at) : "—"}</span>
                            </div>
                            <div className="mb-row">
                              <button className="mb-btn p" style={{ height: 46 }} disabled={savingOrder}
                                onClick={() => setPendingAct({ order: o, kind: "invoice" })}>
                                Issue tax invoice
                              </button>
                            </div>
                          </>
                        )}
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
        {/* Everything the queue is finished with. staffOrders() always returned
            these; the desk only ever drew its three lanes, so four invoiced
            Hermans orders were on the phone and invisible. Same card as the
            lanes, newest first (the query's order), no actions. */}
        {orders && (() => {
          const done = orders.filter((o) => !STAGES.some((s) => s.key === o.stage))
            // Newest first by the time it was invoiced. Never by invoice_no:
            // the count is two digits by design, so as text '260914100' would
            // sort before '26091499' (0042).
            .sort((a, b) => (b.invoiced_at ?? b.fulfilled_at ?? b.created_at)
              .localeCompare(a.invoiced_at ?? a.fulfilled_at ?? a.created_at));
          if (done.length === 0) return null;
          // The invoice total, the way the desktop prints it: tax_of() in
          // main.rs rounds half-up in cents. The card must agree with the paper.
          const grand = (o: StaffOrder) => o.total_minor + Math.floor((o.total_minor * o.tax_rate_bps + 5000) / 10000);
          return (
            <div>
              <div className="mb-count">Completed · {done.length} — invoiced and closed</div>
              {done.map((o) => {
                const open = openOrder === o.id;
                const when = o.invoiced_at ?? o.fulfilled_at ?? o.created_at;
                return (
                  <div className="mb-rows" key={o.id} style={{ marginBottom: 12 }}>
                    <button className="mb-row" style={{ width: "100%", background: "none", border: 0, textAlign: "left" }}
                      onClick={() => { setOpenOrder(open ? null : o.id); setDraftPrices({}); }}>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <div className="mb-cname">{o.customer_name}</div>
                        <div className="mb-csku mb-mono">
                          {o.invoice_no ? `${o.invoice_no} · ` : ""}{o.number} · {o.lines.length} line{o.lines.length === 1 ? "" : "s"} · {when.slice(0, 10)}
                        </div>
                      </span>
                      <span className="mb-rv">
                        <div>{fmtR(grand(o))}</div>
                        <div className="mb-csku" style={{ textTransform: "capitalize" }}>
                          {o.status}{o.tax_rate_bps > 0 ? " · incl. VAT" : ""}
                        </div>
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
                            <span className="mb-rv">{fmtR(l.unit_price_minor * l.qty)}</span>
                          </div>
                        ))}
                        {o.tax_rate_bps > 0 && (
                          <div className="mb-row">
                            <span className="mb-rk">VAT {(o.tax_rate_bps / 100).toFixed(0)}%</span>
                            <span className="mb-rv">{fmtR(grand(o) - o.total_minor)}</span>
                          </div>
                        )}
                        <div className="mb-row">
                          <span className="mb-rk" style={{ textTransform: "capitalize" }}>{o.status}</span>
                          <span className="mb-rv">{timeAgo(when)}</span>
                        </div>
                        <div className="mb-row">
                          <button className="mb-btn s" style={{ height: 46 }} onClick={() => { void printOrder(o); }}>
                            {docLabel(o)}
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })()}
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
        {mineErr && (
          <div className="mb-empty">
            <div>Could not load your quotes.</div>
            <div className="mb-csku" style={{ marginTop: 6 }}>{mineErr}</div>
            <button className="mb-btn s" style={{ marginTop: 14, maxWidth: 220, margin: "14px auto 0" }}
              onClick={loadMine}>Try again</button>
          </div>
        )}
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
                        : r.status === "confirmed" ? <b style={{ color: "var(--green)" }}>Accepted{r.zoho_salesorder_number ? ` · sales order ${r.zoho_salesorder_number}` : ""}</b>
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
                  {r.status === "confirmed" && r.zoho_salesorder_number && (
                    <div className="mb-note" style={{ margin: "6px 0 0" }}>
                      Your sales order <b className="mb-mono">{r.zoho_salesorder_number}</b> has been raised in our accounts system and emailed to you — it is your proforma. The tax invoice follows from it once payment is received.
                    </div>
                  )}
                  {awaiting && (blockers[r.id]?.length ?? 0) > 0 && (
                    <div className="mb-note" style={{ margin: "6px 0 0" }}>
                      <b>Not quite ready to accept:</b> {blockers[r.id].map((b) => b.message).join(" ")}
                    </div>
                  )}
                  {awaiting && (
                    <div className="mb-row" style={{ gap: 10 }}>
                      <button className="mb-btn s" style={{ height: 46 }}
                        disabled={answering === r.id}
                        onClick={() => { void answerQuote(r, false); }}>Decline</button>
                      <button className="mb-btn p" style={{ height: 46 }}
                        disabled={answering === r.id || (blockers[r.id]?.length ?? 0) > 0}
                        onClick={() => { void answerQuote(r, true); }}>
                        {answering === r.id ? "Raising the sales order…" : "Accept quote"}
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
                <PhotoImg path={hero} alt={d.name} />
                <span className="mb-zoomtag">⤢</span>
              </div>
            )}
            <h1 className="mb-pname">{d.name}</h1>
            <div className="mb-psku mb-mono">
              {d.sku}{d.locator ? `  ·  ${d.locator}` : ""}
            </div>

            {isClient ? (
              <>
                <div className="mb-box">
                  <div className="mb-k">Part number</div>
                  <div className="mb-v mono-pn">{d.catalogue_pn ?? d.sku}</div>
                  <div className="mb-sub">Add it to your request and we'll quote you</div>
                </div>
                {/* 0050: availability without the number. Stacked, not beside
                    the part number — a long OEM number needs the width. */}
                {d.in_stock != null && (
                  <div className="mb-box" style={{ marginTop: 8 }}>
                    <div className="mb-k">Availability</div>
                    <div className={"mb-v" + (d.in_stock ? " g" : " z")} style={{ fontSize: 18 }}>{d.in_stock ? "In stock" : "Out of stock"}</div>
                    <div className="mb-sub">{d.in_stock ? "Ready to quote" : "We'll quote a lead time"}</div>
                  </div>
                )}
              </>
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
                onClick={() => openDiagram(d.diagram_image!, d.id)}>
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
                  <span className="mb-rv">
                    {s.on_hand} on hand{(s.reserved ?? 0) > 0 && <span style={{ color: "var(--amber)" }}> · {s.reserved} held for orders · <b>{s.available}</b> free</span>}{s.bin ? ` · bin ${s.bin}` : ""}
                  </span>
                </div>
              ))}
              {!isClient && d.notes && <div className="mb-row"><span className="mb-rk">Notes</span><span className="mb-rv">{d.notes}</span></div>}
            </div>

            {/* Staff photo manager. Buttons hidden from clients, but the RPCs
                behind them check is_staff() server-side — the hiding is UX,
                the function is the control. */}
            {!isClient && (
              <>
                <div className="mb-count">
                  Photos{d.images.length > 0 ? ` · ${d.images.length}` : ""}
                </div>
                <div className="mb-padmin">
                  {d.images.map((i, n) => (
                    <div className={"mb-pcell" + (i.is_primary ? " star" : "")} key={i.id}>
                      <PhotoImg path={i.path} alt=""
                        onClick={() => setViewer({
                          items: d.images.map((im, m) => ({ path: im.path, label: `${d.sku} · photo ${m + 1} of ${d.images.length}` })),
                          idx: n,
                        })} />
                      <div className="mb-pops">
                        <button className={"mb-pop" + (i.is_primary ? " on" : "")}
                          aria-label="Make primary" disabled={photoBusy || i.is_primary}
                          onClick={() => { void makePrimary(i.id); }}>★</button>
                        <button className="mb-pop del" aria-label="Delete photo"
                          disabled={photoBusy}
                          onClick={() => { void deletePhoto(i.id); }}>✕</button>
                      </div>
                    </div>
                  ))}
                  <button className="mb-pcell add" disabled={photoBusy}
                    onClick={() => fileRef.current?.click()}>
                    <span className="mb-addplus">＋</span>
                    <span>{photoBusy ? "Working…" : "Add photo"}</span>
                  </button>
                </div>
                {/* No `capture` attribute on purpose: without it the phone
                    offers camera AND gallery; with it, camera only. */}
                <input ref={fileRef} type="file" accept="image/*" hidden
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = "";
                    if (f) void addPhoto(f);
                  }} />
              </>
            )}

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
      {d && counterOpen && (
        <Counter d={d} onPost={post} onMove={move} onClose={() => setCounterOpen(false)} />
      )}
    </div>
  );

  // Settings takes the whole screen rather than living inside a tab: it is a
  // different mode of use (setting the business up) from everything else here
  // (running it), and mixing the two invites a mis-tap on a live order desk.
  if (settingsOpen) {
    return (
      <div className={"mb-root" + (light ? " light" : "")}>
        <SettingsView role={role as Role} onClose={() => setSettingsOpen(false)} />
      </div>
    );
  }

  return (
    <div className={"mb-root" + (light ? " light" : "")}>
      {tab === "home" ? homeView
        : tab === "info" ? infoView
        : tab === "cart" ? (isClient ? cartView : ordersView)
        : listView}
      {sheet}
      {diagram && !hotspotEditor && (
        <DiagramView drawings={drawings} start={diagram.idx} deepPart={diagram.part} canEdit={!isClient}
          onClose={() => { setDiagram(null); if (/^#dg=/.test(location.hash)) history.replaceState(null, "", location.pathname + location.search); }}
          onOpenPart={(pid) => { void openPart(pid); }}
          onEditMarkers={(path, label) => setHotspotEditor({ path, label })}
          onAddToRequest={isClient ? (p: DiagramPart, n: number) => { addToCart({ id: p.id, sku: p.sku, name: p.name } as Detail, n); showToast({ text: `${p.sku} × ${n} added to your request` }); } : undefined}
          inRequest={isClient ? inCart : undefined} />
      )}
      {viewer && !hotspotEditor && (
        <Lightbox items={viewer.items} start={viewer.idx} onClose={() => setViewer(null)}
          canEdit={!isClient}
          onOpenPart={(pid) => { setViewer(null); void openPart(pid); }}
          onEditMarkers={(path, label) => setHotspotEditor({ path, label })} />
      )}
      {hotspotEditor && (
        <HotspotEditor path={hotspotEditor.path} label={hotspotEditor.label} canEdit={!isClient}
          onClose={() => setHotspotEditor(null)}
          onOpenPart={(pid) => { setHotspotEditor(null); setViewer(null); void openPart(pid); }} />
      )}

      {/* A margin-floor refusal. Deliberately NOT a toast: a toast is for
          something that already happened, and this is a decision that has not
          been made yet. It names the shortfall and offers two honest choices —
          go back and change the price, or price it under the floor on purpose,
          which the database then records on the order's notes. */}
      {floorBlock && (
        <div className="mb-toast err"
          style={{ display: "flex", flexDirection: "column", alignItems: "stretch", gap: 10 }}>
          <span>{floorBlock.message}</span>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="mb-chip on" style={{ flex: 1 }}
              onClick={() => setFloorBlock(null)}>
              Change the price
            </button>
            <button className="mb-chip" style={{ flex: 1 }}
              onClick={() => {
                const o = floorBlock.order;
                setFloorBlock(null);
                // The override is an ARGUMENT, not state. Setting state and
                // calling in the same tick would read the pre-update closure
                // and drop the override silently — the save would just fail
                // again with the same message and no way through.
                void savePrices(o, true);
              }}>
              Price it below the floor anyway
            </button>
          </div>
        </div>
      )}

      {pendingAct && (
        <div className="mb-toast"
          style={{ display: "flex", flexDirection: "column", alignItems: "stretch", gap: 10 }}>
          <span>
            {pendingAct.kind === "fulfil"
              ? `Take ${pendingAct.order.lines.reduce((t, l) => t + l.qty, 0)} item(s) out of stock for ${pendingAct.order.number}? This writes to the stock ledger and is not undone from here.`
              : `Issue a tax invoice for ${pendingAct.order.number} (${fmtR(pendingAct.order.total_minor + Math.floor((pendingAct.order.total_minor * pendingAct.order.tax_rate_bps + 5000) / 10000))} incl. VAT)? The next invoice number is allocated now and cannot be reused.`}
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="mb-chip" style={{ flex: 1 }} onClick={() => setPendingAct(null)}>
              Not yet
            </button>
            <button className="mb-chip on" style={{ flex: 1 }} disabled={savingOrder}
              onClick={() => {
                const a = pendingAct; setPendingAct(null);
                void (a.kind === "fulfil" ? fulfilOrder(a.order) : invoiceOrder(a.order));
              }}>
              {pendingAct.kind === "fulfil" ? "Fulfil" : "Issue invoice"}
            </button>
          </div>
        </div>
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
// Fullscreen viewer for photos and diagrams, on DiagramCanvas: one SVG whose
// viewBox is the drawing's natural units, image and markers in one transformed
// group. Pinch / wheel / double-tap / buttons zoom; one finger pans when
// zoomed; a swipe at fit scale flips through photos. Marker positions are
// never touched by zoom or resize — see DiagramCanvas.tsx for why.

function Lightbox({ items, start, onClose, canEdit, onOpenPart, onEditMarkers }: {
  items: { path: string; label: string; diagram?: boolean }[];
  start: number;
  onClose: () => void;
  canEdit?: boolean;
  onOpenPart?: (partId: number) => void;
  onEditMarkers?: (path: string, label: string) => void;
}) {
  const [idx, setIdx] = useState(Math.min(Math.max(start, 0), items.length - 1));
  const [zoomed, setZoomed] = useState(false);
  const [marks, setMarks] = useState<{ frame: Frame; hots: WebHotspot[] } | null>(null);
  const [frame, setFrame] = useState<Frame | null>(null);
  const markerScale = loadMarkerScale();   // the editor's setting, so the two agree
  const item = items[idx];

  useEffect(() => {
    setMarks(null); setFrame(null); setZoomed(false);
    if (!item.diagram) return;
    let live = true;
    api.listHotspots(item.path).then((d) => {
      if (!live) return;
      // The frame is the drawing's recorded natural size — the space every
      // hotspot is stored in. If it was never recorded, DiagramCanvas
      // measures the file and reports back (onFrame below).
      if (d.img_w && d.img_h) {
        const f = { w: d.img_w, h: d.img_h };
        setFrame(f);
        if (d.hotspots.length) setMarks({ frame: f, hots: d.hotspots });
      } else if (d.hotspots.length) {
        setMarks({ frame: { w: 0, h: 0 }, hots: d.hotspots });
      }
    }).catch((e) => console.error("hotspots:", e));
    return () => { live = false; };
  }, [item.path, item.diagram]);

  // Only a marker on a LIVE part opens one; a retired/missing link is drawn
  // as a fault (state "bad") and a tap says so instead of failing later.
  const markerEls = useMemo(() => marks?.hots.map((h) => (
    <Marker key={h.id} x={h.x} y={h.y} r={markerRadius(frame?.w ?? 0, markerScale)}
      label={h.item_no ?? "•"} state={markerState(h)}
      title={markerTitle(h)}
      onClick={(e) => { e.stopPropagation(); if (h.link === "ok" && h.part_id != null && onOpenPart) onOpenPart(h.part_id); }} />
  )), [marks, frame, onOpenPart]);

  return (
    <div className="mb-lb">
      <div className="mb-lb-head">
        <button className="mb-back" onClick={onClose}>✕</button>
        <span className="mb-lb-cap">{item.label}</span>
        {item.diagram && canEdit && onEditMarkers && (
          <button className="mb-chip on" onClick={() => onEditMarkers(item.path, item.label)}>
            {marks ? "Edit markers" : "Add markers"}
          </button>
        )}
      </div>
      <div className="mb-lb-stage">
        <DiagramCanvas key={item.path} href={assetUrl(item.path)} frame={frame}
          onFrame={(f) => setFrame(f)} onZoomed={setZoomed}
          onSwipe={items.length > 1 ? (dir) => {
            const n = idx + dir;
            if (n >= 0 && n < items.length) setIdx(n);
          } : undefined}>
          {markerEls}
        </DiagramCanvas>
      </div>
      {items.length > 1 && (
        <div className="mb-lb-dots">
          {items.map((_, n) => (
            <span key={n} className={"mb-lb-dot" + (n === idx ? " on" : "")} onClick={() => setIdx(n)} />
          ))}
        </div>
      )}
      {!zoomed && <div className="mb-lb-hint">pinch, wheel or double-tap to zoom · + − ⟲ buttons{items.length > 1 ? " · swipe for more" : ""}</div>}
    </div>
  );
}

// ─── the counter ─────────────────────────────────────────────────────────────
// Pick a location, set a quantity with the big paddles, then Receive or Issue.
// The sign is decided by the BUTTON, not the stepper — the stepper is always a
// positive "how many", which survives gloves and hurry better than a signed
// number ever did.

function Counter({ d, onPost, onMove, onClose }: {
  d: Detail;
  onPost: (d: Detail, locationId: number, delta: number, reason: string, label: string) => Promise<void>;
  onMove: (d: Detail, fromId: number, toId: number, qty: number, label: string) => Promise<void>;
  onClose: () => void;
}) {
  const [locId, setLocId] = useState<number | null>(
    d.stock.find((s) => s.on_hand > 0)?.location_id ?? d.stock[0]?.location_id ?? null
  );
  const [n, setN] = useState(1);
  // Moving is a different intent from booking stock in or out, so it gets its
  // own mode rather than a third button that silently needs a second location.
  const [moving, setMoving] = useState(false);
  const [destId, setDestId] = useState<number | null>(null);
  const loc = d.stock.find((s) => s.location_id === locId) ?? null;
  const dest = d.stock.find((s) => s.location_id === destId) ?? null;
  const canMove = d.stock.length > 1;

  const fire = (reason: "receipt" | "sale", label: string) => {
    if (locId == null) return;
    void onPost(d, locId, n, reason, label);
    onClose();
  };

  const fireMove = () => {
    if (locId == null || destId == null) return;
    void onMove(d, locId, destId, n,
      `${n} × ${d.sku} moved ${loc?.location_code ?? ""} → ${dest?.location_code ?? ""}`);
    onClose();
  };

  return (
    <div className="mb-sheet open" style={{ zIndex: 55 }}>
      <div className="mb-shead">
        <button className="mb-back" onClick={onClose}>‹</button>
        <span className="mb-shead-t">{moving ? "Move" : "Count"} — {d.sku}</span>
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

        {moving && (
          <>
            <div className="mb-count" style={{ marginTop: 6 }}>Move to</div>
            <div className="mb-locrow">
              {d.stock.filter((s) => s.location_id !== locId).map((s) => (
                <button key={s.location_id}
                  className={"mb-chip" + (s.location_id === destId ? " on" : "")}
                  onClick={() => setDestId(s.location_id)}>
                  {s.location_code} · {s.on_hand}{s.bin ? ` · ${s.bin}` : ""}
                </button>
              ))}
            </div>
          </>
        )}

        {loc && !moving && (
          <div className="mb-count" style={{ textAlign: "center" }}>
            {loc.location_code} has {loc.on_hand} now → {loc.on_hand + n} after receive,{" "}
            {loc.on_hand - n} after issue
          </div>
        )}
        {loc && moving && dest && (
          <div className="mb-count" style={{ textAlign: "center" }}>
            {loc.location_code} {loc.on_hand} → {loc.on_hand - n} ·{" "}
            {dest.location_code} {dest.on_hand} → {dest.on_hand + n}
          </div>
        )}
        {moving && loc && n > loc.on_hand && (
          <div className="mb-count" style={{ textAlign: "center", color: "var(--warn)" }}>
            {loc.location_code} only has {loc.on_hand}. Moving {n} leaves it short —
            do a count first if the shelf disagrees.
          </div>
        )}

        <div className="mb-note">
          {moving ? (
            <>Moving writes <b>two</b> ledger lines — out of one place, into the
            other. The total on hand does not change, only where it sits. Undo
            moves it straight back.</>
          ) : (
            <><b>Receive</b> books stock in (a delivery, a return to shelf).{" "}
            <b>Issue</b> books it out (sold or taken for a job). Both write a
            ledger line — Undo posts the opposite line, nothing is deleted.</>
          )}
        </div>

        {canMove && (
          <button className="mb-btn s" style={{ width: "100%", marginTop: 14 }}
            onClick={() => { setMoving((v) => !v); setDestId(null); }}>
            {moving ? "← Back to receive / issue" : "Move between locations instead"}
          </button>
        )}
      </div>
      <div className="mb-actions">
        {moving ? (
          <button className="mb-btn p" disabled={locId == null || destId == null}
            onClick={fireMove}>
            Move {n} → {dest?.location_code ?? "…"}
          </button>
        ) : (
          <>
        <button className="mb-btn s" disabled={locId == null}
          onClick={() => fire("receipt", `+${n} ${d.sku} received into ${loc?.location_code ?? ""}`)}>
          + Receive {n}
        </button>
        <button className="mb-btn p" disabled={locId == null}
          onClick={() => fire("sale", `−${n} ${d.sku} issued from ${loc?.location_code ?? ""}`)}>
          − Issue {n}
        </button>
          </>
        )}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   HOTSPOT EDITOR — WEB
   ═══════════════════════════════════════════════════════════════════════════

   Why it exists here: the desktop editor's markers never leave the desktop,
   because the desktop does not yet sync. Ian's markers belong in the cloud,
   which is where this app reads and writes. So the editor lives here.

   The coordinate convention is the desktop's, exactly. x and y are pixels in
   the diagram's own frame; the frame is diagram.img_w/img_h if recorded, else
   the image's natural size; a marker renders at left = x/frame_w * 100%.
   DiagramsView.tsx computes the click the same way. There is one convention.

   The frame IS recorded, the first time a staff member opens the editor on a
   diagram whose img_w/img_h are NULL. That NULL is what made the desktop
   editor fragile: its frame existed only while the image was on screen.

   Deliberately simple: fit-to-width, tap to place, tap a marker to select it,
   drag to move, pick the part by searching. No pinch-zoom in here — the
   viewer has that, and a marker placed at fit-to-width on a 1600 px diagram
   is accurate to a couple of pixels, which is finer than a fingertip. */

type EditorHotspot = WebHotspot & { dirty?: boolean };



// The editor sits on the same canvas as the viewer, so what Ian places is what
// a customer sees: same viewBox, same units, same transform. A drag converts
// the pointer through the SVG's own matrix (CanvasApi.toDrawing) — never
// through a rendered width — and commits on release via the idempotent save.
function HotspotEditor({ path, label, canEdit, onClose, onOpenPart }: {
  path: string; label: string; canEdit: boolean;
  onClose: () => void; onOpenPart: (partId: number) => void;
}) {
  const [diagramId, setDiagramId] = useState<number | null>(null);
  const [frame, setFrame] = useState<Frame | null>(null);
  const [frameFrom, setFrameFrom] = useState<"db" | "image" | null>(null);
  // THE ONE THING THAT WAS NOT SAVED (18 Sep): the item-number field wrote
  // to local state only, and reached the database only if the same marker
  // was later dragged or relinked. Ian typed numbers, pressed Done, and lost
  // them — hotspot 120 on SEC101 sits with item_no NULL where 99 (item 4)
  // was deleted 32 s earlier. Now: the field is pending until written, and
  // it is written on blur, Enter, Done, selecting anything else, or closing.
  const [pendingItem, setPendingItem] = useState<number | null>(null);
  // Ian's "I can't resize": the ring size, one slider, remembered on the device.
  const [markerScale, setMarkerScale] = useState(loadMarkerScale);
  const setScale = (v: number) => { setMarkerScale(v); saveMarkerScale(v); };
  const [hots, setHots] = useState<EditorHotspot[]>([]);
  const hotsRef = useRef<EditorHotspot[]>([]); hotsRef.current = hots;
  const [sel, setSel] = useState<number | null>(null);
  const [placing, setPlacing] = useState<Pt | null>(null);
  const [term, setTerm] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [itemNo, setItemNo] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const canvas = useRef<CanvasApi | null>(null);
  const bind = useCallback((a: CanvasApi) => { canvas.current = a; }, []);
  const dragging = useRef<{ id: number; moved: boolean; pointerId: number } | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await api.listHotspots(path);
      setDiagramId(d.diagram_id);
      setHots(d.hotspots);
      if (d.img_w && d.img_h) { setFrame({ w: d.img_w, h: d.img_h }); setFrameFrom("db"); }
    } catch (e) { setMsg("✕ " + String(e)); }
  }, [path]);
  useEffect(() => { void load(); }, [load]);
  // A tab closed mid-write, or with a number still pending, loses work.
  useEffect(() => {
    if (pendingItem == null && !busy) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [pendingItem, busy]);

  /** No recorded frame: the canvas measured the file. Record it so every
   *  device uses the same units from now on. */
  const onFrame = async (f: Frame) => {
    if (frame) return;
    setFrame(f); setFrameFrom("image");
    if (canEdit && diagramId != null) {
      try { if (await api.setDiagramDims(diagramId, f.w, f.h)) setFrameFrom("db"); }
      catch (err) { console.error("could not persist diagram frame:", err); }
    }
  };

  useEffect(() => {
    if (term.trim().length < 2) { setHits([]); return; }
    let live = true;
    api.searchParts<Hit[]>(term).then((h) => { if (live) setHits(h.slice(0, 8)); }).catch(() => {});
    return () => { live = false; };
  }, [term]);

  const onTap = (p: Pt) => {
    if (!canEdit) return;
    if (pendingItem != null) void saveItemNo(pendingItem);
    setSel(null); setPlacing(p); setTerm(""); setHits([]); setItemNo("");
  };

  const commitNew = async (part: Hit | null) => {
    if (!placing || diagramId == null) return;
    setBusy(true); setMsg("");
    try {
      const uuid = makeUuid();
      const id = await api.saveHotspot({
        clientUuid: uuid, diagramId, x: placing.x, y: placing.y,
        partId: part?.id ?? null, itemNo: itemNo || null,
      });
      setHots((h) => [...h, {
        id, part_id: part?.id ?? null, item_no: itemNo || null,
        x: placing.x, y: placing.y, radius: 58, client_uuid: uuid,
        link: part ? "ok" : "none",
        sku: part?.sku ?? null, name: part?.name ?? null, was_sku: null,
      }]);
      setPlacing(null);
      setMsg(part ? `marker placed on ${part.sku}` : "marker placed, no part linked yet");
    } catch (e) { setMsg("✕ " + String(e)); } finally { setBusy(false); }
  };

  /** Write a marker's item number. Reads the CURRENT row from state (not a
   *  closure), so the value written is the value on screen. */
  const saveItemNo = async (id: number): Promise<boolean> => {
    const h = hotsRef.current.find((x) => x.id === id);
    if (!h || diagramId == null) { setPendingItem(null); return true; }
    setBusy(true);
    try {
      await api.saveHotspot({ clientUuid: h.client_uuid, id: h.id, diagramId, x: h.x, y: h.y, partId: h.part_id, itemNo: h.item_no });
      setPendingItem((p) => (p === id ? null : p));
      setMsg(`✓ item no. ${h.item_no ? `#${h.item_no}` : "cleared"} saved`);
      return true;
    } catch (e) { setMsg("✕ item no. NOT saved: " + String(e)); return false; }
    finally { setBusy(false); }
  };
  /** Anything that leaves the current marker goes through here first. */
  const flushPending = async (): Promise<boolean> => (pendingItem == null ? true : saveItemNo(pendingItem));

  const relink = async (h: EditorHotspot, part: Hit) => {
    if (diagramId == null) return;
    setBusy(true);
    const was = h.link === "ok" ? h.sku : h.link === "retired" ? h.was_sku : null;
    try {
      await api.saveHotspot({ clientUuid: h.client_uuid, id: h.id, diagramId, x: h.x, y: h.y, partId: part.id, itemNo: h.item_no });
      // The card, the list row and the ring all change at once; the photo
      // comes with the hit so the card does not fall back to "no photo".
      setHots((all) => all.map((x) => x.id === h.id ? { ...x, part_id: part.id, sku: part.sku, name: part.name, link: "ok", was_sku: null, image: part.thumb ?? null } : x));
      setPendingItem((p) => (p === h.id ? null : p));   // the write above carried the item no too
      setMsg(`✓ now linked to ${part.sku} — ${part.name}${was && was !== part.sku ? ` (was ${was})` : ""}`);
      setTerm(""); setHits([]);
    } catch (e) { setMsg("✕ relink NOT saved: " + String(e)); } finally { setBusy(false); }
  };

  const remove = async (h: EditorHotspot) => {
    if (!window.confirm(`Remove this marker${h.sku ? ` (${h.sku})` : ""}?`)) return;
    setBusy(true);
    try {
      await api.deleteHotspot(h.id);
      setHots((all) => all.filter((x) => x.id !== h.id)); setSel(null);
    } catch (e) { setMsg("✕ " + String(e)); } finally { setBusy(false); }
  };

  // ── drag to move: pointer → drawing units through the SVG matrix ────────
  // Because the SVG takes pointer capture for the drag, the browser's `click`
  // for this press goes to the SVG, not the marker — so the marker's onClick
  // cannot be the select. The press→release is decided HERE from the pointer
  // we already track: no movement = select (toggle), movement = move. A
  // zero-distance press must never be swallowed as an empty drag.
  const startDrag = (h: EditorHotspot, e: React.PointerEvent<SVGGElement>) => {
    if (!canEdit) return;
    e.stopPropagation();
    canvas.current?.capture(e.pointerId);
    dragging.current = { id: h.id, moved: false, pointerId: e.pointerId };
  };
  const selectMarker = (id: number) => {
    if (pendingItem != null && pendingItem !== id) void saveItemNo(pendingItem);
    setSel((cur) => (cur === id ? null : id)); setPlacing(null); setTerm(""); setHits([]);
  };
  const onDragMove = (e: React.PointerEvent) => {
    const d = dragging.current;
    if (!d || e.pointerId !== d.pointerId) return;
    const p = canvas.current?.toDrawing(e.clientX, e.clientY);
    if (!p) return;
    d.moved = true;
    setHots((all) => all.map((x) => x.id === d.id ? { ...x, x: p.x, y: p.y, dirty: true } : x));
  };
  const endDrag = async () => {
    const d = dragging.current;
    if (!d) return;
    dragging.current = null;
    if (!d.moved) { selectMarker(d.id); return; }
    const h = hots.find((x) => x.id === d.id);
    if (h && diagramId != null) {
      try {
        await api.saveHotspot({ clientUuid: h.client_uuid, id: h.id, diagramId, x: h.x, y: h.y, partId: h.part_id, itemNo: h.item_no });
        setHots((all) => all.map((x) => x.id === h.id ? { ...x, dirty: false } : x));
        setPendingItem((p) => (p === h.id ? null : p));
      } catch (e) { setMsg("✕ move not saved: " + String(e)); void load(); }
    }
  };

  const selected = hots.find((h) => h.id === sel) ?? null;
  const r = markerRadius(frame?.w ?? 0, markerScale);
  const linked = hots.filter((h) => h.link === "ok").length;
  const faulty = hots.filter((h) => h.link === "retired" || h.link === "missing").length;

  // Enter picks the first hit, Escape backs out: with ~136 markers to place,
  // reaching for the mouse after every search is the friction that multiplies.
  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && hits.length > 0) { e.preventDefault(); void (placing ? commitNew(hits[0]) : selected && relink(selected, hits[0])); }
    else if (e.key === "Escape") { setPlacing(null); setSel(null); setTerm(""); setHits([]); }
  };

  // ── the panel: who is selected, what it links to, and the way to fix it ──
  // A side column on a desktop, the bottom strip on a phone (CSS). Always
  // present so the identity of the selection is never off-screen.
  const panel = (
    <div className="mb-hs-panel">
      {selected ? (
        <>
          {/* WHICH marker: its item number, large; and the part it is on. */}
          <div className="mb-hs-id">
            <span className="mb-hs-idno">{selected.item_no ? `#${selected.item_no}` : "#?"}</span>
            <span className="mb-hs-idk">marker · item no. on the drawing{pendingItem === selected.id && <b className="mb-hs-pend"> · item no. not saved yet</b>}</span>
            <span style={{ flex: 1 }} />
            {/* "Done" saved nothing (18 Sep) — it only deselected. Now it
                writes what is pending first, and is labelled for what it does. */}
            <button className={"mb-chip" + (pendingItem === selected.id ? " on" : "")} disabled={busy}
              onClick={async () => { if (await flushPending()) { setSel(null); setTerm(""); setHits([]); } }}>
              {pendingItem === selected.id ? "Save" : "Done"}
            </button>
          </div>
          <div className="mb-hs-card">
            {selected.link === "ok" && selected.image
              ? <img className="mb-thumb" src={assetUrl(selected.image)} alt="" />
              : <div className={"mb-thumb ph" + (selected.link === "ok" ? "" : " bad")}>{selected.link === "ok" ? "no photo" : selected.link === "none" ? "?" : "!"}</div>}
            <div style={{ minWidth: 0, flex: 1 }}>
              {selected.link === "ok" ? (
                <>
                  <div className="mb-hs-sku">{selected.sku}</div>
                  <div className="mb-hs-name">{selected.name}</div>
                </>
              ) : selected.link === "none" ? (
                <>
                  <div className="mb-hs-sku" style={{ color: "var(--dim)" }}>no part linked</div>
                  <div className="mb-hs-name">search below and pick the part this marker sits on</div>
                </>
              ) : (
                <>
                  <div className="mb-hs-sku" style={{ color: "var(--red)" }}>
                    {selected.link === "retired" ? `retired part${selected.was_sku ? ` · was ${selected.was_sku}` : ""}` : `part #${selected.part_id} no longer exists`}
                  </div>
                  <div className="mb-hs-name">search below to relink it</div>
                </>
              )}
              <div className="mb-hs-row" style={{ marginTop: 6 }}>
                {selected.link === "ok" && selected.part_id != null && (
                  <button className="mb-chip on" onClick={() => onOpenPart(selected.part_id!)}>Open part</button>
                )}
                {canEdit && <button className="mb-chip" onClick={() => remove(selected)} disabled={busy}>Remove marker</button>}
              </div>
            </div>
          </div>
        </>
      ) : placing ? (
        <div className="mb-hs-id">
          <span className="mb-hs-idno">+</span>
          <span className="mb-hs-idk">new marker — which part is it on?</span>
          <span style={{ flex: 1 }} />
          <button className="mb-chip" onClick={() => { setPlacing(null); setTerm(""); setHits([]); }}>Cancel</button>
        </div>
      ) : (
        <div className="mb-hs-id">
          <span className="mb-hs-idk">{hots.length} marker{hots.length === 1 ? "" : "s"} · {linked} linked{faulty ? ` · ${faulty} need relinking` : ""}</span>
        </div>
      )}

      {canEdit && (placing || selected) && (
        <>
          <div className="mb-hs-row">
            <input className="mb-hs-in" placeholder={selected ? "link a different part — type a part no. or name…" : "part no. or name…"}
              value={term} onChange={(e) => setTerm(e.target.value)} onKeyDown={onSearchKey} autoFocus />
            <label className="mb-hs-itemlbl">
              <span>item no.</span>
              <input className={"mb-hs-in" + (selected && pendingItem === selected.id ? " pending" : "")} style={{ width: 64, flex: "0 0 auto" }} placeholder="#"
                value={selected ? (selected.item_no ?? "") : itemNo}
                onChange={(e) => {
                  if (selected) { setHots((all) => all.map((x) => x.id === selected.id ? { ...x, item_no: e.target.value || null } : x)); setPendingItem(selected.id); }
                  else setItemNo(e.target.value);
                }}
                onBlur={() => { if (selected && pendingItem === selected.id) void saveItemNo(selected.id); }}
                onKeyDown={(e) => { if (e.key === "Enter" && selected) { e.preventDefault(); void saveItemNo(selected.id); } }} />
            </label>
            {placing && (
              <button className="mb-chip" onClick={() => commitNew(null)} disabled={busy} title="Place it now, link the part later">
                Place unlinked
              </button>
            )}
          </div>
          {hits.length > 0 && (
            <div className="mb-hs-hits">
              {hits.map((p, i) => (
                <button key={p.id} className={"mb-hs-hit" + (i === 0 ? " first" : "")} disabled={busy}
                  onClick={() => placing ? commitNew(p) : selected && relink(selected, p)}>
                  {p.thumb ? <img className="mb-hs-hit-th" src={assetUrl(p.thumb)} alt="" /> : <span className="mb-hs-hit-th ph" />}
                  <span style={{ minWidth: 0 }}>
                    <b>{p.sku}</b>{i === 0 && <span className="mb-hs-enter">↵</span>}
                    <div className="mb-dim" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</div>
                  </span>
                </button>
              ))}
            </div>
          )}
          {term.trim().length >= 2 && hits.length === 0 && <div className="mb-dim" style={{ fontSize: 12 }}>nothing matches "{term}"</div>}
        </>
      )}

      {msg && <div className={"mb-note" + (msg.startsWith("✕") ? " err" : "")} style={{ margin: 0 }}>{msg}</div>}

      {/* Every marker on this drawing, so what is done and what is not is one
          glance, and any marker is reachable without hunting for it. */}
      {hots.length > 0 && !placing && (
        <div className="mb-hs-list">
          <div className="mb-hs-idk" style={{ padding: "6px 0 2px" }}>on this drawing</div>
          {[...hots].sort((a, b) => (parseInt(a.item_no ?? "", 10) || 999) - (parseInt(b.item_no ?? "", 10) || 999) || a.id - b.id).map((h) => (
            <button key={h.id} className={"mb-hs-li" + (h.id === sel ? " on" : "") + (h.link === "ok" ? "" : h.link === "none" ? " unl" : " bad")}
              onClick={() => selectMarker(h.id)}>
              <span className="mb-hs-lino">{h.item_no ?? "·"}</span>
              <span className="mb-hs-litxt">
                {h.link === "ok" ? <><b>{h.sku}</b> <span className="mb-dim">{h.name}</span></>
                  : h.link === "none" ? <span className="mb-dim">not linked yet</span>
                  : <span style={{ color: "var(--red)" }}>{h.link === "retired" ? `retired${h.was_sku ? ` · was ${h.was_sku}` : ""}` : "part missing"}</span>}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <div className="mb-lb mb-hs-ed">
      <div className="mb-lb-head">
        <button className="mb-back" title={pendingItem != null ? "saves the item number, then closes" : "close"}
          onClick={async () => { if (await flushPending()) onClose(); }}>✕</button>
        <span className="mb-lb-cap">{label} · {canEdit ? "editing markers" : "markers"}</span>
        {canEdit && <span className="mb-dim" style={{ fontSize: 12 }}>tap the drawing to place · tap a ring to pick · drag to move · wheel or pinch to zoom{frame && frameFrom === "image" ? " · frame recorded from the image" : ""}</span>}
        {canEdit && (
          <label className="mb-hs-size" title="Ring size on every drawing, remembered on this device">
            <span>ring size</span>
            <input type="range" min={MARKER_SCALE_MIN} max={MARKER_SCALE_MAX} step={0.1} value={markerScale}
              onChange={(e) => setScale(Number(e.target.value))} />
            <b>{Math.round(markerScale * 100)}%</b>
          </label>
        )}
      </div>

      <div className="mb-hs-body">
        {/* The drag handlers live on the stage (capture is on the SVG, so the
            moves arrive here regardless of where the pointer wanders). */}
        <div className="mb-hs-stage dg-host" onPointerMove={onDragMove} onPointerUp={endDrag} onPointerCancel={endDrag}>
          <DiagramCanvas href={assetUrl(path)} frame={frame} onFrame={onFrame} onTap={onTap} bind={bind}>
            {hots.map((h) => (
              <Marker key={h.id} x={h.x} y={h.y} r={r}
                state={h.id === sel ? "sel" : h.dirty || h.id === pendingItem ? "dirty" : markerState(h)}
                title={markerTitle(h)}
                onPointerDown={(e) => startDrag(h, e)}
                // canEdit: the select happens in endDrag (the SVG held capture,
                // so no click reaches here). Read-only: no capture was taken,
                // the click arrives, and a live part opens.
                onClick={(e) => {
                  e.stopPropagation();
                  if (!canEdit && h.link === "ok" && h.part_id != null) onOpenPart(h.part_id);
                }} />
            ))}
            {placing && <Marker x={placing.x} y={placing.y} r={r} state="new" title="new marker" />}
          </DiagramCanvas>
        </div>
        {panel}
      </div>
    </div>
  );
}
