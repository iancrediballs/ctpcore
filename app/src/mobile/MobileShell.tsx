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
import { useQuery, useStatus } from "@powersync/react";
import * as api from "../data/api";
import { refreshZohoStatus, zohoStatusLabel, syncSalesOrder, syncEstimate, recreateEstimate, overrideFulfilGate, fulfilBlockReason, setCustomerOnAccount,
         shipInZoho, countToZoho, openPurchaseOrders, receiveInZoho, type OpenPO,
         acceptPrecheck, uploadPo, poFileUrl, orderPrices, myPrices, type OrderPrices, type LinePrice,
         remoteBookPrices, bookLabel, type BookPrice, type BookCustomer } from "../data/zoho";
import AddCustomer from "../admin/AddCustomer";
import { assetUrl, photoWebUrl } from "../assets";
import { DiagramCanvas, Marker, loadMarkerScale, saveMarkerScale, markerRadius, MARKER_SCALE_MIN, MARKER_SCALE_MAX, type CanvasApi, type Frame, type Pt } from "./DiagramCanvas";
import { DiagramView, readDiagramHash, type Drawing } from "./DiagramView";
import { withTimeout, TimeoutError } from "../data/timeout";
import { markerState, markerTitle } from "./hotspotState";
import type { DiagramPart } from "../data/api";
import { makeUuid } from "../data/uuid";
import { buildDocHTML, openPrintWindow, type DocCompany, type DocOrder } from "../invoiceDoc";
import { ShelfRefusedError } from "../data/errors";
import type { WebHotspot } from "../data/api";
import { useAuth, type Role } from "../auth/AuthProvider";
import SettingsView from "../admin/SettingsView";
import { supabase } from "../sync/supabase";
import {
  applyFilter, customerKey, isFiltering, loadFilter, saveFilter, EMPTY_FILTER, RANGE_LABEL, STAGE_LABEL,
  type OrderFilter, type Range, type StageKey,
} from "./orderFilter";
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
  /** 0047: of qty_on_hand, units held for accepted orders (staff devices only). */
  qty_held?: number;
  // 0050: the one stock fact a customer gets. null = not synced yet (unknown).
  in_stock?: boolean | null;
  image?: string | null;
  // 0074: catalogue fields — make (Zoho Manufacturer), model (Brand), OEM / Aftermarket, supplier (staff)
  make?: string | null; model?: string | null; part_type?: string | null; supplier?: string | null;
};

type Hit = {
  id: number; sku: string; name: string; brand: string | null;
  on_hand: number; held?: number; in_stock?: boolean | null; price_cents: number | null; matched_on: string;
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
  make?: string | null; model?: string | null; part_type?: string | null; supplier?: string | null;   // 0074
  category_name: string | null; drawing_no: string | null; notes: string | null;
  price_cents: number | null; total_on_hand: number; in_stock?: boolean | null;
  stock: StockLine[]; ledger: LedgerLine[];
  images: { id: number; path: string; is_primary: boolean }[];
  diagram_image: string | null; diagram_item: string | null;
  // 0065: Zoho Inventory's physical stock for this part (staff; null until synced)
  zoho_stock?: { on_hand: number; available: number | null; committed: number | null; at: string | null } | null;
  // CAT-5: cross-references and vehicle fitment
  xrefs?: { type: string; number: string; brand: string | null }[];
  fitment?: { make: string | null; model: string | null; variant: string | null; engine: string | null;
    year_from: number | null; year_to: number | null; note: string | null }[];
};

type Toast = { text: string; err?: boolean; undo?: () => void };

type MyLine = {
  id: number; part_id: number; qty: number; unit_price_minor: number | null;
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
  zoho_invoice_number?: string | null; zoho_status?: string | null;
  zoho_status_at?: string | null; zoho_error?: string | null;
  // 0047/0054: the Zoho Books sales order raised when the customer accepted, and its own status
  zoho_salesorder_number?: string | null; zoho_so_status?: string | null; zoho_so_error?: string | null;
  client_response: string | null; client_responded_at: string | null;
  // 0059: Michelle's side of the sales order (read back from Zoho), the fulfil gate, account terms
  zoho_salesorder_id?: string | null; zoho_so_emailed?: boolean; zoho_so_synced_at?: string | null;
  zoho_so_terms_label?: string | null; zoho_so_terms_days?: number | null; zoho_so_readback_issue?: string | null;
  fulfil_override_at?: string | null; fulfil_override_note?: string | null; accepted_note?: string | null;
  cust_terms_label?: string | null; cust_terms_days?: number | null; cust_outstanding_minor?: number | null;
  cust_credit_limit_minor?: number | null; cust_unused_credit_minor?: number | null;
  // 0061: accounts' Zoho invoice for this order, its payments; account vs cash
  customer_id?: number | null; cust_on_account?: boolean; zoho_invoice_id?: string | null;
  zoho_invoice_total_minor?: number | null; zoho_invoice_balance_minor?: number | null; zoho_invoice_paid_minor?: number | null;
  zoho_invoice_payments?: string | null; zoho_invoice_count?: number | null;
  // 0062: the quote's Zoho estimate (Phase 2)
  zoho_estimate_id?: string | null; zoho_estimate_number?: string | null;
  zoho_estimate_status?: string | null; zoho_estimate_error?: string | null;
  zoho_estimate_total_minor?: number | null; zoho_estimate_expiry?: string | null;
  staff_log?: string | null;   // 0067: internal history, staff only
  po_number?: string | null; po_file_path?: string | null; po_file_name?: string | null; credit_warning?: string | null;   // 0070
  timeline?: { at: string; kind: string; label: string; by: string; detail?: Record<string, unknown> }[];   // 0068
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

// ─── the basket, kept on the device ─────────────────────────────────────────
//
// Ian, 23 Oct 2026: the basket survives a reload. localStorage, per signed-in
// person, so two people sharing a counter PC never see each other's basket.
// Nothing here is authoritative: sending still goes through the same RPCs.
type CartItem = { id: number; sku: string; name: string; qty: number };
type SavedCart = { cart: CartItem[]; note: string; counterCustomer: number | null };
const cartKey = (uid: string | undefined) => "ctp-cart.v1:" + (uid ?? "anon");
function loadCart(key: string): SavedCart {
  const empty: SavedCart = { cart: [], note: "", counterCustomer: null };
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return empty;
    const v = JSON.parse(raw) as Partial<SavedCart>;
    const cart = (Array.isArray(v.cart) ? v.cart : [])
      .filter((c): c is CartItem => !!c && Number.isInteger(c.id) && typeof c.sku === "string"
        && typeof c.name === "string" && Number.isInteger(c.qty) && c.qty > 0)
      .map((c) => ({ id: c.id, sku: c.sku, name: c.name, qty: Math.min(999, c.qty) }));
    return {
      cart,
      note: typeof v.note === "string" ? v.note.slice(0, 2000) : "",
      counterCustomer: Number.isInteger(v.counterCustomer) ? (v.counterCustomer as number) : null,
    };
  } catch { return empty; }
}

/** The header basket. Counts QUANTITY, not lines: each "Add to order" tap is
 *  +1, so the number moves with every tap. `bump` changes on every increase
 *  and re-keys the badge, which replays its pop. */
function CartButton({ count, bump, label, onOpen }: {
  count: number; bump: number; label: string; onOpen: () => void;
}) {
  return (
    <button type="button" className={"mb-cartbtn" + (count > 0 ? " has" : "")} onClick={onOpen}
      aria-label={`${label}: ${count} item${count === 1 ? "" : "s"}`} title={label}>
      <TabCart />
      {count > 0 && (
        <span key={bump} className={"mb-cartbdg" + (bump > 0 ? " bump" : "")}>{count > 99 ? "99+" : count}</span>
      )}
    </button>
  );
}

/** 0076: a part's rebate — list struck through, then the book price, its −% and whose it is. */
type Rebate = { book_minor: number; list_minor: number | null; label: string };
function RebateTag({ r, big }: { r: Rebate | null; big?: boolean }) {
  if (!r) return null;
  const off = r.list_minor != null && r.book_minor < r.list_minor ? Math.round((1 - r.book_minor / r.list_minor) * 1000) / 10 : null;
  return (
    <span className={"mb-rebate" + (big ? " big" : "")}>
      {off != null && <s className="mb-was">{fmtR(r.list_minor)}</s>}
      <b>{fmtR(r.book_minor)}</b>{off != null ? ` −${off}%` : ""}
      <span className="mb-rlabel">{r.label}</span>
    </span>
  );
}

/** 0077: one line under an order card's total — "rebate −R 1 234" and/or "R 567 above rebate". */
function RebateSum({ r }: { r: { saving: number; over: number } | null }) {
  if (!r || (r.saving <= 0 && r.over <= 0)) return null;
  return (
    <div className="mb-csku mb-rbsum">
      {r.saving > 0 && <>rebate −{fmtR(r.saving)}</>}
      {r.saving > 0 && r.over > 0 && " · "}
      {r.over > 0 && <span className="over">{fmtR(r.over)} above rebate</span>}
    </div>
  );
}

// ─── the shell ───────────────────────────────────────────────────────────────

/** 0072: one line's price, book-aware. Customers: ~~list~~ their price. Staff also see cost,
 *  margin (R and %) and the 0041 floor, coloured against it. */
function PriceInfo({ lp, priceMinor, qty, staff, known }: { lp?: LinePrice; priceMinor: number; qty: number; staff: boolean;
  /** The server's order_prices has answered, so a missing list price is a fact, not "still loading". */
  known?: boolean }) {
  if (!lp) return null;
  // CAT-1: a list of 0 is "never priced in Zoho", not "free". Treated as no list price.
  const list = lp.list_minor != null && lp.list_minor > 0 ? lp.list_minor : null, book = lp.book_minor ?? null;
  const pct = list && book != null && book < list ? Math.round((1 - book / list) * 1000) / 10 : null;
  const cost = staff ? lp.cost_minor ?? null : null, floor = staff ? lp.floor_minor ?? null : null;
  const m = cost != null && priceMinor > 0 ? priceMinor - cost : null;
  const mPct = m != null ? Math.round((m / priceMinor) * 1000) / 10 : null;
  const cls = floor == null || priceMinor <= 0 ? "" : priceMinor < floor ? " bad" : priceMinor < floor * 1.05 ? " warn" : " ok";
  return (
    <div className="mb-pinfo">
      {list != null && book != null && book < list
        ? <span><s>{fmtR(list)}</s> <b>{fmtR(book)}</b> each · −{pct}% rebate</span>
        : staff && list != null ? <span>List {fmtR(list)} each</span>
        : staff && (known || lp.list_minor === 0) ? <span className="mb-dim">No list price</span> : null}
      {staff && book != null && priceMinor > 0 && (priceMinor > book
        ? <span className="mb-pm warn">{fmtR((priceMinor - book) * qty)} above the rebate price</span>
        : list != null && priceMinor < list ? <span className="mb-pm ok">saves {fmtR((list - priceMinor) * qty)} vs list</span> : null)}
      {staff && cost != null && (
        <span className={"mb-pm" + cls}>
          Cost {fmtR(cost)}{m != null ? ` · margin ${fmtR(m * qty)} (${mPct}%)` : ""}{floor != null ? ` · floor ${fmtR(floor)}` : ""}
        </span>
      )}
    </div>
  );
}

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
  // 0074: Find filters — Make / Model / Type, and Supplier for staff
  const [catF, setCatF] = useState<{ make: string; model: string; part_type: string; supplier: string }>({ make: "", model: "", part_type: "", supplier: "" });
  const [detail, setDetail] = useState<Detail | null>(null);
  // Which photo the part sheet is showing. Only visible as a carousel when the
  // part has more than one (Ian, 2026-09-25); reset whenever the sheet changes
  // part, or photo 3 of the last part becomes photo 3 of a part with two.
  const [shot, setShot] = useState(0);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [counterOpen, setCounterOpen] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [viewer, setViewer] = useState<{ items: { path: string; label: string; diagram?: boolean }[]; idx: number } | null>(null);
  const basketKey = cartKey(session?.user.id);
  const [saved] = useState(() => loadCart(basketKey));
  const [cart, setCart] = useState<CartItem[]>(saved.cart);
  const [note, setNote] = useState(saved.note);
  const [sending, setSending] = useState(false);
  // 0053 — counter sales. The cart is shared with the customer flow; these two
  // say who a STAFF cart is being raised for.
  const [customers, setCustomers] = useState<{ id: number; name: string }[]>([]);
  const [counterCustomer, setCounterCustomer] = useState<number | null>(saved.counterCustomer);
  useEffect(() => {
    try {
      if (cart.length === 0 && !note && counterCustomer == null) localStorage.removeItem(basketKey);
      else localStorage.setItem(basketKey, JSON.stringify({ cart, note, counterCustomer } satisfies SavedCart));
    } catch { /* private mode: the basket lives for this page only */ }
  }, [basketKey, cart, note, counterCustomer]);
  const cartCount = useMemo(() => cart.reduce((t, c) => t + c.qty, 0), [cart]);
  const [cartBump, setCartBump] = useState(0);
  const lastCount = useRef(cartCount);
  useEffect(() => {
    if (cartCount > lastCount.current) setCartBump((b) => b + 1);
    lastCount.current = cartCount;
  }, [cartCount]);
  // ── order desk filters (staff), remembered for the session ──
  const [ofilter, setOfilterRaw] = useState<OrderFilter>(loadFilter);
  const setOfilter = useCallback((f: OrderFilter | ((p: OrderFilter) => OrderFilter)) => {
    setOfilterRaw((p) => { const n = typeof f === "function" ? f(p) : f; saveFilter(n); return n; });
  }, []);
  const [filtersOpen, setFiltersOpen] = useState(false);
  // 0056: the customer list includes every synced Zoho customer, so it is searchable
  const [counterFind, setCounterFind] = useState("");
  const [addingCustomer, setAddingCustomer] = useState(false);   // Phase 1: Zoho-first add customer
  const [audit, setAudit] = useState<{ table: string; rows: number }[] | null>(null);
  const [mine, setMine] = useState<MyRequest[] | null>(null);
  // 0072: their own quotes, book-aware (list struck through + their price); never cost
  const [minePrices, setMinePrices] = useState<Record<number, OrderPrices>>({});
  // 0072: the part sheet — a customer on a price book sees list struck through + their price
  const [myPrice, setMyPrice] = useState<{ part_id: number; list_minor: number | null; book_minor: number } | null>(null);
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
  // 0072: book-aware prices of the open order (staff: + cost / margin / floor)
  const [prices, setPrices] = useState<Record<number, OrderPrices>>({});
  useEffect(() => {
    if (openOrder == null) return;
    let live = true;
    void orderPrices(openOrder).then((p) => { if (live && p) setPrices((x) => ({ ...x, [openOrder]: p })); });
    return () => { live = false; };
  }, [openOrder]);
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

  // ── version (24 Oct): shown in Info and Settings; a newer deploy offers a reload ──
  const [newVersion, setNewVersion] = useState(false);
  useEffect(() => {
    const h = () => setNewVersion(true);
    window.addEventListener("ctp-new-version", h);
    return () => window.removeEventListener("ctp-new-version", h);
  }, []);

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

  // ── 0076: price books (Zoho's rebate rates) on the device ──
  // Staff hold every book (ctp_staff); a customer holds only their own (ctp_client_book). Until
  // those streams are deployed, or while a first sync runs, the same rows are read online once.
  const { data: bookLocal } = useQuery<BookPrice>(
    `SELECT i.pricebook_id, b.name, CAST(i.part_id AS INTEGER) AS part_id, i.rate_minor AS book_minor, i.list_minor
       FROM price_book_item i LEFT JOIN price_book b ON b.id = i.pricebook_id
      WHERE i.part_id IS NOT NULL`);
  const { data: bookCustLocal } = useQuery<BookCustomer>(
    `SELECT CAST(id AS INTEGER) AS id, name, zoho_pricebook_id AS book FROM customer
      WHERE zoho_pricebook_id IS NOT NULL AND deleted_at IS NULL`);
  const [bookRemote, setBookRemote] = useState<{ rows: BookPrice[]; customers: BookCustomer[] } | null>(null);
  const uid = session?.user?.id;
  useEffect(() => {
    if (!uid) return;
    let live = true;
    void remoteBookPrices(isClient).then((r) => { if (live) setBookRemote(r); });
    return () => { live = false; };
  }, [uid, isClient]);
  const book = useMemo(() => {
    const rows = bookLocal.length ? bookLocal : bookRemote?.rows ?? [];
    const customers = bookCustLocal.length ? bookCustLocal : bookRemote?.customers ?? [];
    const byPart = new Map<number, BookPrice[]>();
    for (const r0 of rows) {
      // CAT-1: list 0 = never priced; no strikethrough, no "-100%" against it
      const r = r0.list_minor != null && r0.list_minor <= 0 ? { ...r0, list_minor: null } : r0;
      const k = Number(r.part_id); byPart.set(k, [...(byPart.get(k) ?? []), r]);
    }
    return { byPart, customers };
  }, [bookLocal, bookCustLocal, bookRemote]);
  // Whose prices staff are looking at: the counter sale's customer, else the open order's.
  const ctxCustomer = isClient ? null : (counterCustomer ?? orders?.find((o) => o.id === openOrder)?.customer_id ?? null);
  /** The rebate to show for a part. A customer: their own book. Staff: the given customer's book
   *  (`who`), else the context customer's, else (no customer picked) the book labelled with its
   *  owner ("Hermans rebate"). A customer with no book gets nothing. */
  const rebateFor = useCallback((partId: number, who?: { customerId: number | null }): Rebate | null => {
    const rows = book.byPart.get(Number(partId)) ?? [];
    if (!rows.length) return null;
    if (isClient) return { book_minor: rows[0].book_minor, list_minor: rows[0].list_minor, label: "your price" };
    const cid = who ? who.customerId : ctxCustomer;
    if (cid != null) {
      const c = book.customers.find((x) => x.id === Number(cid));
      const r = c && rows.find((x) => x.pricebook_id === c.book);
      return c && r ? { book_minor: r.book_minor, list_minor: r.list_minor, label: `${c.name.split(/\s+/)[0]} rebate` } : null;
    }
    if (who) return null;
    return { book_minor: rows[0].book_minor, list_minor: rows[0].list_minor, label: bookLabel(rows[0].pricebook_id, book.customers, rows[0].name) };
  }, [book, isClient, ctxCustomer]);
  /** An order line's prices: the server's (list, book, cost, floor), with the on-device book
   *  filling any gap so the rebate shows even before order_prices answers. */
  const lpFor = useCallback((o: { id: number; customer_id?: number | null }, l: { id: number; part_id: number }): LinePrice => {
    const lp = prices[o.id]?.lines.find((x) => x.line_id === l.id);
    const rb = rebateFor(l.part_id, { customerId: o.customer_id ?? null });
    return { line_id: l.id, part_id: l.part_id, ...lp,
      book_minor: lp?.book_minor ?? rb?.book_minor, list_minor: lp?.list_minor ?? rb?.list_minor ?? undefined };
  }, [prices, rebateFor]);
  /** 0077: an order's rebate at a glance, over the lines on the customer's book: their list
   *  value, what they are priced at (an unpriced line counts at the rebate price), the saving,
   *  and — staff — how much sits above the rebate price. null when no line is on a book. */
  const orderRebate = useCallback((o: { id: number; status: string; customer_id?: number | null;
      lines: { id: number; part_id: number; qty: number; unit_price_minor: number | null }[] }) => {
    let list = 0, at = 0, over = 0, n = 0;
    for (const l of o.lines) {
      const lp = isClient ? rebateFor(l.part_id) : lpFor(o, l);
      if (!lp || lp.book_minor == null || lp.list_minor == null) continue;
      // Only a quote's empty price box means "will go at the rebate"; a R0 line on a settled order was free.
      if ((l.unit_price_minor ?? 0) <= 0 && o.status !== "quote") continue;
      const price = (l.unit_price_minor ?? 0) > 0 ? (l.unit_price_minor as number) : lp.book_minor;
      n++; list += lp.list_minor * l.qty; at += price * l.qty;
      if (price > lp.book_minor) over += (price - lp.book_minor) * l.qty;
    }
    return n ? { n, list, at, saving: Math.max(0, list - at), over } : null;
  }, [isClient, rebateFor, lpFor]);
  /** What an unpriced line's price box starts at: the customer's rebate price, if they have one. */
  const defaultMinor = useCallback((o: StaffOrder, l: StaffOrder["lines"][number]) =>
    l.unit_price_minor > 0 ? l.unit_price_minor : (lpFor(o, l).book_minor ?? 0), [lpFor]);

  // ── data loads (all local SQLite via PowerSync — cheap to re-run) ──
  const refresh = useCallback(() => {
    api.listParts<PartRow[]>().then(setParts).catch(console.error);
    api.listSections<Section[]>().then(setSections).catch(console.error);
    // CAT-2: categories too. On a fresh sign-in the mount-time read ran before the first
    // sync landed, so the Find chips stayed at "All" until a reload.
    api.listCategories<Cat[]>().then(setCats).catch(console.error);
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

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

  const openSeq = useRef(0);
  const openPart = useCallback(async (partId: number) => {
    // CAT-15: the latest tap wins (a slow earlier read must not replace it), and a read that
    // never answers says so instead of leaving "Open" looking dead.
    const seq = ++openSeq.current;
    try {
      const d = await withTimeout(api.partDetail<Detail>(partId), 12000, "the part sheet (device database)");
      if (seq !== openSeq.current) return;
      setDetail(d);
      setShot(0);                       // a new part starts on its primary photo
      setSheetOpen(true);
      setCounterOpen(false);
    } catch (e) {
      console.error(e);
      if (seq !== openSeq.current) return;
      showToast({ text: e instanceof TimeoutError
        ? "That part is taking too long to load. Try again; if it keeps happening, reload the app."
        : "Could not open that part.", err: true });
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
  // Read Zoho's status back when the desk opens (throttled server-side to every
  // 2 minutes), so "Draft — awaiting accountant" turns into "Sent" once the
  // accountant approves it. The new status arrives through sync like any other
  // order change; a failure here is logged server-side and never blocks the desk.
  useEffect(() => {
    if (isClient) return;
    refreshZohoStatus().then((r) => { if (r.changed > 0) loadOrders(); });
  }, [isClient, loadOrders]);

  // 0063: are quotes Zoho estimates? (staff can read zoho_config; customers cannot)
  const [estimatesOn, setEstimatesOn] = useState(false);
  // 0065: who holds the stock — 'ctp' (rehearsal default) or 'zoho' (Inventory: ship / count / receive in Zoho)
  const [stockMaster, setStockMaster] = useState<"ctp" | "zoho">("ctp");
  useEffect(() => {
    if (isClient) return;
    void supabase.from("zoho_config").select("estimates_enabled, stock_master").eq("id", 1).maybeSingle()
      .then(({ data }) => { setEstimatesOn(!!data?.estimates_enabled); setStockMaster(data?.stock_master === "zoho" ? "zoho" : "ctp"); });
  }, [isClient, lastSynced]);
  const zohoStock = stockMaster === "zoho";
  const [countVal, setCountVal] = useState("");
  const [receiving, setReceiving] = useState<OpenPO[] | null>(null);
  const [rcvQty, setRcvQty] = useState<Record<string, string>>({});
  const [rcvBusy, setRcvBusy] = useState(false);

  // 0053 — the customer list for counter sales. Staff only, and read from the
  // local mirror, so it costs nothing to refresh whenever sync moves.
  useEffect(() => {
    if (isClient) { setCustomers([]); return; }
    api.staffCustomers<{ id: number; name: string }[]>()
      .then(setCustomers)
      .catch((e) => { console.error(e); setCustomers([]); });
  }, [isClient, lastSynced]);

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
        ? defaultMinor(o, l) / 100      // 0076: an unpriced line goes at the customer's rebate price
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
      // 0062: fully priced → its draft Zoho estimate (skipped until the switch is on)
      if (left === 0) {   // 24 Oct: warnings are advisory — the estimate is still created
        void syncEstimate(o.id).then((r) => {
          if (r.skipped) return;
          if (!r.ok) showToast({ text: `Quote saved, but the Zoho estimate failed: ${r.message ?? "unknown error"}`, err: true });
          else if (r.message) showToast({ text: r.message, err: true });
          else loadOrders();
        });
      }
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
  }, [draftPrices, showToast, loadOrders, defaultMinor]);

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

  /** 0058: admin accepts for a customer who confirmed by phone/email. Same path
   *  as the customer's accept (confirmed Zoho sales order + stock hold); the
   *  admin and the note are recorded on the order. */
  const [behalf, setBehalf] = useState<{ order: StaffOrder; note: string; po: string; file: File | null;
    need: boolean | null; credit: string | null } | null>(null);
  // 0070: what accepting needs (PO file per setting) and the credit warning, read when the dialog opens
  const openBehalf = useCallback((o: StaffOrder) => {
    setBehalf({ order: o, note: "", po: "", file: null, need: null, credit: null });
    void acceptPrecheck(o.id, true).then((c) => setBehalf((b) => b && b.order.id === o.id
      ? { ...b, need: c ? c.po_file_required : false, credit: c?.credit?.staff ?? null } : b));
  }, []);
  const acceptOnBehalf = useCallback(async (o: StaffOrder, note: string, poNo: string, file: File | null) => {
    // the old prefill ("Confirmed by  via phone") was saved once with no name in it
    if (!/\w{2,}/.test(note.replace(/\b(confirmed|by|via|phone|email|e-mail)\b/gi, ""))) {
      showToast({ text: "Say who confirmed it, e.g. \"Confirmed by Denver via phone\".", err: true });
      return;
    }
    setSavingOrder(true);
    try {
      const path = file && o.customer_id ? await uploadPo(o.customer_id, o.id, file) : null;
      const r = await api.acceptQuoteOnBehalf(o.id, note, { po_number: poNo, po_file: path, po_file_name: file?.name ?? null });
      showToast({ text: r?.already
        ? `${o.number} was already accepted — nothing changed.`
        : `${o.number} accepted for ${o.customer_name} · PO ${poNo}${r?.zoho_salesorder_number ? ` · Zoho sales order ${r.zoho_salesorder_number}` : ""} · ${r?.reserved_lines ?? 0} line${(r?.reserved_lines ?? 0) === 1 ? "" : "s"} held.`
          + (r?.credit_warning ? ` ⚠ ${r.credit_warning}` : "") + (r?.attach_warning ? ` ⚠ ${r.attach_warning}` : ""), err: !!r?.attach_warning });
      loadOrders();
    } catch (e) { showToast({ text: e instanceof Error ? e.message.replace(/^\[CTP web\] could not accept: /, "") : "Could not accept.", err: true }); }
    finally { setSavingOrder(false); }
  }, [showToast, loadOrders]);

  /** 0059: admin lets an order go out before accounts have sent the Zoho SO. */
  const releaseForFulfil = useCallback(async (o: StaffOrder) => {
    const note = window.prompt(`Release ${o.number} for fulfilment before accounts have sent the Zoho sales order?\nWhy? e.g. "Michelle confirmed by phone, customer collecting"`, "");
    if (note == null) return;
    setSavingOrder(true);
    try {
      await overrideFulfilGate(o.id, note);
      showToast({ text: `${o.number} released for fulfilment — recorded on the order.` });
      loadOrders();
    } catch (e) { showToast({ text: e instanceof Error ? e.message : "Could not release it.", err: true }); }
    finally { setSavingOrder(false); }
  }, [showToast, loadOrders]);

  /** 0059: opening an accepted order reads its Zoho sales order back first, so
   *  Michelle's prices and "sent" show before anyone fulfils. */
  const [syncingSo, setSyncingSo] = useState<number | null>(null);
  const syncOrderFromZoho = useCallback(async (o: StaffOrder, force = false) => {
    const soSide = !!o.zoho_salesorder_id && ["to_pick", "fulfilled"].includes(o.stage);
    const estSide = !!o.zoho_estimate_id && o.status === "quote";   // 0063: Zoho leads the quote
    if (!soSide && !estSide) return;
    setSyncingSo(o.id);
    const r = await syncSalesOrder(o.id, force);
    setSyncingSo(null);
    if (r.changes.length) showToast({ text: `${o.number}: Zoho changes applied — ${r.changes.join("; ")}` });
    else if (force && !r.ok) showToast({ text: `Could not read Zoho: ${r.message ?? "unknown error"}`, err: true });
    loadOrders();
    // 24 Oct: the server has applied Zoho's latest; the change reaches this phone through sync a
    // moment later. Re-read twice so ONE tap of Refresh shows it (Ian's demo needed two).
    window.setTimeout(loadOrders, 1500);
    window.setTimeout(loadOrders, 4000);
  }, [showToast, loadOrders]);

  /** 0061: admin flips a customer between account (fulfil after invoice) and cash (after payment). */
  const toggleAccount = useCallback(async (o: StaffOrder) => {
    if (!o.customer_id) return;
    const to = !o.cust_on_account;
    if (!window.confirm(`${o.customer_name}: set to ${to ? "ACCOUNT — goods can go out once accounts invoice in Zoho" : "CASH — goods go out only once the Zoho invoice is paid"}?`)) return;
    setSavingOrder(true);
    try { await setCustomerOnAccount(o.customer_id, to); showToast({ text: `${o.customer_name} is now ${to ? "an account" : "a cash"} customer.` }); loadOrders(); }
    catch (e) { showToast({ text: e instanceof Error ? e.message : "Could not change it.", err: true }); }
    finally { setSavingOrder(false); }
  }, [showToast, loadOrders]);

  /** 0059/0061: what accounts have done in Zoho — sales order, invoice, payment —
   *  and the customer's terms. Shown before and after goods out. */
  const zohoAccountsRows = (o: StaffOrder) => (
    <>
      {o.zoho_salesorder_id && (
        <div className="mb-row">
          <span className="mb-rk">Accounts</span>
          <span className="mb-rv">
            {o.zoho_salesorder_number} {zohoStatusLabel(o.zoho_so_status, "salesorder").text}
            {o.zoho_so_emailed ? <> · <span style={{ color: "var(--green)" }}>sent to the customer</span></> : null}
            {" · "}{o.zoho_invoice_id
              ? <>invoice <b className="mb-mono">{o.zoho_invoice_number}</b> {zohoStatusLabel(o.zoho_status ?? "draft", "invoice").text}
                  {o.zoho_invoice_total_minor != null ? <> · {fmtR(o.zoho_invoice_total_minor)}</> : null}
                  {(o.zoho_invoice_paid_minor ?? 0) > 0 ? <> · paid {fmtR(o.zoho_invoice_paid_minor ?? 0)}</> : null}
                  {o.zoho_invoice_balance_minor != null ? <> · balance {fmtR(o.zoho_invoice_balance_minor)}</> : null}
                  {o.zoho_invoice_payments ? <> · payments: {o.zoho_invoice_payments}</> : null}</>
              : <span style={{ color: "var(--amber)" }}>not invoiced yet</span>}
            {o.zoho_so_synced_at ? <> · read {timeAgo(o.zoho_so_synced_at)}</> : null}
            {" · "}<button className="mb-chip" disabled={syncingSo === o.id}
              onClick={() => { void syncOrderFromZoho(o, true); }}>{syncingSo === o.id ? "Reading Zoho…" : "Refresh"}</button>
          </span>
        </div>
      )}
      <div className="mb-row">
        <span className="mb-rk">Customer</span>
        <span className="mb-rv">
          {o.cust_on_account
            ? <>on account — goods out once accounts invoice in Zoho</>
            : <>cash — goods out once the Zoho invoice is paid</>}
          {o.cust_terms_label ? <> · Zoho terms {o.cust_terms_label}</> : null}
          {o.cust_outstanding_minor != null ? <> · outstanding {fmtR(o.cust_outstanding_minor)}</> : null}
          {o.cust_credit_limit_minor != null ? <> · credit limit {fmtR(o.cust_credit_limit_minor)}</> : null}
          {o.cust_unused_credit_minor ? <> · credit {fmtR(o.cust_unused_credit_minor)}</> : null}
          {role === "admin" && o.customer_id ? <> · <button className="mb-chip" disabled={savingOrder}
            onClick={() => { void toggleAccount(o); }}>{o.cust_on_account ? "Make cash…" : "Make account…"}</button></> : null}
        </span>
      </div>
    </>
  );

  const fulfilOrder = useCallback(async (o: StaffOrder) => {
    setSavingOrder(true);
    if (zohoStock) {   // 0065: package + shipment in Zoho Inventory; CTP records goods out (no CTP sale)
      const r = await shipInZoho(o.id);
      setSavingOrder(false);
      showToast(r.ok ? { text: r.data.already ? `${o.number} was already shipped (${r.data.shipment_number}).`
                          : `${o.number} shipped in Zoho: package ${r.data.package_number}, shipment ${r.data.shipment_number} (${r.data.shipment_status}).` }
                     : { text: r.message, err: true });
      loadOrders();
      return;
    }
    try {
      const r = await api.fulfilOrder<{ movements: number; already: boolean }>(o.id);
      let zohoNote = "";
      if (o.zoho_salesorder_id) {
        // 24 Oct: CTP mode — mirror the goods-out in Zoho Inventory (package + shipment) so its physical
        // stock moves too; Zoho's accounting stock moves with the invoice. Never a second CTP movement.
        const z = await shipInZoho(o.id, true);
        zohoNote = z.ok ? ` Zoho: package ${z.data.package_number}, shipment ${z.data.shipment_number}.` : ` Zoho shipment not created: ${z.message}`;
      }
      showToast({ text: (r?.already
        ? `${o.number} was already fulfilled — nothing changed.`
        : `${o.number} fulfilled: ${r?.movements ?? 0} line${(r?.movements ?? 0) === 1 ? "" : "s"} taken out of stock.`) + zohoNote,
        err: zohoNote.startsWith(" Zoho shipment not created") });
      loadOrders();
    } catch (e) {
      const msg = e instanceof Error ? e.message.replace(/^\[CTP web\] could not fulfil: /, "") : "Could not fulfil.";
      showToast({ text: msg, err: true });
    } finally { setSavingOrder(false); }
  }, [showToast, loadOrders, zohoStock]);

  /** Issue the tax invoice: the database allocates the number now. */
  const invoiceOrder = useCallback(async (o: StaffOrder) => {
    setSavingOrder(true);
    try {
      const r = await api.invoiceOrder<{ invoice_no: string; already: boolean;
                                         zoho?: { ok: boolean; message: string } }>(o.id);
      if (o.zoho_salesorder_id) {
        // 0061: accounts invoiced it in Zoho; CTP only closes the order and links that invoice — nothing is sent.
        showToast({ text: r?.already ? `${o.number} was already closed — invoiced in Zoho as ${o.zoho_invoice_number ?? "—"}.`
                                     : `Order closed — invoiced in Zoho as ${o.zoho_invoice_number ?? "—"}.` });
        loadOrders();
        return;
      }
      const base = r?.already
        ? `${o.number} is already invoiced as ${r.invoice_no}.`
        : `Invoice ${r?.invoice_no ?? ""} issued for ${o.number}.`;
      // The Zoho outcome is always said out loud — a failure shows as an error
      // toast (the invoice itself still stands; retry from Settings → Zoho).
      showToast({ text: r?.zoho ? `${base} ${r.zoho.message}` : base, err: r?.zoho ? !r.zoho.ok : false });
      loadOrders();
    } catch (e) {
      const msg = e instanceof Error ? e.message.replace(/^\[CTP web\] could not issue the invoice: /, "") : "Could not issue the invoice.";
      showToast({ text: msg, err: true });
    } finally { setSavingOrder(false); }
  }, [showToast, loadOrders]);

  const fillList = useCallback(async (o: StaffOrder) => {
    // 23 Oct: fills the price boxes only (latest list price, read locally). Nothing is saved;
    // "Send quote" saves the prices and creates the Zoho estimate.
    setSavingOrder(true);
    try {
      const lp = await api.listPrices(o.lines.map((l) => l.part_id));
      // 0072: the customer's Zoho price book rate wins over the list price
      const op = await orderPrices(o.id);
      if (op) setPrices((x) => ({ ...x, [o.id]: op }));
      const book = new Map((op?.lines ?? []).filter((x) => x.book_minor != null).map((x) => [x.line_id, x.book_minor!]));
      const next: Record<number, string> = {};
      let missing = 0, total = 0, booked = 0;
      for (const l of o.lines) {
        const c = book.get(l.id) ?? lp[String(l.part_id)];
        if (book.has(l.id)) booked++;
        if (c != null && c > 0) { next[l.id] = (c / 100).toFixed(2); total += c * l.qty; }
        else if (l.unit_price_minor > 0) total += l.unit_price_minor * l.qty;
        else missing++;
      }
      setDraftPrices((d) => ({ ...d, ...next }));
      showToast({ text: missing > 0
        ? `Filled from list — ${missing} part${missing === 1 ? " has" : "s have"} no list price, fill by hand. Then Send quote.`
        : `Filled ${booked ? `(${booked} at ${op?.pricebook ?? "their price book"} rates) ` : "from list"}: ${fmtR(total)} — check, then Send quote.` });
    } catch (e) {
      console.error(e);
      showToast({ text: e instanceof Error ? e.message : "Could not fill.", err: true });
    } finally {
      setSavingOrder(false);
    }
  }, [showToast]);

  // 0047: why a quote cannot be accepted yet, by order id — read when the
  // quote is ready so the button says so before anyone taps it.
  const [blockers, setBlockers] = useState<Record<number, api.AcceptBlocker[]>>({});
  // 0063: a quote that is a Zoho estimate shows Zoho's figures (total, discounts, expiry)
  const [estInfo, setEstInfo] = useState<Record<number, api.EstimateInfo>>({});
  useEffect(() => {
    if (!isClient) return;
    const ready = (mine ?? []).filter((r) => r.status === "quote" && r.priced);
    let stale = false;
    (async () => {
      const next: Record<number, api.AcceptBlocker[]> = {};
      const est: Record<number, api.EstimateInfo> = {};
      for (const r of ready) {
        try {
          const c = await api.quoteAcceptCheck(r.id);
          next[r.id] = c.ok ? [] : c.blockers;
          if (c.estimate) est[r.id] = c.estimate;
        }
        catch (e) { console.error(e); }
      }
      if (!stale) { setBlockers(next); setEstInfo(est); }
    })();
    return () => { stale = true; };
  }, [isClient, mine]);

  // ── the customer trims their own quote (0051) ──
  // myRequests() reads the LOCAL PowerSync database, and quote_drop_line is a
  // SERVER call, so the removal is not in the local copy until a sync pass
  // brings it back down — a second or two in which the row would sit there
  // looking ignored. `dropped` holds the line ids we have asked the server to
  // remove so the list and the total can answer immediately. It is an OPTIMISM,
  // not a truth: it is cleared per line the moment the synced data agrees, and
  // a refused removal puts the line straight back.
  const [dropped, setDropped] = useState<Set<number>>(new Set());
  const [droppingLine, setDroppingLine] = useState<number | null>(null);
  useEffect(() => {
    if (!mine) return;
    const stillThere = new Set(mine.flatMap((r) => r.lines.map((l) => l.id)));
    setDropped((s) => {
      const next = new Set([...s].filter((id) => stillThere.has(id)));
      return next.size === s.size ? s : next;     // no churn when nothing changed
    });
  }, [mine]);

  const dropLine = useCallback(async (r: MyRequest, lineId: number, label: string) => {
    setDroppingLine(lineId);
    setDropped((s) => new Set(s).add(lineId));
    try {
      const res = await api.quoteDropLine(lineId);
      showToast({ text: `${label} removed — ${r.number} is now ${fmtR(res.total_minor)} excl VAT.` });
      loadMine();
      // The quote changed, so why-it-cannot-be-accepted may have changed with
      // it: the removed line might have been the only blocker.
      try { const c = await api.quoteAcceptCheck(r.id); setBlockers((b) => ({ ...b, [r.id]: c.ok ? [] : c.blockers })); }
      catch (e) { console.error(e); }
    } catch (e) {
      console.error(e);
      setDropped((s) => { const n = new Set(s); n.delete(lineId); return n; });   // put it back
      const msg = e instanceof Error ? e.message.replace(/^\[CTP web\] could not remove that item: /, "") : "Could not remove that item.";
      showToast({ text: msg, err: true });
    } finally {
      setDroppingLine(null);
    }
  }, [showToast, loadMine]);

  // 0070: accepting asks for the customer's PO (number; file unless the setting says otherwise)
  const [poStep, setPoStep] = useState<{ r: MyRequest; po: string; file: File | null; need: boolean | null; credit: string | null; customerId: number | null } | null>(null);
  const openPoStep = useCallback((r: MyRequest) => {
    setPoStep({ r, po: "", file: null, need: null, credit: null, customerId: null });
    void acceptPrecheck(r.id).then((c) => setPoStep((p) => p && p.r.id === r.id
      ? { ...p, need: c ? c.po_file_required : true, credit: c?.credit?.customer ?? null, customerId: c?.customer_id ?? null } : p));
  }, []);

  const answerQuote = useCallback(async (r: MyRequest, accept: boolean, po?: { po: string; file: File | null; customerId: number | null }) => {
    setAnswering(r.id);
    try {
      if (accept) {
        // Zoho sales order + stock hold, both or neither (accept-quote function).
        const path = po?.file && po.customerId ? await uploadPo(po.customerId, r.id, po.file) : null;
        const res = await api.acceptQuote(r.id, { po_number: po?.po ?? "", po_file: path, po_file_name: po?.file?.name ?? null });
        showToast({ text: (res.zoho_salesorder_number
          ? `${r.number} accepted with your PO ${res.po_number ?? po?.po ?? ""} — sales order ${res.zoho_salesorder_number} raised. We'll be in touch with the proforma.`
          : `${r.number} accepted with your PO ${res.po_number ?? po?.po ?? ""} — your parts are reserved. We'll be in touch.`)
          + (res.credit_warning ? ` ${res.credit_warning}` : "") });
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

  /** 0053 — the counter raises the same request, for a customer it names.
   *  Deliberately a separate function from submitRequest rather than a flag on
   *  it: the two have different failure messages and different follow-ups (a
   *  customer watches for their quote, the counter goes straight to pricing). */
  const sendCounterSale = useCallback(async () => {
    if (cart.length === 0 || sending || counterCustomer == null) return;
    setSending(true);
    try {
      const res = await api.requestPartsFor<{ number?: string; lines?: number }>(
        counterCustomer,
        cart.map((c) => ({ part_id: c.id, qty: c.qty })),
        note.trim() || null
      );
      const who = customers.find((c) => c.id === counterCustomer)?.name ?? "the customer";
      setCart([]);
      setNote("");
      setCounterCustomer(null);
      showToast({ text: `${res?.number ?? "Request"} raised for ${who} — price it below and send.` });
      loadOrders();
    } catch (e) {
      console.error(e);
      const msg = e instanceof Error
        ? e.message.replace(/^\[CTP web\] request failed: /, "")
        : "Could not raise the request.";
      showToast({ text: msg, err: true });
    } finally {
      setSending(false);
    }
  }, [cart, note, sending, counterCustomer, customers, showToast]);

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
        qty_on_hand: h.on_hand, qty_held: h.held ?? 0, in_stock: h.in_stock ?? null, bin: h.bin ?? null, price_cents: h.price_cents,
        image: h.thumb ?? null,
      }));
    }
    let rows = parts;
    if (chip) rows = rows.filter((p) => p.category_code === chip);
    for (const k of ["make", "model", "part_type", "supplier"] as const) if (catF[k]) rows = rows.filter((p) => (p[k] ?? "") === catF[k]);
    if (tab === "shelf") {
      rows = [...rows].sort((a, b) =>
        a.bin && b.bin ? a.bin.localeCompare(b.bin, undefined, { numeric: true })
        : a.bin ? -1 : b.bin ? 1 : a.sku.localeCompare(b.sku));
    }
    return rows;
  }, [hits, parts, chip, tab, catF]);

  const connected = status.connected;

  // The header basket, on every screen (brand rows, the part sheet, the
  // drawing). Opening it closes whatever is on top: for a customer it is
  // their request; for staff it is the counter sale on the order desk.
  const openCart = () => {
    setSheetOpen(false); setCounterOpen(false); setViewer(null);
    if (diagram) {
      setDiagram(null);
      if (/^#dg=/.test(location.hash)) history.replaceState(null, "", location.pathname + location.search);
    }
    setTab("cart");
    window.setTimeout(() => document.querySelector(".mb-body")?.scrollTo({ top: 0 }), 0);
  };
  const cartBtn = (
    <CartButton count={cartCount} bump={cartBump} onOpen={openCart}
      label={isClient ? "Your request" : "Counter order"} />
  );

  // ─── views ─────────────────────────────────────────────────────────────────

  // The front page: every section of the truck as a big card — the SEC
  // exploded-view drawing IS the picture of "this part of the truck" — plus
  // one search box and an All-parts card.
  //
  // Ian, 2026-09-25: "when selecting a parts section it must go straight to the
  // parts list screen where the diagram is fitted to the screen and the parts
  // on the right with visible hotspots." So a section with a drawing opens the
  // VIEWER, not a preview of it. The filtered list is still set up underneath,
  // so closing the viewer lands on that section's parts rather than nowhere.
  // A section with no drawing yet (or All parts) behaves as before: the list.
  const openSection = (code: string | null) => {
    setChip(code);
    setQ("");
    setTab("find");
    const s = code ? sections.find((x) => x.code === code) : null;
    if (s?.diagram) openDiagram(s.diagram);
  };
  /** The Find tab's category chips are the same act of choosing a section, so
   *  they do the same thing. Tapping the chip that is already on clears it —
   *  that is how you get back to the whole catalogue — and clearing opens
   *  nothing. */
  const selectChip = (code: string) => {
    if (chip === code) { setChip(null); return; }
    openSection(code);
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
          {cartBtn}
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
          {cartBtn}
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

      {!hits && (() => {
        // 0074: only fields with more than one value (or one already chosen) get a filter
        const fields = ([["make", "Make"], ["model", "Model"], ["part_type", "Type"], ...(isClient ? [] : [["supplier", "Supplier"]])] as [keyof typeof catF, string][])
          .map(([k, label]) => ({ k, label, vals: [...new Set(parts.map((p) => p[k]).filter((v): v is string => !!v))].sort() }))
          .filter((f) => f.vals.length > 1 || catF[f.k]);
        return fields.length > 0 && (
          <div className="mb-chips" aria-label="Filter parts">
            {fields.map((f) => (
              <select key={f.k} className="mb-chip" aria-label={f.label} value={catF[f.k]}
                onChange={(e) => setCatF((c) => ({ ...c, [f.k]: e.target.value }))}>
                <option value="">{f.label}: all</option>
                {f.vals.map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            ))}
          </div>
        );
      })()}
      {!hits && (
        <div className="mb-chips">
          <button className={"mb-chip" + (chip == null ? " on" : "")} onClick={() => setChip(null)}>All</button>
          {cats.map((c) => (
            <button key={c.id} className={"mb-chip" + (chip === c.code ? " on" : "")}
              title={c.name} onClick={() => selectChip(c.code)}>
              {c.name}
            </button>
          ))}
        </div>
      )}

      <div className="mb-body">
        {/* There was a PREVIEW TILE here: a zoomed-in crop of the section
            drawing, no markers, no parts list, which you then had to tap to
            reach the real viewer. Ian, 2026-09-25: choosing a section must land
            on the viewer itself. It does now — openSection() and the chips open
            it directly (see selectChip) — so the tile is gone rather than
            demoted. Closing the viewer drops you here, on this section's parts,
            which is what the tile was standing in front of. */}
        <div className="mb-count">
          {hits ? `${cards.length} match${cards.length === 1 ? "" : "es"}`
            /* CAT-11: search starts at 3 characters; say so rather than silently browsing */
            : q.trim().length > 0 && q.trim().length < 3 ? `Type at least 3 characters to search · ${cards.length} parts`
            : `${cards.length} parts`}
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
              <RebateTag r={rebateFor(p.id)} />
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
                  {/* CAT-14: held units are on the shelf but promised; coloured by what is free */}
                  <span className={"mb-qty" + qtyClass(p.qty_on_hand - Math.max(0, p.qty_held ?? 0))}>
                    {p.qty_on_hand <= 0 ? "out" : `${p.qty_on_hand} on hand`}{(p.qty_held ?? 0) > 0 && p.qty_on_hand > 0 ? ` · ${p.qty_held} held` : ""}
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
              ? `Try fewer words, or a different number — search covers SKU, OEM numbers${isClient ? "" : ", locators, aliases"}, cross-references and names.`
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
          {cartBtn}
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
        {!isClient && (
          <button className="mb-settings-cta" onClick={() => { setReceiving([]); void openPurchaseOrders().then((r) => {
            if (r.ok) setReceiving(r.data.purchaseorders); else { setReceiving(null); showToast({ text: r.message, err: true }); } }); }}>
            <span>
              <b>Receive goods</b>
              <small>{zohoStock ? "Against an open Zoho purchase order — stock in now (Zoho Inventory)" : "Zoho purchase orders (rehearsal: receiving posts once Zoho holds the stock)"}</small>
            </span>
            <span className="mb-chev">›</span>
          </button>
        )}
        {receiving && (
          <div className="mb-rows" style={{ marginBottom: 14 }}>
            {receiving.length === 0 && <div className="mb-row"><span className="mb-rv">No open purchase orders in Zoho (or still loading).</span></div>}
            {receiving.map((po) => (
              <div key={po.purchaseorder_id}>
                <div className="mb-row"><span className="mb-rk mb-mono">{po.number}</span><span className="mb-rv">{po.vendor} · {po.status}</span></div>
                {po.lines.map((l) => (
                  <div className="mb-row" key={l.line_item_id} style={{ gap: 8 }}>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <div className="mb-cname">{l.name}</div>
                      <div className="mb-csku mb-mono">{l.sku} · ordered {l.ordered} · received {l.received}</div>
                    </span>
                    <input className="mb-price-in" inputMode="numeric" placeholder="0" style={{ flex: "0 0 72px" }}
                      value={rcvQty[l.line_item_id] ?? ""} onChange={(e) => setRcvQty((q) => ({ ...q, [l.line_item_id]: e.target.value.replace(/[^0-9]/g, "") }))} />
                  </div>
                ))}
                <div className="mb-row">
                  <button className="mb-btn p" style={{ height: 46 }} disabled={rcvBusy || !zohoStock}
                    title={zohoStock ? undefined : "Rehearsal: Zoho does not hold the stock yet"}
                    onClick={() => {
                      const lines = po.lines.map((l) => ({ line_item_id: l.line_item_id, quantity: Number(rcvQty[l.line_item_id] ?? 0) })).filter((l) => l.quantity > 0);
                      if (!lines.length) { showToast({ text: "Enter a quantity on at least one line.", err: true }); return; }
                      setRcvBusy(true);
                      void receiveInZoho(po.purchaseorder_id, lines).then((r) => {
                        setRcvBusy(false);
                        showToast(r.ok ? { text: `Received against ${r.data.purchaseorder}: ${r.data.receive_number} — stock is in Zoho.` } : { text: r.message, err: true });
                        if (r.ok) { setRcvQty({}); setReceiving(null); }
                      });
                    }}>{rcvBusy ? "Receiving…" : `Receive against ${po.number}`}</button>
                </div>
              </div>
            ))}
            <div className="mb-row"><button className="mb-btn s" style={{ height: 42 }} onClick={() => setReceiving(null)}>Close</button></div>
          </div>
        )}
        <div className="mb-rows">
          <div className="mb-row"><span className="mb-rk">App version</span>
            <span className="mb-rv">{__APP_VERSION__} · built {__APP_BUILT__} UTC</span></div>
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
        // The part no. (= the Zoho SKU; Zoho Inventory is the item master).
        // Not catalogue_pn: that is the base supplier number, without the
        // variant suffix, and would not match the Zoho invoice line.
        sku: l.sku, name: l.name, qty: l.qty,
        unit_price_minor: l.unit_price_minor, line_total_minor: l.unit_price_minor * l.qty,
      }));
      const subtotal_minor = lines.reduce((t, l) => t + l.line_total_minor, 0);
      const tax_minor = Math.floor((subtotal_minor * o.tax_rate_bps + 5000) / 10000);
      const doc: DocOrder = {
        number: o.number, status: o.status, created_at: o.created_at, fulfilled_at: o.fulfilled_at,
        // 21 Oct: Zoho numbers the invoice and Michelle sends it from Zoho; this
        // printout is a copy, carrying Zoho's number once Zoho has assigned it.
        invoice_no: o.zoho_invoice_number || o.invoice_no, invoiced_at: o.invoiced_at,
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
    o.status === "invoiced" ? "Print copy / PDF" : "Print quote / PDF";

  const STAGES: { key: string; label: string; hint: string }[] = [
    { key: "to_price",      label: "Needs pricing",   hint: "came in from a customer" },
    { key: "with_customer", label: "With the customer", hint: "quoted, waiting on their answer" },
    { key: "to_pick",       label: "Accepted",        hint: "sales order in Zoho — check it is paid there before the goods go" },
    { key: "fulfilled",     label: "Goods out",       hint: "stock taken — Zoho issues the invoice from the sales order" },
  ];

  // ── order desk search + filters (Ian, 23 Oct 2026) ──
  // All on the rows already on the phone; nothing here calls Zoho.
  const shown = useMemo(() => orders ? applyFilter(orders, ofilter) : null, [orders, ofilter]);
  const custOpts = useMemo(() => {
    const m = new Map<string, string>();
    for (const o of orders ?? []) m.set(customerKey(o), o.customer_name);
    return [...m].sort((a, b) => a[1].localeCompare(b[1]));
  }, [orders]);
  const partOpts = useMemo(() => {
    const m = new Map<number, string>();
    for (const o of orders ?? []) for (const l of o.lines) m.set(l.part_id, `${l.sku} · ${l.name}`);
    return [...m].sort((a, b) => a[1].localeCompare(b[1]));
  }, [orders]);
  const filtering = isFiltering(ofilter);
  const fchips: { label: string; clear: Partial<OrderFilter> }[] = [];
  if (ofilter.q.trim()) fchips.push({ label: `“${ofilter.q.trim()}”`, clear: { q: "" } });
  if (ofilter.range !== "all") fchips.push({
    label: ofilter.range === "custom"
      ? `${ofilter.from || "…"} → ${ofilter.to || "…"}` : RANGE_LABEL[ofilter.range],
    clear: { range: "all", from: "", to: "" },
  });
  if (ofilter.stage) fchips.push({ label: STAGE_LABEL[ofilter.stage], clear: { stage: null } });
  if (ofilter.customer) fchips.push({
    label: custOpts.find(([k]) => k === ofilter.customer)?.[1] ?? "Customer", clear: { customer: null },
  });
  if (ofilter.part != null) fchips.push({
    label: partOpts.find(([k]) => k === ofilter.part)?.[1].split(" · ")[0] ?? "Part", clear: { part: null },
  });
  if (ofilter.invoice !== "any") fchips.push({ label: ofilter.invoice === "has" ? "Has invoice" : "No invoice", clear: { invoice: "any" } });
  if (ofilter.paid !== "any") fchips.push({ label: ofilter.paid === "paid" ? "Paid" : "Unpaid", clear: { paid: "any" } });
  const opt = <K extends keyof OrderFilter>(k: K, v: OrderFilter[K], label: string) => (
    <button key={String(v)} type="button" className={"mb-chip" + (ofilter[k] === v ? " on" : "")}
      onClick={() => setOfilter((f) => ({ ...f, [k]: v }))}>{label}</button>
  );
  const orderFilterBar = orders && orders.length > 0 && (
    <div className="mb-of">
      <div className="mb-of-row">
        <div className="mb-sbox">
          <IcSearch />
          <input className="mb-of-q" type="search" inputMode="search" enterKeyHint="search" value={ofilter.q}
            placeholder="RQ, SO, INV, quote no, customer, part…"
            onChange={(e) => { const q = e.target.value; setOfilter((f) => ({ ...f, q })); }} />
          {ofilter.q && <button className="mb-clr" onClick={() => setOfilter((f) => ({ ...f, q: "" }))}>✕</button>}
        </div>
        <button type="button" className={"mb-of-tg" + (filtersOpen || fchips.some((c) => !("q" in c.clear)) ? " on" : "")}
          onClick={() => setFiltersOpen((v) => !v)}>
          Filters{fchips.filter((c) => !("q" in c.clear)).length > 0 ? ` · ${fchips.filter((c) => !("q" in c.clear)).length}` : ""}
        </button>
      </div>
      {filtersOpen && (
        <div className="mb-of-panel">
          <div>
            <div className="mb-of-lbl">Date</div>
            <div className="mb-of-opts">
              {(["all", "today", "7d", "month", "custom"] as Range[]).map((r) => opt("range", r, RANGE_LABEL[r]))}
            </div>
            {ofilter.range === "custom" && (
              <div className="mb-of-dates">
                <input className="mb-of-date" type="date" value={ofilter.from} aria-label="From"
                  onChange={(e) => { const from = e.target.value; setOfilter((f) => ({ ...f, from })); }} />
                <input className="mb-of-date" type="date" value={ofilter.to} aria-label="To"
                  onChange={(e) => { const to = e.target.value; setOfilter((f) => ({ ...f, to })); }} />
              </div>
            )}
          </div>
          <div>
            <div className="mb-of-lbl">Stage</div>
            <div className="mb-of-opts">
              {opt("stage", null, "Any")}
              {(Object.keys(STAGE_LABEL) as StageKey[]).map((s) => opt("stage", s, STAGE_LABEL[s]))}
            </div>
          </div>
          <div>
            <div className="mb-of-lbl">Customer</div>
            <select className="mb-of-sel" value={ofilter.customer ?? ""}
              onChange={(e) => { const customer = e.target.value || null; setOfilter((f) => ({ ...f, customer })); }}>
              <option value="">Any customer</option>
              {custOpts.map(([k, n]) => <option key={k} value={k}>{n}</option>)}
            </select>
          </div>
          <div>
            <div className="mb-of-lbl">Part</div>
            <select className="mb-of-sel" value={ofilter.part ?? ""}
              onChange={(e) => { const part = e.target.value ? Number(e.target.value) : null; setOfilter((f) => ({ ...f, part })); }}>
              <option value="">Any part</option>
              {partOpts.map(([k, n]) => <option key={k} value={k}>{n}</option>)}
            </select>
          </div>
          <div>
            <div className="mb-of-lbl">Invoice</div>
            <div className="mb-of-opts">
              {opt("invoice", "any", "Any")}{opt("invoice", "has", "Has invoice")}{opt("invoice", "none", "No invoice")}
            </div>
          </div>
          <div>
            <div className="mb-of-lbl">Payment</div>
            <div className="mb-of-opts">
              {opt("paid", "any", "Any")}{opt("paid", "paid", "Paid")}{opt("paid", "unpaid", "Unpaid")}
            </div>
          </div>
        </div>
      )}
      {filtering && (
        <div className="mb-of-chips">
          {fchips.map((c) => (
            <button key={c.label} type="button" className="mb-of-chip"
              onClick={() => setOfilter((f) => ({ ...f, ...c.clear }))}>
              {c.label}<b>✕</b>
            </button>
          ))}
          <button type="button" className="mb-of-clear" onClick={() => setOfilter(EMPTY_FILTER)}>Clear all</button>
          <span className="mb-of-n">{shown?.length ?? 0} of {orders.length}</span>
        </div>
      )}
    </div>
  );

  /** 23 Oct: with quotes as Zoho estimates, a priced quote is not "with the customer" until its
   *  estimate exists — it stays in Needs pricing, where Send quote creates the estimate. */
  const stageOf = (o: StaffOrder): string =>
    estimatesOn && o.stage === "with_customer" && !o.zoho_estimate_id ? "to_price" : o.stage;
  /** 24 Oct: one colour per in-process stage (Orders tab), muted once done. Always with a label. */
  const orderStage = (o: StaffOrder): { cls: string; label: string } => {
    if (o.status === "cancelled") return { cls: "st-muted", label: o.client_response === "declined" ? "Declined" : "Cancelled" };
    if (o.status === "invoiced") return { cls: "st-muted", label: "Completed" };
    const sg = stageOf(o);
    if (sg === "to_price") return { cls: "st-pricing", label: "Needs pricing" };
    if (sg === "with_customer") return { cls: "st-quote", label: "Quote sent" };
    if (sg === "to_pick") return o.zoho_invoice_id || !o.zoho_salesorder_id
      ? { cls: "st-invoiced", label: o.zoho_invoice_id ? "Invoiced — ready to fulfil" : "Accepted — ready to fulfil" }
      : { cls: "st-accepted", label: "Accepted — awaiting invoice" };
    if (sg === "fulfilled") return { cls: "st-out", label: "Goods out — close it" };
    return { cls: "st-muted", label: o.status };
  };
  const STAGE_LEGEND: [string, string][] = [["st-pricing", "Needs pricing"], ["st-quote", "Quote sent"], ["st-accepted", "Awaiting invoice"],
    ["st-invoiced", "Ready to fulfil"], ["st-out", "Goods out — close"], ["st-muted", "Completed / cancelled"]];

  /** Lane headers say what is actually true of the orders in them (Ian, 23 Oct). */
  const laneHint = (key: string, rows: StaffOrder[], fallback: string): string => {
    if (key === "to_price") return rows.some((o) => estimatesOn && o.unpriced === 0) ? "price it, then Send quote (creates the Zoho estimate)" : fallback;
    if (key === "with_customer") return estimatesOn ? "estimate in Zoho — accounts send it, then the customer accepts" : fallback;
    if (key === "to_pick") {
      const inv = rows.filter((o) => o.zoho_invoice_id).length;
      return inv === rows.length ? "invoiced in Zoho — goods can go out" : inv === 0 ? "sales order in Zoho — waiting for accounts to invoice it" : "some invoiced in Zoho — see each order";
    }
    if (key === "fulfilled") {
      const inv = rows.filter((o) => o.zoho_invoice_id || !o.zoho_salesorder_id).length;
      const paid = rows.filter((o) => o.zoho_status === "paid").length;
      return inv === rows.length ? (paid === rows.length ? "goods out, invoiced and paid in Zoho — close the order" : "goods out and invoiced in Zoho — close the order")
        : inv === 0 ? "goods out — waiting for accounts to invoice in Zoho" : "goods out — some still waiting for the Zoho invoice";
    }
    return fallback;
  };

  const ordersView = (
    <div className="mb-view">
      <div className="mb-top">
        <div className="mb-brandrow">
          <Brand />
          <span className="mb-vlabel">Orders</span>
          <span className={"mb-sync" + (connected ? "" : " off")}>
            <span className="mb-dot" />{connected ? "synced" : "offline"}
          </span>
          {cartBtn}
        </div>
      </div>
      <div className="mb-body">
        {/* 0053 — COUNTER SALE.
            Appears only once something is on the counter, so the desk is not
            cluttered the rest of the time. It raises exactly the same kind of
            request a customer would, against a customer you name, and then
            lands in "To price" below where the normal flow takes over. */}
        {cart.length > 0 && (
          <div className="mb-card" style={{ borderColor: "var(--amber)", marginBottom: 14 }}>
            <div className="mb-cbody">
              <div className="mb-count" style={{ color: "var(--amber)", paddingTop: 0 }}>
                Counter sale · {cart.length} part{cart.length === 1 ? "" : "s"} · {cartCount} item{cartCount === 1 ? "" : "s"}
              </div>

              {customers.length > 8 && (
                <input className="mb-hs-in" style={{ width: "100%", marginBottom: 6 }} type="search"
                  placeholder="Search customers…" value={counterFind}
                  onChange={(e) => setCounterFind(e.target.value)} />
              )}
              <select className="mb-hs-in" style={{ width: "100%", marginBottom: 10 }}
                value={counterCustomer ?? ""}
                onChange={(e) => setCounterCustomer(e.target.value ? Number(e.target.value) : null)}>
                <option value="">— which customer is this for? —</option>
                {customers
                  .filter((c) => c.id === counterCustomer || !counterFind.trim()
                    || c.name.toLowerCase().includes(counterFind.trim().toLowerCase()))
                  .map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              {!addingCustomer
                ? <button className="mb-btn" style={{ width: "100%", marginBottom: 10 }} onClick={() => setAddingCustomer(true)}>+ New customer</button>
                : <div style={{ marginBottom: 10 }}>
                    <AddCustomer isAdmin={role === "admin"} onCancel={() => setAddingCustomer(false)}
                      onDone={(id, label) => {
                        setCustomers((cs) => cs.some((c) => c.id === id) ? cs : [...cs, { id, name: label }].sort((a, b) => a.name.localeCompare(b.name)));
                        setCounterCustomer(id); setAddingCustomer(false);
                      }} />
                  </div>}

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

              <textarea className="mb-note-in" rows={2} value={note} maxLength={2000}
                placeholder="Vehicle, urgency, who asked — anything the desk should see…"
                onChange={(e) => setNote(e.target.value)} />

              <div className="mb-actions" style={{ marginTop: 10 }}>
                <button className="mb-btn s" disabled={sending}
                  onClick={() => { setCart([]); setNote(""); setCounterCustomer(null); }}>Clear</button>
                <button className="mb-btn p" disabled={sending || counterCustomer == null}
                  onClick={() => void sendCounterSale()}>
                  {sending ? "Raising…" : counterCustomer == null ? "Pick a customer" : "Raise request"}
                </button>
              </div>
            </div>
          </div>
        )}

        {orderFilterBar}
        {orders && orders.length > 0 && (
          <div className="mb-legend" aria-label="Order stage colours">
            {STAGE_LEGEND.map(([c, l]) => <span key={c} className={"mb-ord " + c}><span className="mb-stpill">{l}</span></span>)}
          </div>
        )}
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
        {shown && filtering && shown.length === 0 && (
          <div className="mb-empty">
            <h3>No orders match</h3>
            <p>Nothing fits these filters. Tap a chip to drop it, or <b>Clear all</b>.</p>
          </div>
        )}
        {shown && STAGES.map((s) => {
          const inStage = shown.filter((o) => stageOf(o) === s.key);
          if (inStage.length === 0) return null;
          return (
            <div key={s.key}>
              <div className="mb-count">{s.label} · {inStage.length} — {laneHint(s.key, inStage, s.hint)}</div>
              {inStage.map((o) => {
                const open = openOrder === o.id;
                const st = orderStage(o);
                return (
                  <div className={"mb-rows mb-ord " + st.cls} key={o.id} style={{ marginBottom: 12 }}>
                    <button className="mb-row" style={{ width: "100%", background: "none", border: 0, textAlign: "left" }}
                      onClick={() => { setOpenOrder(open ? null : o.id); setDraftPrices({}); if (!open) void syncOrderFromZoho(o); }}>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <div className="mb-cname">{o.customer_name}</div>
                        <div className="mb-csku mb-mono">{o.number} · {o.lines.length} line{o.lines.length === 1 ? "" : "s"}</div>
                        <span className="mb-stpill">{st.label}</span>
                      </span>
                      <span className="mb-rv">
                        {o.total_minor > 0 ? fmtR(o.total_minor) : <span style={{ color: "var(--warn)" }}>no price</span>}
                        <RebateSum r={orderRebate(o)} />
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
                        {prices[o.id]?.pricebook && <div className="mb-row"><span className="mb-rk">Price book</span><span className="mb-rv">{prices[o.id].pricebook}</span></div>}
                        {o.lines.map((l) => (
                          <div className="mb-row" key={l.id}>
                            <span style={{ flex: 1, minWidth: 0 }}>
                              <div className="mb-cname">{l.qty} × {l.name}</div>
                              <div className="mb-csku mb-mono">{l.sku}</div>
                              <PriceInfo lp={lpFor(o, l)} qty={l.qty} staff known={!!prices[o.id]}
                                priceMinor={draftPrices[l.id] != null && draftPrices[l.id] !== "" ? Math.round(Number(draftPrices[l.id]) * 100) || 0 : defaultMinor(o, l)} />
                            </span>
                            {stageOf(o) === "to_price" ? (
                              <input className="mb-price-in" inputMode="decimal" placeholder="0.00"
                                value={draftPrices[l.id] ?? (defaultMinor(o, l) > 0 ? (defaultMinor(o, l) / 100).toFixed(2) : "")}
                                onChange={(e) => setDraftPrices((d) => ({ ...d, [l.id]: e.target.value }))} />
                            ) : (
                              <span className="mb-rv">{fmtR(l.unit_price_minor * l.qty)}</span>
                            )}
                          </div>
                        ))}
                        {(() => { const rb = orderRebate(o); return rb && (
                          <div className="mb-row">
                            <span className="mb-rk">Rebate · {rb.n} line{rb.n === 1 ? "" : "s"}</span>
                            <span className="mb-rv">
                              {rb.list > rb.at && <s className="mb-was">{fmtR(rb.list)}</s>}<b>{fmtR(rb.at)}</b>
                              <RebateSum r={rb} />
                            </span>
                          </div>
                        ); })()}
                        {stageOf(o) === "to_price" && (
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
                        {stageOf(o) === "with_customer" && (
                          <div className="mb-row">
                            <span className="mb-rk">Waiting</span>
                            <span className="mb-rv">{(estimatesOn || o.zoho_estimate_id) && !["sent", "accepted"].includes(o.zoho_estimate_status ?? "")
                              ? "on accounts — the customer sees the quote but cannot accept until the estimate is sent"
                              : `sent ${timeAgo(o.created_at)} · they see it on their phone`}</span>
                          </div>
                        )}
                        {o.status === "quote" && (o.zoho_estimate_id || (estimatesOn && o.unpriced === 0 && !!o.zoho_estimate_error)) && (
                          <>
                            <div className="mb-row">
                              <span className="mb-rk">Zoho</span>
                              <span className="mb-rv">
                                {!o.zoho_estimate_id
                                  ? <span style={{ color: "var(--amber)" }}>No Zoho estimate yet — the customer cannot accept until one is sent.</span>
                                  : o.zoho_estimate_status === "draft"
                                    ? <span style={{ color: "var(--amber)" }}>Waiting for accounts to send estimate <b className="mb-mono">{o.zoho_estimate_number}</b> from Zoho.</span>
                                    : o.zoho_estimate_status === "sent" || o.zoho_estimate_status === "accepted"
                                      ? <span style={{ color: "var(--green)" }}>Estimate <b className="mb-mono">{o.zoho_estimate_number}</b> sent by accounts — the customer can accept.</span>
                                      : <span style={{ color: "var(--amber)" }}>Estimate <b className="mb-mono">{o.zoho_estimate_number}</b> is {o.zoho_estimate_status} in Zoho.</span>}
                                {o.zoho_estimate_total_minor != null && <div className="mb-csku">Zoho total {fmtR(o.zoho_estimate_total_minor)} incl VAT{o.zoho_estimate_expiry ? ` · valid until ${String(o.zoho_estimate_expiry).slice(0, 10)}` : ""}</div>}
                                {o.zoho_estimate_error && <div style={{ color: "var(--amber)" }}>{o.zoho_estimate_error}</div>}
                              </span>
                            </div>
                            {o.zoho_estimate_id && ["deleted", "void"].includes(o.zoho_estimate_status ?? "") && role === "admin" && (
                              <div className="mb-row">
                                <button className="mb-btn s" style={{ height: 46 }} disabled={savingOrder}
                                  onClick={() => { setSavingOrder(true); void recreateEstimate(o.id).then((r) => {
                                    setSavingOrder(false);
                                    showToast(r.ok ? { text: r.linked ? `Linked the live Zoho estimate ${r.number ?? ""} (no duplicate made).` : `New draft estimate ${r.number ?? ""} created in Zoho — accounts send it from Zoho.` }
                                      : { text: r.message ?? "Could not create a new estimate.", err: true });
                                    loadOrders();
                                  }); }}>Create new estimate (admin)</button>
                              </div>
                            )}
                            {o.zoho_estimate_id && !["deleted", "void", "declined", "expired"].includes(o.zoho_estimate_status ?? "") && (
                              <div className="mb-row">
                                <span className="mb-rk">Prices</span>
                                <span className="mb-rv">Edit prices in Zoho ({o.zoho_estimate_number}) — CTP follows Zoho. <button className="mb-chip" disabled={syncingSo === o.id}
                                  onClick={() => { void syncOrderFromZoho(o, true); }}>{syncingSo === o.id ? "Reading…" : "Refresh from Zoho"}</button></span>
                              </div>
                            )}
                            {!o.zoho_estimate_id && estimatesOn && !!o.zoho_estimate_error && (
                              <div className="mb-row">
                                <button className="mb-btn s" style={{ height: 46 }} disabled={savingOrder}
                                  onClick={() => { setSavingOrder(true); void syncEstimate(o.id).then((r) => {
                                    setSavingOrder(false);
                                    showToast(r.ok && !r.skipped ? { text: `Estimate ${r.number ?? ""} created in Zoho as a draft — accounts send it from Zoho.` }
                                      : { text: r.skipped ?? `Could not create the Zoho estimate: ${r.message ?? "unknown error"}`, err: !r.skipped });
                                    loadOrders();
                                  }); }}>Create estimate in Zoho</button>
                              </div>
                            )}
                          </>
                        )}
                        {stageOf(o) === "with_customer" && role === "admin" && (() => {
                          // 0063: only once accounts have SENT the Zoho estimate
                          const notYet = (estimatesOn || !!o.zoho_estimate_id) && !(o.zoho_estimate_id && ["sent", "accepted"].includes(o.zoho_estimate_status ?? ""));
                          return (
                            <div className="mb-row">
                              <button className="mb-btn s" style={{ height: 46 }} disabled={savingOrder || notYet}
                                title={notYet ? `Waiting for accounts to send estimate ${o.zoho_estimate_number ?? ""} from Zoho` : undefined}
                                onClick={() => openBehalf(o)}>
                                {notYet ? `Accept on customer's behalf — waiting for accounts to send ${o.zoho_estimate_number ?? "the estimate"}` : "Accept on customer's behalf"}
                              </button>
                            </div>
                          );
                        })()}
                        {(o.po_number || o.credit_warning) && (
                          <div className="mb-row" style={{ display: "block" }}>
                            {o.po_number && <span className="mb-rk">Customer PO <b className="mb-mono">{o.po_number}</b></span>}
                            {o.po_file_path && <> · <button className="mb-chip" onClick={() => { void poFileUrl(o.po_file_path!).then((u) => window.open(u, "_blank", "noopener"))
                              .catch((e) => showToast({ text: e instanceof Error ? e.message : "Could not open the PO.", err: true })); }}>View PO{o.po_file_name ? ` (${o.po_file_name})` : ""}</button></>}
                            {o.credit_warning && <div className="mb-note" style={{ margin: "6px 0 0" }}>⚠ {o.credit_warning}</div>}
                          </div>
                        )}
                        {(o.timeline?.length ?? 0) > 0 && (
                          <details className="mb-row" style={{ display: "block" }} open={o.stage !== "invoiced" && o.status !== "cancelled"}>
                            <summary className="mb-rk" style={{ cursor: "pointer" }}>Timeline</summary>
                            <ol className="mb-tl">
                              {o.timeline!.map((e, i) => (
                                <li key={i}>
                                  <span className="mb-tl-when">{new Date(e.at).toLocaleString("en-ZA", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</span>
                                  <span className="mb-tl-what">{e.label}{e.detail && typeof e.detail.po === "string" ? ` · PO ${e.detail.po}` : ""}{e.detail && typeof e.detail.note === "string" ? ` — “${e.detail.note}”` : ""}</span>
                                  <span className="mb-tl-who">{e.by}</span>
                                </li>
                              ))}
                            </ol>
                          </details>
                        )}
                        {o.staff_log && (
                          <details className="mb-row" style={{ display: "block" }}>
                            <summary className="mb-rk" style={{ cursor: "pointer" }}>History (staff only)</summary>
                            <div className="mb-csku" style={{ whiteSpace: "pre-wrap", marginTop: 6 }}>{o.staff_log}</div>
                          </details>
                        )}
                        {stageOf(o) !== "to_price" && (
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
                                  ? <> · sales order <b className="mb-mono">{o.zoho_salesorder_number}</b> in Zoho Books — accounts invoice it there</>
                                  : <> · <span style={{ color: "var(--amber)" }}>no Zoho sales order (accepted while Zoho sending was off) — the invoice goes to Zoho on its own</span></>}
                              </span>
                            </div>
                            {zohoAccountsRows(o)}
                            {(() => {
                              const why = fulfilBlockReason(o);
                              return (
                                <>
                                  <div className="mb-row">
                                    <button className="mb-btn p" style={{ height: 46 }} disabled={savingOrder || !!why}
                                      title={why ?? undefined}
                                      onClick={() => setPendingAct({ order: o, kind: "fulfil" })}>
                                      {zohoStock ? "Ship in Zoho — package + shipment" : "Fulfil — take stock out"}
                                    </button>
                                  </div>
                                  {why && (
                                    <div className="mb-row">
                                      <span className="mb-rk">Not yet</span>
                                      <span className="mb-rv" style={{ color: "var(--amber)" }}>
                                        {why}
                                        {role === "admin" && <> · <button className="mb-chip" disabled={savingOrder}
                                          onClick={() => { void releaseForFulfil(o); }}>Release anyway (admin)…</button></>}
                                      </span>
                                    </div>
                                  )}
                                  {o.fulfil_override_at && (
                                    <div className="mb-row">
                                      <span className="mb-rk">Released</span>
                                      <span className="mb-rv">before accounts finished — {o.fulfil_override_note}</span>
                                    </div>
                                  )}
                                </>
                              );
                            })()}
                          </>
                        )}
                        {o.stage === "fulfilled" && (
                          <>
                            <div className="mb-row">
                              <span className="mb-rk">Goods out</span>
                              <span className="mb-rv">{o.fulfilled_at ? timeAgo(o.fulfilled_at) : "—"}</span>
                            </div>
                            {zohoAccountsRows(o)}
                            {/* 0061: with a Zoho sales order, accounts raise the invoice in Zoho;
                                CTP only records it (links that invoice — never creates a second). */}
                            {!o.zoho_salesorder_id ? (
                              <div className="mb-row">
                                <button className="mb-btn p" style={{ height: 46 }} disabled={savingOrder}
                                  onClick={() => setPendingAct({ order: o, kind: "invoice" })}>
                                  Issue tax invoice
                                </button>
                              </div>
                            ) : o.zoho_invoice_id ? (
                              <div className="mb-row">
                                <button className="mb-btn p" style={{ height: 46 }} disabled={savingOrder}
                                  onClick={() => setPendingAct({ order: o, kind: "invoice" })}>
                                  Close order — invoiced in Zoho as {o.zoho_invoice_number}
                                </button>
                              </div>
                            ) : (
                              <div className="mb-row">
                                <span className="mb-rk">Invoice</span>
                                <span className="mb-rv" style={{ color: "var(--amber)" }}>Waiting for accounts to invoice this sales order in Zoho — CTP links it automatically.</span>
                              </div>
                            )}
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
        {shown && [false, true].map((cancelledGroup) => {
          const done = shown.filter((o) => !STAGES.some((s) => s.key === stageOf(o))
              && (o.status === "cancelled") === cancelledGroup)
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
            <div key={cancelledGroup ? "cancelled" : "done"}>
              <div className="mb-count">{cancelledGroup ? `Cancelled · ${done.length}` : `Completed · ${done.length} — invoiced and closed`}</div>
              {done.map((o) => {
                const open = openOrder === o.id;
                const when = o.invoiced_at ?? o.fulfilled_at ?? o.created_at;
                const st = orderStage(o);
                return (
                  <div className={"mb-rows mb-ord " + st.cls} key={o.id} style={{ marginBottom: 12 }}>
                    <button className="mb-row" style={{ width: "100%", background: "none", border: 0, textAlign: "left" }}
                      onClick={() => { setOpenOrder(open ? null : o.id); setDraftPrices({}); if (!open) void syncOrderFromZoho(o); }}>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <div className="mb-cname">{o.customer_name}</div>
                        <div className="mb-csku mb-mono">
                          {o.invoice_no ? `${o.invoice_no} · ` : ""}{o.number} · {o.lines.length} line{o.lines.length === 1 ? "" : "s"} · {when.slice(0, 10)}
                        </div>
                        {/* Zoho's own status, read back (0047). Shown only for
                            invoices CTP Core sent or tried to send — pre-go-live
                            invoices were imported into Zoho by the accountant. */}
                        {(o.zoho_status || o.zoho_error) && (() => {
                          const z = zohoStatusLabel(o.zoho_error && !o.zoho_invoice_number ? "error" : o.zoho_status);
                          return (
                            <div className="mb-csku" style={{ fontWeight: 700,
                                 color: z.tone === "bad" ? "var(--red)" : z.tone === "wait" ? "var(--warn)" : "var(--green)" }}>
                              {z.text}{o.zoho_invoice_number ? ` · ${o.zoho_invoice_number}` : ""}
                            </div>
                          );
                        })()}
                      </span>
                      <span className="mb-rv">
                        <div>{fmtR(grand(o))}</div>
                        <div className="mb-csku" style={{ textTransform: "capitalize" }}>
                          {o.status}{o.tax_rate_bps > 0 ? " · incl. VAT" : ""}
                        </div>
                        <RebateSum r={orderRebate(o)} />
                      </span>
                    </button>
                    {open && (
                      <>
                        {o.zoho_error && (
                          <div className="mb-csku" style={{ color: "var(--red)", padding: "6px 0" }}>
                            ✕ Zoho: {o.zoho_error}
                          </div>
                        )}
                        {o.zoho_so_error && (
                          <div className="mb-csku" style={{ color: "var(--red)", padding: "6px 0" }}>
                            ✕ Zoho sales order: {o.zoho_so_error}
                          </div>
                        )}
                        {o.zoho_estimate_number && (
                          <div className="mb-row">
                            <span className="mb-rk">Estimate</span>
                            <span className="mb-rv"><b className="mb-mono">{o.zoho_estimate_number}</b> · {o.zoho_estimate_status ?? "—"} in Zoho</span>
                          </div>
                        )}
                        {o.notes && (
                          <div className="mb-row">
                            <span className="mb-rk">Their note</span>
                            <span className="mb-rv">{o.notes}</span>
                          </div>
                        )}
                        {(o.po_number || o.credit_warning) && (
                          <div className="mb-row" style={{ display: "block" }}>
                            {o.po_number && <span className="mb-rk">Customer PO <b className="mb-mono">{o.po_number}</b></span>}
                            {o.po_file_path && <> · <button className="mb-chip" onClick={() => { void poFileUrl(o.po_file_path!).then((u) => window.open(u, "_blank", "noopener"))
                              .catch((e) => showToast({ text: e instanceof Error ? e.message : "Could not open the PO.", err: true })); }}>View PO{o.po_file_name ? ` (${o.po_file_name})` : ""}</button></>}
                            {o.credit_warning && <div className="mb-note" style={{ margin: "6px 0 0" }}>⚠ {o.credit_warning}</div>}
                          </div>
                        )}
                        {(o.timeline?.length ?? 0) > 0 && (
                          <details className="mb-row" style={{ display: "block" }} open={o.stage !== "invoiced" && o.status !== "cancelled"}>
                            <summary className="mb-rk" style={{ cursor: "pointer" }}>Timeline</summary>
                            <ol className="mb-tl">
                              {o.timeline!.map((e, i) => (
                                <li key={i}>
                                  <span className="mb-tl-when">{new Date(e.at).toLocaleString("en-ZA", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</span>
                                  <span className="mb-tl-what">{e.label}{e.detail && typeof e.detail.po === "string" ? ` · PO ${e.detail.po}` : ""}{e.detail && typeof e.detail.note === "string" ? ` — “${e.detail.note}”` : ""}</span>
                                  <span className="mb-tl-who">{e.by}</span>
                                </li>
                              ))}
                            </ol>
                          </details>
                        )}
                        {o.staff_log && (
                          <details className="mb-row" style={{ display: "block" }}>
                            <summary className="mb-rk" style={{ cursor: "pointer" }}>History (staff only)</summary>
                            <div className="mb-csku" style={{ whiteSpace: "pre-wrap", marginTop: 6 }}>{o.staff_log}</div>
                          </details>
                        )}
                        {o.lines.map((l) => (
                          <div className="mb-row" key={l.id}>
                            <span style={{ flex: 1, minWidth: 0 }}>
                              <div className="mb-cname">{l.qty} × {l.name}</div>
                              <div className="mb-csku mb-mono">{l.sku}</div>
                              <PriceInfo lp={lpFor(o, l)} qty={l.qty} staff known={!!prices[o.id]} priceMinor={l.unit_price_minor} />
                            </span>
                            <span className="mb-rv">{fmtR(l.unit_price_minor * l.qty)}</span>
                          </div>
                        ))}
                        {(() => { const rb = orderRebate(o); return rb && (
                          <div className="mb-row">
                            <span className="mb-rk">Rebate · {rb.n} line{rb.n === 1 ? "" : "s"}</span>
                            <span className="mb-rv">
                              {rb.list > rb.at && <s className="mb-was">{fmtR(rb.list)}</s>}<b>{fmtR(rb.at)}</b>
                              <RebateSum r={rb} />
                            </span>
                          </div>
                        ); })()}
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
          {cartBtn}
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
                    <RebateTag r={rebateFor(c.id)} />
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
              // What the customer is actually looking at, once anything they
              // have just removed is taken out. Every number below is derived
              // from THIS list, so the total can never disagree with the lines
              // above it while a removal is in flight.
              const lines = r.lines.filter((l) => !dropped.has(l.id));
              const total = lines.reduce((t, l) => t + (l.unit_price_minor ?? 0) * l.qty, 0);
              const priced = lines.length > 0 && lines.every((l) => (l.unit_price_minor ?? 0) > 0);
              const awaiting = r.status === "quote" && priced;
              // Removable while it is still a quote. Not the last one: a quote
              // must keep an item, and turning the whole thing down is Decline
              // (0051 refuses it server-side too — this only saves the trip).
              const canDrop = r.status === "quote" && lines.length > 1;
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
                      {r.status === "quote" && !priced && (() => { const rb = orderRebate({ ...r, lines });
                        return rb && rb.saving > 0 ? <div className="mb-csku mb-rbsum">your rebate: {fmtR(rb.at)} instead of {fmtR(rb.list)}</div> : null; })()}
                    </span>
                  </div>
                  {lines.map((l) => (
                    <div className="mb-row" key={l.id}>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <div className="mb-cname">{l.qty} × {l.name}</div>
                        <div className="mb-csku mb-mono">{l.sku}</div>
                        {(l.unit_price_minor ?? 0) <= 0 && <RebateTag r={rebateFor(l.part_id)} />}
                      </span>
                      {/* Only ever their OWN quoted price — never the price list.
                          0063: a Zoho estimate's line shows Zoho's discount and net. */}
                      {(l.unit_price_minor ?? 0) > 0 && (() => {
                        const z = estInfo[r.id]?.lines.find((x) => x.part_id === l.part_id);
                        const pct = Number(z?.discount_pct ?? 0);
                        return (
                          <span className="mb-rv">
                            {(() => { const lp = minePrices[r.id]?.lines.find((x) => x.part_id === l.part_id);
                              const rb = rebateFor(l.part_id);   // 0076: on-device book when the server read is not back
                              const list = lp?.list_minor ?? rb?.list_minor ?? null, booked = lp?.book_minor ?? rb?.book_minor;
                              // 0078: a Zoho estimate line strikes the list too, against its net
                              const paid = z ? z.net_minor : (l.unit_price_minor ?? 0) * l.qty;
                              return list && booked != null && paid < list * l.qty
                                ? <s className="mb-was">{fmtR(list * l.qty)}</s> : null; })()}
                            {fmtR(z ? z.net_minor : (l.unit_price_minor ?? 0) * l.qty)}
                            {pct > 0 && <div className="mb-csku">less {Math.round(pct * 100) / 100}%</div>}
                          </span>
                        );
                      })()}
                      {/* Ian, 2026-09-25: let them drop what they do not want
                          before accepting. Disabled on the last remaining line
                          — that is what Decline is for. */}
                      {r.status === "quote" && !estInfo[r.id] && (
                        <button className="mb-lx" aria-label={`Remove ${l.name} from this quote`}
                          title={canDrop ? `Remove ${l.name}` : "The last item cannot be removed — use Decline to turn the whole quote down"}
                          disabled={!canDrop || droppingLine === l.id || answering === r.id}
                          onClick={() => { void dropLine(r, l.id, l.name); }}>✕</button>
                      )}
                    </div>
                  ))}
                  {priced && !(estInfo[r.id]?.total_minor) && (() => {
                    const rb = orderRebate({ ...r, lines });   // 0077: their rebate on this order
                    return (
                      <div className="mb-row">
                        <span className="mb-rk">Total</span>
                        <span className="mb-rv">
                          {rb && rb.saving > 0 && <s className="mb-was">{fmtR(total + rb.saving)}</s>}
                          <b>{fmtR(total)}</b> excl VAT
                          {rb && rb.saving > 0 && <div className="mb-csku mb-rbsum">you save {fmtR(rb.saving)} with your rebate</div>}
                        </span>
                      </div>
                    );
                  })()}
                  {priced && estInfo[r.id]?.total_minor != null && (
                    <div className="mb-row">
                      <span className="mb-rk">Total</span>
                      <span className="mb-rv">
                        <b>{fmtR(estInfo[r.id].total_minor)}</b> incl VAT
                        {(() => {
                          // 0078: their rebate on a Zoho quote — list vs Zoho's net, book lines only (excl VAT)
                          let saving = 0;
                          for (const l of lines) {
                            const rb = rebateFor(l.part_id);
                            if (!rb || rb.book_minor == null || rb.list_minor == null) continue;
                            const z = estInfo[r.id]?.lines.find((x) => x.part_id === l.part_id);
                            saving += Math.max(0, rb.list_minor * l.qty - (z ? z.net_minor : (l.unit_price_minor ?? 0) * l.qty));
                          }
                          return saving > 0 ? <div className="mb-csku mb-rbsum">you save {fmtR(saving)} excl VAT with your rebate</div> : null;
                        })()}
                        <div className="mb-csku">Quote {estInfo[r.id].number}{estInfo[r.id].expiry ? ` · valid until ${String(estInfo[r.id].expiry).slice(0, 10)}` : ""}</div>
                      </span>
                    </div>
                  )}
                  {/* No "n items removed" banner: r.lines stops carrying a
                      removed line as soon as the sync pass lands, so such a
                      banner would appear for a second and then vanish, which
                      reads as a glitch. The line going, the total changing and
                      the toast are the confirmation. */}
                  {r.status === "confirmed" && r.zoho_salesorder_number && (
                    <div className="mb-note" style={{ margin: "6px 0 0" }}>
                      Your sales order <b className="mb-mono">{r.zoho_salesorder_number}</b> has been raised in our accounts system — we will send you the proforma from there. The tax invoice follows once payment is received.
                    </div>
                  )}
                  {awaiting && (blockers[r.id]?.length ?? 0) > 0 && (
                    <div className="mb-note" style={{ margin: "6px 0 0" }}>
                      {blockers[r.id].every((b) => b.kind === "estimate")
                        ? blockers[r.id].map((b) => b.message).join(" ")
                        : <><b>Not quite ready to accept:</b> {blockers[r.id].map((b) => b.message).join(" ")}</>}
                    </div>
                  )}
                  {awaiting && (
                    <div className="mb-row" style={{ gap: 10 }}>
                      <button className="mb-btn s" style={{ height: 46 }}
                        disabled={answering === r.id}
                        onClick={() => { void answerQuote(r, false); }}>Decline</button>
                      <button className="mb-btn p" style={{ height: 46 }}
                        disabled={answering === r.id || (blockers[r.id]?.length ?? 0) > 0}
                        onClick={() => openPoStep(r)}>
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
  // 0072: their own quotes, book-aware
  useEffect(() => {
    if (!mine || role !== "customer") return;
    let live = true;
    for (const r of mine.filter((x) => x.priced && ["quote", "confirmed"].includes(x.status))) {
      void orderPrices(r.id).then((p) => { if (live && p) setMinePrices((x) => ({ ...x, [r.id]: p })); });
    }
    return () => { live = false; };
  }, [mine, role]);
  // 0072: read when a customer opens a part (server resolves the book from their login)
  useEffect(() => {
    if (role !== "customer" || !detail) return;
    let live = true;
    const id = detail.id;
    void myPrices([id]).then((m) => { if (!live) return; const v = m[String(id)]; setMyPrice(v ? { part_id: id, ...v } : null); });
    return () => { live = false; };
  }, [detail, role]);
  // The part's photos, primary first — the order the carousel walks and the
  // order the lightbox inherits, so "photo 2 of 4" means the same thing in both.
  const photos = useMemo(() => {
    if (!d) return [];
    return [...d.images].sort((a, b) => Number(b.is_primary) - Number(a.is_primary));
  }, [d]);
  // Clamped rather than corrected by an effect: staff can retire a photo from
  // the admin gallery while the sheet is open, and shot would then point past
  // the end for one render. `at` can never be out of range.
  const at = Math.min(shot, Math.max(0, photos.length - 1));
  const hero = photos[at]?.path ?? null;
  const mainBin = d?.stock.find((s) => s.bin)?.bin ?? null;

  // The diagram on a part's own page is a thumbnail, and it has never carried
  // markers — Ian read that as "the hotspots are gone" on 7 Oct. Full marker
  // sets belong in the viewer (they need the zoom to be legible at all), but
  // the ONE marker that matters here — this part's own position on the drawing
  // — is worth showing, so the thumbnail answers "where is it" on its own.
  // Percentages, because hotspots are stored in the drawing's natural frame
  // and the thumbnail is rendered at whatever width the sheet happens to be.
  const [spot, setSpot] = useState<{ x: number; y: number; label: string } | null>(null);
  useEffect(() => {
    setSpot(null);
    const path = d?.diagram_image;
    if (!path || !d) return;
    let live = true;
    api.listHotspots(path).then((r) => {
      if (!live || !r.img_w || !r.img_h) return;      // no frame, no honest placement
      const h = r.hotspots.find((x) => x.part_id === d.id);
      if (!h) return;
      setSpot({ x: (h.x / r.img_w) * 100, y: (h.y / r.img_h) * 100, label: h.item_no ?? "•" });
    }).catch((e) => console.error("hotspots:", e));
    return () => { live = false; };
  }, [d?.diagram_image, d?.id]);

  // 2026-09-26: "Open" in the diagram parts list appeared to do nothing. It was
  // doing its job — openPart() fetched the part and opened this sheet — but the
  // sheet is z-index 40 and the diagram lightbox (.mb-lb) is 70, so it opened
  // UNDERNEATH the diagram, invisibly. The Lightbox caller dodged this by
  // closing itself first; the DiagramView caller deliberately does not, because
  // closing the drawing to read a part and having to navigate back to it is the
  // behaviour Ian asked us to get rid of. So the sheet rises above the drawing
  // instead, and closing it puts you back on the same drawing, same zoom.
  const sheet = (
    <div className={"mb-sheet" + (sheetOpen ? " open" : "") + (diagram || viewer || hotspotEditor ? " over-lightbox" : "")}>
      {d && (
        <>
          <div className="mb-shead">
            <button className="mb-back" onClick={() => { setSheetOpen(false); setCounterOpen(false); }}>‹</button>
            <span className="mb-shead-t">{d.category_name ?? "Part"}</span>
            <span style={{ marginLeft: "auto" }}>{cartBtn}</span>
          </div>
          <div className="mb-sbody">
            {/* One photo: exactly what it always was. More than one: a carousel
                (Ian, 2026-09-25). The big image still opens the lightbox, at
                the photo you are looking at — `photos` is the order both use,
                so "photo 2 of 4" means the same in each. Today only one part in
                the catalogue has a second live photo (CTP-CBY-006-C); the other
                158 have one each and are untouched by this. */}
            {hero && (
              <>
                <div className="mb-hero" role="button"
                  onClick={() => setViewer({
                    items: photos.map((i, n) => ({ path: i.path, label: `${d.sku} · photo ${n + 1} of ${photos.length}` })),
                    idx: at,
                  })}>
                  <PhotoImg path={hero} alt={d.name} />
                  <span className="mb-zoomtag">⤢</span>
                  {photos.length > 1 && (
                    <>
                      <button className="mb-carr prev" aria-label="Previous photo"
                        onClick={(e) => { e.stopPropagation(); setShot((at - 1 + photos.length) % photos.length); }}>‹</button>
                      <button className="mb-carr next" aria-label="Next photo"
                        onClick={(e) => { e.stopPropagation(); setShot((at + 1) % photos.length); }}>›</button>
                      <span className="mb-carcount">{at + 1} / {photos.length}</span>
                    </>
                  )}
                </div>
                {photos.length > 1 && (
                  <div className="mb-carstrip" role="tablist" aria-label="Photos of this part">
                    {photos.map((i, n) => (
                      <button key={i.id} role="tab" aria-selected={n === at}
                        aria-label={`Photo ${n + 1} of ${photos.length}`}
                        className={"mb-carthumb" + (n === at ? " on" : "")}
                        onClick={() => setShot(n)}>
                        <PhotoImg path={i.path} alt="" />
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
            <h1 className="mb-pname">{d.name}</h1>
            <div className="mb-psku mb-mono">
              {d.sku}{d.locator ? `  ·  ${d.locator}` : ""}
            </div>
            {(d.make || d.model || d.part_type || (!isClient && d.supplier)) && (
              <div className="mb-csku" style={{ marginTop: -10, marginBottom: 14 }}>
                {[d.make, d.model, d.part_type].filter(Boolean).join(" · ")}{!isClient && d.supplier ? `  ·  supplier ${d.supplier}` : ""}
              </div>
            )}

            {isClient ? (
              <>
                <div className="mb-box">
                  <div className="mb-k">Part number</div>
                  <div className="mb-v mono-pn">{d.catalogue_pn ?? d.sku}</div>
                  <div className="mb-sub">Add it to your request and we'll quote you</div>
                </div>
                {(() => {
                  // 0076: on-device book first; the 0072 online read covers a device mid-sync
                  const rb = rebateFor(d.id) ?? (myPrice && myPrice.part_id === d.id ? { ...myPrice, label: "your price" } : null);
                  return rb && (
                    <div className="mb-box" style={{ marginTop: 8 }}>
                      <div className="mb-k">Your price (excl VAT)</div>
                      <div className="mb-v" style={{ fontSize: 20 }}>
                        {rb.list_minor != null && rb.list_minor > rb.book_minor && <s className="mb-was">{fmtR(rb.list_minor)}</s>}
                        {fmtR(rb.book_minor)}
                      </div>
                      {rb.list_minor != null && rb.list_minor > rb.book_minor &&
                        <div className="mb-sub">{Math.round((1 - rb.book_minor / rb.list_minor) * 1000) / 10}% rebate on your account</div>}
                    </div>
                  );
                })()}
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
                  <div className="mb-sub">{d.price_cents != null && d.price_cents > 0 ? `${fmtR(d.price_cents)} list` : "no list price"}</div>
                </div>
              </div>
            )}
            {!isClient && rebateFor(d.id) && (
              <div className="mb-box" style={{ marginTop: 8 }}>
                <div className="mb-k">Price book (excl VAT)</div>
                <RebateTag r={rebateFor(d.id)} big />
              </div>
            )}

            {d.diagram_image && (
              <div className="mb-dgm" role="button"
                onClick={() => openDiagram(d.diagram_image!, d.id)}>
                <img src={assetUrl(d.diagram_image)} alt="Section diagram" loading="lazy" />
                {spot && (
                  <span className="mb-dgm-spot" style={{ left: `${spot.x}%`, top: `${spot.y}%` }}>
                    {spot.label}
                  </span>
                )}
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
              {(() => {
                // CAT-5: fitment, one compact line per vehicle. The note is internal wording: a staff
                // tooltip only (today it is the same "variant not yet differentiated" on every part).
                const fits = (d.fitment ?? []).map((f) => {
                  const yrs = f.year_from || f.year_to ? `${f.year_from ?? "…"}–${f.year_to ?? "on"}` : "";
                  return { k: [f.make, f.model, f.variant].filter(Boolean).join(" ") + (f.engine ? ` · ${f.engine}` : "") + (yrs ? ` · ${yrs}` : ""), note: f.note };
                }).filter((f) => f.k);
                return fits.length > 0 && (
                  <div className="mb-row"><span className="mb-rk">Fits</span>
                    <span className="mb-rv">{fits.map((f, i) => <div key={i} title={!isClient && f.note ? f.note : undefined}>{f.k}</div>)}</span>
                  </div>
                );
              })()}
              {(() => {
                // CAT-5: cross-references, minus numbers already on the sheet. A customer sees the OEM
                // numbers only; supersessions include CTP's internal legacy codes.
                const shown = new Set([d.sku, d.catalogue_pn, d.inventory_pn].filter(Boolean).map((v) => String(v).toLowerCase()));
                const xs = (d.xrefs ?? []).filter((x) => x.number && !shown.has(x.number.toLowerCase()) && (!isClient || x.type === "oem"));
                return xs.length > 0 && (
                  <div className="mb-row"><span className="mb-rk">Cross-refs</span>
                    <span className="mb-rv mb-xrefs">{xs.map((x, i) => (
                      <span key={i} className="mb-xref"><span className="mb-mono">{x.number}</span>
                        <span className="mb-dim"> {[x.brand, x.type === "oem" ? "OEM" : x.type].filter(Boolean).join(" · ")}</span></span>
                    ))}</span>
                  </div>
                );
              })()}
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

          {!isClient && d.zoho_stock && (
            <div className="mb-rows" style={{ margin: "0 16px 10px" }}>
              <div className="mb-row">
                <span className="mb-rk">Zoho</span>
                <span className="mb-rv">{d.zoho_stock.on_hand} on the shelf · {d.zoho_stock.available ?? "—"} available
                  <div className="mb-csku">Zoho Inventory{zohoStock ? " (holds the stock)" : " (rehearsal — CTP holds the stock)"}{d.zoho_stock.at ? ` · ${timeAgo(d.zoho_stock.at)}` : ""}</div>
                </span>
              </div>
              {zohoStock && (
                <div className="mb-row" style={{ gap: 8 }}>
                  <input className="mb-price-in" inputMode="numeric" placeholder="counted" value={countVal} style={{ flex: "0 0 96px" }}
                    onChange={(e) => setCountVal(e.target.value.replace(/[^0-9]/g, ""))} />
                  <button className="mb-btn s" style={{ height: 42 }} disabled={countVal === ""}
                    onClick={() => { const n = Number(countVal); void countToZoho(d.id, n).then((r) => {
                      showToast(r.ok ? { text: r.data.delta === 0 ? `${d.sku}: ${n} matches Zoho — nothing adjusted.`
                                              : `${d.sku}: counted ${n}, Zoho had ${r.data.zoho_before} → adjusted ${r.data.delta > 0 ? "+" : ""}${r.data.delta} in Zoho.` }
                                     : { text: r.message, err: true });
                      if (r.ok) { setCountVal(""); void reloadDetail(d.id); }
                    }); }}>Post count to Zoho</button>
                </div>
              )}
            </div>
          )}
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
                {/* 0053: the counter can build a request for a customer the same
                    way the customer would, so the part sheet offers it here too.
                    Issue 1 still takes stock out directly for a walk-in who is
                    paying there and then; this is for "quote it to Denver". */}
                {inCart(d.id) > 0 ? (
                  <>
                    <button className="mb-btn s" onClick={() => addToCart(d, -1)}>−</button>
                    <button className="mb-btn s" style={{ flex: "0 0 110px" }}
                      onClick={() => setTab("cart")}>{inCart(d.id)} on counter</button>
                    <button className="mb-btn s" onClick={() => addToCart(d, 1)}>+</button>
                  </>
                ) : (
                  <button className="mb-btn s" onClick={() => addToCart(d, 1)}>Add to order</button>
                )}
                <button className="mb-btn p" onClick={() => issueOne(d)}
                  disabled={d.stock.length === 0}>Issue 1</button>
                <button className="mb-btn s" onClick={() => setCounterOpen(true)}
                  disabled={d.stock.length === 0}>Count</button>
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
        <DiagramView drawings={drawings} start={diagram.idx} deepPart={diagram.part} canEdit={!isClient} staff={!isClient}
          onClose={() => { setDiagram(null); if (/^#dg=/.test(location.hash)) history.replaceState(null, "", location.pathname + location.search); }}
          onOpenPart={(pid) => { void openPart(pid); }}
          onEditMarkers={(path, label) => setHotspotEditor({ path, label })}
          /* 0053: staff get this too now — building an order off the drawing is
             exactly how a counter conversation goes ("the hinge, and the lock").
             Wording differs because for staff it is somebody else's order. */
          onAddToRequest={(p: DiagramPart, n: number) => {
            addToCart({ id: p.id, sku: p.sku, name: p.name } as Detail, n);
            showToast({ text: isClient
              ? `${p.sku} × ${n} added to your request`
              : `${p.sku} × ${n} on the counter` });
          }}
          inRequest={inCart} headerExtra={cartBtn} />
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

      {newVersion && (
        <div className="mb-toast" style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ flex: 1 }}>A new version of CTP Core is ready.</span>
          <button className="mb-chip on" onClick={() => window.location.reload()}>Reload</button>
        </div>
      )}

      {poStep && (
        <div className="mb-toast" role="dialog" aria-label="Accept with your PO"
          style={{ display: "flex", flexDirection: "column", alignItems: "stretch", gap: 10 }}>
          <span>Accept <b>{poStep.r.number}</b>? We raise your sales order with your purchase order and reserve the parts.</span>
          <label style={{ fontSize: 13, fontWeight: 700 }}>Your PO number (required)
            <input className="mb-of-q" style={{ marginTop: 6, padding: "0 12px" }} autoFocus value={poStep.po} maxLength={50}
              placeholder="e.g. PO-4471" onChange={(e) => setPoStep((p) => p && { ...p, po: e.target.value })} />
          </label>
          <label style={{ fontSize: 13, fontWeight: 700 }}>Your PO (PDF or photo){poStep.need === false ? " (optional)" : " (required)"}
            <input type="file" accept="application/pdf,image/*" style={{ marginTop: 6, display: "block" }}
              onChange={(e) => { const f = e.target.files?.[0] ?? null; setPoStep((p) => p && { ...p, file: f }); }} />
          </label>
          {poStep.credit && <div className="mb-note" style={{ margin: 0 }}>{poStep.credit}</div>}
          <div style={{ display: "flex", gap: 8 }}>
            <button className="mb-chip" style={{ flex: 1 }} onClick={() => setPoStep(null)}>Cancel</button>
            <button className="mb-chip on" style={{ flex: 1 }}
              disabled={answering === poStep.r.id || poStep.need === null || !poStep.po.trim() || (poStep.need && !poStep.file)
                || (!!poStep.file && !poStep.customerId)}
              onClick={() => { const p = poStep; setPoStep(null); void answerQuote(p.r, true, { po: p.po.trim(), file: p.file, customerId: p.customerId }); }}>
              Accept quote
            </button>
          </div>
        </div>
      )}

      {behalf && (
        <div className="mb-toast" role="dialog" aria-label="Accept on the customer's behalf"
          style={{ display: "flex", flexDirection: "column", alignItems: "stretch", gap: 10 }}>
          <span>Accept <b>{behalf.order.number}</b> for <b>{behalf.order.customer_name}</b>? This raises the confirmed sales order in Zoho with the customer's PO and holds the stock.</span>
          <label style={{ fontSize: 13, fontWeight: 700 }}>Who confirmed it, and how? (required)
            <input className="mb-of-q" style={{ marginTop: 6, padding: "0 12px" }} autoFocus value={behalf.note} maxLength={300}
              placeholder="e.g. Confirmed by Denver via phone"
              onChange={(e) => setBehalf((b) => b && { ...b, note: e.target.value })} />
          </label>
          <label style={{ fontSize: 13, fontWeight: 700 }}>Customer's PO number (required)
            <input className="mb-of-q" style={{ marginTop: 6, padding: "0 12px" }} value={behalf.po} maxLength={50}
              placeholder="e.g. PO-4471" onChange={(e) => setBehalf((b) => b && { ...b, po: e.target.value })} />
          </label>
          <label style={{ fontSize: 13, fontWeight: 700 }}>PO file (PDF or photo){behalf.need ? " (required)" : " (optional)"}
            <input type="file" accept="application/pdf,image/*" style={{ marginTop: 6, display: "block" }}
              onChange={(e) => { const f = e.target.files?.[0] ?? null; setBehalf((b) => b && { ...b, file: f }); }} />
          </label>
          {behalf.credit && <div className="mb-note" style={{ margin: 0 }}>⚠ {behalf.credit}</div>}
          <div style={{ display: "flex", gap: 8 }}>
            <button className="mb-chip" style={{ flex: 1 }} onClick={() => setBehalf(null)}>Cancel</button>
            <button className="mb-chip on" style={{ flex: 1 }}
              disabled={savingOrder || behalf.need === null || !behalf.po.trim() || (behalf.need && !behalf.file)
                || !/\w{2,}/.test(behalf.note.replace(/\b(confirmed|by|via|phone|email|e-mail)\b/gi, ""))}
              onClick={() => { const b = behalf; setBehalf(null); void acceptOnBehalf(b.order, b.note.trim(), b.po.trim(), b.file); }}>
              Accept for the customer
            </button>
          </div>
        </div>
      )}

      {pendingAct && (
        <div className="mb-toast"
          style={{ display: "flex", flexDirection: "column", alignItems: "stretch", gap: 10 }}>
          <span>
            {pendingAct.kind === "fulfil"
              ? zohoStock
                ? `Ship ${pendingAct.order.lines.reduce((t, l) => t + l.qty, 0)} item(s) for ${pendingAct.order.number} in Zoho? This creates the package and shipment from ${pendingAct.order.zoho_salesorder_number ?? "the sales order"} and takes the stock out in Zoho Inventory.`
                : `Take ${pendingAct.order.lines.reduce((t, l) => t + l.qty, 0)} item(s) out of stock for ${pendingAct.order.number}? This writes to the stock ledger and is not undone from here.`
              : pendingAct.order.zoho_salesorder_id
                ? `Close ${pendingAct.order.number}? It is invoiced in Zoho as ${pendingAct.order.zoho_invoice_number ?? "—"}${pendingAct.order.zoho_invoice_total_minor != null ? ` (${fmtR(pendingAct.order.zoho_invoice_total_minor)})` : ""} by accounts. CTP records it and links that invoice — nothing new is created in Zoho.`
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
              {pendingAct.kind === "fulfil" ? (zohoStock ? "Ship in Zoho" : "Fulfil") : pendingAct.order.zoho_salesorder_id ? "Close order" : "Issue invoice"}
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
              {cartCount > 0 && <span className="mb-tabbadge">{cartCount > 99 ? "99+" : cartCount}</span>}
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
                  const n = (orders ?? []).filter((o) => stageOf(o) === "to_price" || stageOf(o) === "to_pick").length;
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
    // mb-lb-top: this viewer is opened from the part sheet, so it has to sit
    // above it (sheet 80, this 90). Without it the photo lands behind the sheet.
    <div className="mb-lb mb-lb-top">
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
