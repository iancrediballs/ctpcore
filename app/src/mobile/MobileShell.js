import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
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
import SettingsView from "../admin/SettingsView";
import "./mobile.css";
// ─── tiny helpers ────────────────────────────────────────────────────────────
const fmtR = (cents) => cents == null ? "—" : "R " + (cents / 100).toLocaleString("en-ZA", {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
});
const qtyClass = (n) => (n <= 0 ? " zero" : n <= 2 ? " low" : "");
const timeAgo = (iso) => {
    const t = Date.parse(iso);
    if (!Number.isFinite(t))
        return iso;
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 90)
        return "just now";
    if (s < 3600)
        return `${Math.round(s / 60)}m ago`;
    if (s < 86400)
        return `${Math.round(s / 3600)}h ago`;
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
    return (_jsxs("span", { className: "mb-brand", "aria-label": "China Truck Parts", children: [_jsx("img", { className: "mb-brand-body", src: LOGO_BODY, alt: "", onError: (e) => { e.currentTarget.style.display = "none"; } }), _jsx("img", { className: "mb-brand-truck", src: LOGO_TRUCK, alt: "", "aria-hidden": "true", onError: (e) => { e.currentTarget.style.display = "none"; } })] }));
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
function tokenRole(accessToken) {
    if (!accessToken)
        return null;
    try {
        const body = accessToken.split(".")[1];
        if (!body)
            return null;
        const json = atob(body.replace(/-/g, "+").replace(/_/g, "/"));
        const claim = JSON.parse(json)?.user_role;
        return typeof claim === "string" ? claim : null;
    }
    catch {
        return null;
    }
}
const THEME_KEY = "ctp.theme";
function loadThemePref() {
    try {
        const v = localStorage.getItem(THEME_KEY);
        return v === "light" || v === "dark" ? v : "auto";
    }
    catch {
        return "auto";
    }
}
// ─── camera → bucket-sized image ─────────────────────────────────────────────
//
// A phone camera hands over 8–12MB; the catalogue needs ~200KB. Longest side
// capped at 1600px and re-encoded as JPEG on a WHITE canvas — every surface
// (thumbs, hero, lightbox) renders photos on white, so transparency would
// only ever turn into surprise black in some other viewer.
async function shrinkImage(file, maxSide = 1600) {
    const url = URL.createObjectURL(file);
    try {
        const img = await new Promise((res, rej) => {
            const el = new Image();
            el.onload = () => res(el);
            el.onerror = () => rej(new Error("That file is not an image this phone can read."));
            el.src = url;
        });
        const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.max(1, Math.round(img.naturalWidth * scale));
        const h = Math.max(1, Math.round(img.naturalHeight * scale));
        const cv = document.createElement("canvas");
        cv.width = w;
        cv.height = h;
        const cx = cv.getContext("2d");
        if (!cx)
            throw new Error("Could not process the photo on this device.");
        cx.fillStyle = "#fff";
        cx.fillRect(0, 0, w, h);
        cx.drawImage(img, 0, 0, w, h);
        const blob = await new Promise((res) => cv.toBlob(res, "image/jpeg", 0.85));
        if (!blob)
            throw new Error("Could not encode the photo.");
        return blob;
    }
    finally {
        URL.revokeObjectURL(url);
    }
}
// ─── icons (inline so the shell has zero icon deps) ──────────────────────────
const IcSearch = () => (_jsx("svg", { viewBox: "0 0 24 24", children: _jsx("path", { d: "M15.5 14h-.79l-.28-.27a6.5 6.5 0 1 0-.7.7l.27.28v.79l5 4.99L20.49 19zm-6 0A4.5 4.5 0 1 1 14 9.5 4.5 4.5 0 0 1 9.5 14z" }) }));
const IcPin = () => (_jsx("svg", { viewBox: "0 0 24 24", children: _jsx("path", { d: "M12 2a7 7 0 0 0-7 7c0 5.25 7 13 7 13s7-7.75 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 14.5 9 2.5 2.5 0 0 1 12 11.5z" }) }));
const TabHome = () => (_jsx("svg", { viewBox: "0 0 24 24", children: _jsx("path", { d: "M3 10.5 12 3l9 7.5M5 9.5V21h14V9.5M9.5 21v-6h5v6" }) }));
const TabFind = () => (_jsxs("svg", { viewBox: "0 0 24 24", children: [_jsx("circle", { cx: "10.5", cy: "10.5", r: "6.5" }), _jsx("path", { d: "m15.5 15.5 5 5" })] }));
const TabShelf = () => (_jsx("svg", { viewBox: "0 0 24 24", children: _jsx("path", { d: "M3 4h18M3 12h18M3 20h18M6 4v8M14 4v8M10 12v8M17 12v8" }) }));
const TabCart = () => (_jsxs("svg", { viewBox: "0 0 24 24", children: [_jsx("path", { d: "M4 5h2l2.2 9.5a2 2 0 0 0 2 1.5h6.4a2 2 0 0 0 2-1.5L20.5 8H7" }), _jsx("circle", { cx: "10", cy: "20", r: "1" }), _jsx("circle", { cx: "18", cy: "20", r: "1" })] }));
const TabInfo = () => (_jsxs("svg", { viewBox: "0 0 24 24", children: [_jsx("circle", { cx: "12", cy: "12", r: "9" }), _jsx("path", { d: "M12 11v5M12 8v.01" })] }));
// ─── the shell ───────────────────────────────────────────────────────────────
export default function MobileShell() {
    const status = useStatus();
    const { session, role: dbRole, signOut } = useAuth();
    const [tab, setTab] = useState("home");
    const [parts, setParts] = useState([]);
    const [cats, setCats] = useState([]);
    const [sections, setSections] = useState([]);
    const [q, setQ] = useState("");
    const [hits, setHits] = useState(null); // null = not searching
    const [chip, setChip] = useState(null);
    const [detail, setDetail] = useState(null);
    const [sheetOpen, setSheetOpen] = useState(false);
    const [counterOpen, setCounterOpen] = useState(false);
    const [toast, setToast] = useState(null);
    const [viewer, setViewer] = useState(null);
    const [cart, setCart] = useState([]);
    const [note, setNote] = useState("");
    const [sending, setSending] = useState(false);
    const [audit, setAudit] = useState(null);
    const [mine, setMine] = useState(null);
    const [answering, setAnswering] = useState(null);
    const [orders, setOrders] = useState(null);
    // A load that fails must say so. Before this, a rejected promise left `orders`
    // at null forever and the view sat on "Loading…" with no way out — one bad row
    // anywhere in the batch silently took down the whole order desk.
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [ordersErr, setOrdersErr] = useState(null);
    const [mineErr, setMineErr] = useState(null);
    const [openOrder, setOpenOrder] = useState(null);
    const [draftPrices, setDraftPrices] = useState({});
    const [savingOrder, setSavingOrder] = useState(false);
    const [photoBusy, setPhotoBusy] = useState(false);
    const fileRef = useRef(null);
    const toastTimer = useRef(undefined);
    // ── appearance ──
    const [themePref, setThemePref] = useState(loadThemePref);
    const [sysLight, setSysLight] = useState(() => window.matchMedia?.("(prefers-color-scheme: light)").matches ?? false);
    useEffect(() => {
        const mq = window.matchMedia?.("(prefers-color-scheme: light)");
        if (!mq)
            return;
        const onChange = (e) => setSysLight(e.matches);
        mq.addEventListener("change", onChange);
        return () => mq.removeEventListener("change", onChange);
    }, []);
    const light = themePref === "light" || (themePref === "auto" && sysLight);
    const pickTheme = (t) => {
        setThemePref(t);
        try {
            localStorage.setItem(THEME_KEY, t);
        }
        catch { /* private mode: lives for the session */ }
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
        api.listParts().then(setParts).catch(console.error);
        api.listSections().then(setSections).catch(console.error);
    }, []);
    useEffect(() => {
        refresh();
        api.listCategories().then(setCats).catch(console.error);
        api.listSections().then(setSections).catch(console.error);
    }, [refresh]);
    // Re-pull the catalogue when sync completes a cycle, so counts posted by
    // someone else's phone show up without a manual action.
    const lastSynced = status.lastSyncedAt?.getTime() ?? 0;
    useEffect(() => { if (lastSynced)
        refresh(); }, [lastSynced, refresh]);
    // ── search (debounced; empty query = browse) ──
    useEffect(() => {
        const term = q.trim();
        if (term.length < 3) {
            setHits(null);
            return;
        }
        let stale = false;
        const t = window.setTimeout(() => {
            api.searchParts(term)
                .then((r) => { if (!stale)
                setHits(r); })
                .catch(console.error);
        }, 150);
        return () => { stale = true; window.clearTimeout(t); };
    }, [q]);
    const showToast = useCallback((t) => {
        window.clearTimeout(toastTimer.current);
        setToast(t);
        toastTimer.current = window.setTimeout(() => setToast(null), 6000);
    }, []);
    // ── staff photo admin ──
    //
    // Every change is a server-side RPC; what this device shows only updates
    // when the changed row comes BACK down the sync stream. So after each call,
    // re-read the local part detail until the change is visible (a second or
    // two), instead of optimistically drawing a state the database hasn't
    // confirmed. The catalogue lists refresh at the end for the same reason.
    const reloadDetailUntil = useCallback(async (partId, done) => {
        for (let i = 0; i < 8; i++) {
            await new Promise((r) => window.setTimeout(r, i === 0 ? 500 : 1000));
            try {
                const fresh = await api.partDetail(partId);
                setDetail(fresh);
                if (done(fresh))
                    return;
            }
            catch {
                return; // part unreadable mid-sync; the next pass will settle it
            }
        }
    }, []);
    const makePrimary = async (imageId) => {
        const dd = detail;
        if (!dd || photoBusy)
            return;
        setPhotoBusy(true);
        try {
            await api.adminSetPrimaryPhoto(imageId);
            await reloadDetailUntil(dd.id, (f) => f.images.find((i) => i.id === imageId)?.is_primary === true);
            showToast({ text: "Primary photo updated." });
            refresh();
        }
        catch (e) {
            console.error(e);
            showToast({ text: e instanceof Error ? e.message : "Could not update the photo.", err: true });
        }
        finally {
            setPhotoBusy(false);
        }
    };
    const deletePhoto = async (imageId) => {
        const dd = detail;
        if (!dd || photoBusy)
            return;
        if (!window.confirm("Delete this photo? It disappears from every phone. (The desktop app keeps its own local copy.)"))
            return;
        setPhotoBusy(true);
        try {
            await api.adminDeletePhoto(imageId);
            await reloadDetailUntil(dd.id, (f) => !f.images.some((i) => i.id === imageId));
            showToast({ text: "Photo deleted." });
            refresh();
        }
        catch (e) {
            console.error(e);
            showToast({ text: e instanceof Error ? e.message : "Could not delete the photo.", err: true });
        }
        finally {
            setPhotoBusy(false);
        }
    };
    const addPhoto = async (file) => {
        const dd = detail;
        if (!dd || photoBusy)
            return;
        setPhotoBusy(true);
        try {
            const blob = await shrinkImage(file);
            const before = dd.images.length;
            await api.adminAddPhoto(dd.id, blob, file.name);
            showToast({ text: "Photo uploaded — syncing…" });
            await reloadDetailUntil(dd.id, (f) => f.images.length > before);
            refresh();
        }
        catch (e) {
            console.error(e);
            showToast({ text: e instanceof Error ? e.message : "Upload failed.", err: true });
        }
        finally {
            setPhotoBusy(false);
        }
    };
    const openPart = useCallback(async (partId) => {
        try {
            setDetail(await api.partDetail(partId));
            setSheetOpen(true);
            setCounterOpen(false);
        }
        catch (e) {
            console.error(e);
            showToast({ text: "Could not open that part.", err: true });
        }
    }, [showToast]);
    const reloadDetail = useCallback(async (partId) => {
        try {
            setDetail(await api.partDetail(partId));
        }
        catch (e) {
            console.error(e);
        }
        refresh();
    }, [refresh]);
    // ── posting to the ledger (the whole point of the phone) ──
    const post = useCallback(async (d, locationId, delta, reason, label) => {
        try {
            await api.postMovement(d.id, locationId, delta, reason, makeUuid(), null);
            const undo = async () => {
                try {
                    await api.postMovement(d.id, locationId, -delta, "adjustment", makeUuid(), null);
                    showToast({ text: `Undone — ${d.sku} back to where it was.` });
                    reloadDetail(d.id);
                }
                catch (e) {
                    console.error(e);
                }
            };
            showToast({ text: label, undo });
            reloadDetail(d.id);
        }
        catch (e) {
            console.error(e);
            showToast({ text: "Post failed — nothing was booked.", err: true });
        }
    }, [showToast, reloadDetail]);
    /**
     * Move stock between locations. Undo is the mirror move, not a delete —
     * consistent with everything else here, and it leaves both the mistake and
     * the correction visible in the history.
     */
    const move = useCallback(async (d, fromId, toId, qty, label) => {
        try {
            await api.transferStock(d.id, fromId, toId, qty, makeUuid(), makeUuid(), null);
            const undo = async () => {
                try {
                    await api.transferStock(d.id, toId, fromId, qty, makeUuid(), makeUuid(), null);
                    showToast({ text: `Moved back — ${d.sku} returned.` });
                    reloadDetail(d.id);
                }
                catch (e) {
                    console.error(e);
                }
            };
            showToast({ text: label, undo });
            reloadDetail(d.id);
        }
        catch (e) {
            console.error(e);
            showToast({
                text: e instanceof Error ? e.message : "Move failed — nothing was booked.",
                err: true,
            });
        }
    }, [showToast, reloadDetail]);
    // ── the request basket (clients only) ──
    const inCart = (id) => cart.find((c) => c.id === id)?.qty ?? 0;
    const addToCart = (d, n = 1) => setCart((c) => {
        const at = c.findIndex((x) => x.id === d.id);
        if (at < 0)
            return [...c, { id: d.id, sku: d.sku, name: d.name, qty: Math.max(1, n) }];
        const next = [...c];
        const qty = next[at].qty + n;
        if (qty <= 0)
            return next.filter((x) => x.id !== d.id);
        next[at] = { ...next[at], qty: Math.min(999, qty) };
        return next;
    });
    const setCartQty = (id, qty) => setCart((c) => (qty <= 0 ? c.filter((x) => x.id !== id)
        : c.map((x) => (x.id === id ? { ...x, qty: Math.min(999, qty) } : x))));
    const loadMine = useCallback(() => {
        if (!isClient)
            return;
        setMineErr(null);
        api.myRequests()
            .then((r) => { setMine(r); setMineErr(null); })
            .catch((e) => {
            console.error(e);
            setMine([]);
            setMineErr(e?.message ? String(e.message) : "Could not load your requests.");
        });
    }, [isClient]);
    // Refresh when sync lands: the moment staff price the quote, it appears.
    useEffect(() => { if (isClient)
        loadMine(); }, [isClient, lastSynced, loadMine]);
    // ── staff order desk ──
    const loadOrders = useCallback(() => {
        if (isClient)
            return;
        setOrdersErr(null);
        api.staffOrders()
            .then((r) => { setOrders(r); setOrdersErr(null); })
            .catch((e) => {
            console.error(e);
            setOrders([]);
            setOrdersErr(e?.message ? String(e.message) : "Could not load the order desk.");
        });
    }, [isClient]);
    useEffect(() => { if (!isClient)
        loadOrders(); }, [isClient, lastSynced, loadOrders]);
    /**
     * "1850", "1850.50", "1 850,50", "R1,850.50" — all of them are money here.
     * South African keyboards produce the decimal COMMA, and Number("1850,00")
     * is NaN, which the first version silently dropped and then reported as
     * "no prices to save" — a message about a different problem than the one
     * the person actually had. When both separators appear, whichever comes
     * last is the decimal point; the other is thousands.
     */
    const parseRand = (s) => {
        const t = s.replace(/[Rr\s]/g, "");
        if (t === "")
            return NaN;
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
    const savePrices = useCallback(async (o) => {
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
            const res = await api.priceQuote(o.id, lines);
            const left = Number(res?.unpriced_left ?? 0);
            showToast({ text: left > 0
                    ? `Saved — ${left} line${left === 1 ? "" : "s"} still without a price, so ${o.number} can't be accepted yet.`
                    : `${o.number} priced: ${fmtR(Number(res?.total_minor ?? 0))}. It's on their phone now.` });
            setDraftPrices({});
            loadOrders();
        }
        catch (e) {
            console.error(e);
            const msg = e instanceof Error ? e.message.replace(/^\[CTP web\] could not save prices: /, "") : "Could not save.";
            showToast({ text: msg, err: true });
        }
        finally {
            setSavingOrder(false);
        }
    }, [draftPrices, showToast, loadOrders]);
    const fillList = useCallback(async (o) => {
        setSavingOrder(true);
        try {
            const res = await api.fillQuoteFromList(o.id);
            const left = Number(res?.unpriced_left ?? 0);
            showToast({ text: left > 0
                    ? `Filled from list — ${left} part${left === 1 ? " has" : "s have"} no list price, fill by hand.`
                    : `Filled from list: ${fmtR(Number(res?.total_minor ?? 0))}.` });
            setDraftPrices({});
            loadOrders();
        }
        catch (e) {
            console.error(e);
            showToast({ text: e instanceof Error ? e.message : "Could not fill.", err: true });
        }
        finally {
            setSavingOrder(false);
        }
    }, [showToast, loadOrders]);
    const answerQuote = useCallback(async (r, accept) => {
        setAnswering(r.id);
        try {
            await api.respondToQuote(r.id, accept);
            showToast({ text: accept
                    ? `${r.number} accepted — we'll get it ready.`
                    : `${r.number} declined.` });
            loadMine();
        }
        catch (e) {
            console.error(e);
            const msg = e instanceof Error
                ? e.message.replace(/^\[CTP web\] could not send your answer: /, "")
                : "Could not send your answer.";
            showToast({ text: msg, err: true });
        }
        finally {
            setAnswering(null);
        }
    }, [showToast, loadMine]);
    const submitRequest = useCallback(async () => {
        if (cart.length === 0 || sending)
            return;
        setSending(true);
        try {
            const res = await api.requestParts(cart.map((c) => ({ part_id: c.id, qty: c.qty })), note.trim() || null);
            setCart([]);
            setNote("");
            showToast({ text: `Request ${res?.number ?? "sent"} — we'll come back to you with prices.` });
            loadMine();
        }
        catch (e) {
            console.error(e);
            // The server refuses for readable reasons (login not linked to a
            // customer, unknown part). Show them: "something went wrong" would send
            // the person round in circles.
            const msg = e instanceof Error ? e.message.replace(/^\[CTP web\] request failed: /, "") : "Could not send.";
            showToast({ text: msg, err: true });
        }
        finally {
            setSending(false);
        }
    }, [cart, note, sending, showToast]);
    /** "Issue 1": one unit out of the first location that has stock. */
    const issueOne = useCallback((d) => {
        const line = d.stock.find((s) => s.on_hand > 0) ?? d.stock[0];
        if (!line) {
            setCounterOpen(true);
            return;
        }
        post(d, line.location_id, 1, "sale", `−1 ${d.sku} issued from ${line.location_code}`);
    }, [post]);
    // ── which rows the list shows ──
    const cards = useMemo(() => {
        if (hits) {
            return hits.map((h) => ({
                id: h.id, sku: h.sku, name: h.name, category_code: null,
                qty_on_hand: h.on_hand, bin: h.bin ?? null, price_cents: h.price_cents,
                image: h.thumb ?? null,
            }));
        }
        let rows = parts;
        if (chip)
            rows = rows.filter((p) => p.category_code === chip);
        if (tab === "shelf") {
            rows = [...rows].sort((a, b) => a.bin && b.bin ? a.bin.localeCompare(b.bin, undefined, { numeric: true })
                : a.bin ? -1 : b.bin ? 1 : a.sku.localeCompare(b.sku));
        }
        return rows;
    }, [hits, parts, chip, tab]);
    const connected = status.connected;
    // ─── views ─────────────────────────────────────────────────────────────────
    // The front page: every section of the truck as a big card — the SEC
    // exploded-view drawing IS the picture of "this part of the truck" — plus
    // one search box and an All-parts card. Tap a section → the list, filtered.
    const openSection = (code) => {
        setChip(code);
        setQ("");
        setTab("find");
    };
    const homeView = (_jsxs("div", { className: "mb-view", children: [_jsxs("div", { className: "mb-top", children: [_jsxs("div", { className: "mb-brandrow", children: [_jsx(Brand, {}), _jsx("span", { className: "mb-vlabel", children: "Catalogue" }), _jsxs("span", { className: "mb-sync" + (connected ? "" : " off"), children: [_jsx("span", { className: "mb-dot" }), connected ? "synced" : "offline"] })] }), _jsx("div", { className: "mb-searchwrap", children: _jsxs("div", { className: "mb-sbox", children: [_jsx(IcSearch, {}), _jsx("input", { className: "mb-q", value: q, inputMode: "search", enterKeyHint: "search", placeholder: "Search everything\u2026", onFocus: () => setTab("find"), onChange: (e) => { setQ(e.target.value); setTab("find"); } })] }) })] }), _jsxs("div", { className: "mb-body", children: [_jsxs("button", { className: "mb-secall", onClick: () => openSection(null), children: [_jsx("span", { className: "mb-secall-t", children: "All parts" }), _jsxs("span", { className: "mb-secall-n", children: [parts.length, " in the catalogue \u2192"] })] }), _jsx("div", { className: "mb-secgrid", children: sections.filter((s) => s.parts > 0).map((s) => (_jsxs("button", { className: "mb-seccard", onClick: () => openSection(s.code), children: [_jsx("img", { className: "mb-secimg", src: assetUrl(s.image), alt: "", loading: "lazy", onError: (e) => {
                                        // locator missing (new category, nothing generated yet) → the
                                        // OEM drawing still says more than an empty box does
                                        const el = e.currentTarget;
                                        if (s.diagram && !el.dataset.fell) {
                                            el.dataset.fell = "1";
                                            el.classList.add("dgm"); // white plate: the OEM art is black-on-white
                                            el.src = assetUrl(s.diagram);
                                        }
                                        else
                                            el.style.visibility = "hidden";
                                    } }), _jsxs("span", { className: "mb-secbar", children: [_jsx("span", { className: "mb-secname", children: s.name }), _jsxs("span", { className: "mb-seccount", children: [s.parts, " parts"] })] })] }, s.id))) })] })] }));
    const listView = (_jsxs("div", { className: "mb-view", children: [_jsxs("div", { className: "mb-top", children: [_jsxs("div", { className: "mb-brandrow", children: [_jsx(Brand, {}), _jsx("span", { className: "mb-vlabel", children: tab === "shelf" ? "Shelf walk" : "Warehouse" }), _jsxs("span", { className: "mb-sync" + (connected ? "" : " off"), children: [_jsx("span", { className: "mb-dot" }), connected ? "synced" : "offline"] })] }), tab === "find" && (_jsx("div", { className: "mb-searchwrap", children: _jsxs("div", { className: "mb-sbox", children: [_jsx(IcSearch, {}), _jsx("input", { className: "mb-q", value: q, inputMode: "search", enterKeyHint: "search", placeholder: "SKU \u00B7 part no \u00B7 bin \u00B7 name\u2026", onChange: (e) => setQ(e.target.value) }), q && _jsx("button", { className: "mb-clr", onClick: () => setQ(""), children: "\u2715" })] }) }))] }), !hits && (_jsxs("div", { className: "mb-chips", children: [_jsx("button", { className: "mb-chip" + (chip == null ? " on" : ""), onClick: () => setChip(null), children: "All" }), cats.map((c) => (_jsx("button", { className: "mb-chip" + (chip === c.code ? " on" : ""), title: c.name, onClick: () => setChip(chip === c.code ? null : c.code), children: c.name }, c.id)))] })), _jsxs("div", { className: "mb-body", children: [!hits && chip && (() => {
                        const s = sections.find((x) => x.code === chip);
                        if (!s?.diagram)
                            return null;
                        return (_jsxs("div", { className: "mb-dgm", role: "button", style: { marginTop: 4 }, onClick: () => setViewer({ items: [{ path: s.diagram, label: s.name }], idx: 0 }), children: [_jsx("img", { src: assetUrl(s.diagram), alt: s.name, loading: "lazy" }), _jsx("span", { className: "mb-zoomtag", children: "\u2922" }), _jsx("div", { className: "mb-dgm-cap", children: _jsxs("span", { children: [_jsx("div", { className: "mb-dgm-k", children: "Section" }), _jsx("div", { className: "mb-dgm-v", children: s.name })] }) })] }));
                    })(), _jsx("div", { className: "mb-count", children: hits ? `${cards.length} match${cards.length === 1 ? "" : "es"}` : `${cards.length} parts` }), cards.map((p) => (_jsxs("button", { className: "mb-card", onClick: () => openPart(p.id), children: [p.image
                                ? _jsx("img", { className: "mb-thumb", src: assetUrl(p.image), alt: "", loading: "lazy" })
                                : _jsx("span", { className: "mb-thumb ph", children: _jsx(IcPin, {}) }), _jsxs("span", { className: "mb-cbody", children: [_jsx("span", { className: "mb-cname", children: p.name }), _jsx("span", { className: "mb-csku mb-mono", children: p.sku }), !isClient && (_jsxs("span", { className: "mb-cmeta", children: [p.bin && _jsxs("span", { className: "mb-bin", children: [_jsx(IcPin, {}), p.bin] }), _jsx("span", { className: "mb-qty" + qtyClass(p.qty_on_hand), children: p.qty_on_hand <= 0 ? "out" : `${p.qty_on_hand} on hand` })] }))] })] }, p.id))), cards.length === 0 && (_jsxs("div", { className: "mb-empty", children: [_jsx("h3", { children: hits ? "No matches" : "Nothing synced yet" }), _jsx("p", { children: hits
                                    ? "Try fewer characters, or a different number — search covers SKU, OEM numbers, locators, cross-references and names."
                                    : "Once the first sync completes the catalogue appears here by itself." })] }))] })] }));
    const infoView = (_jsxs("div", { className: "mb-view", children: [_jsx("div", { className: "mb-top", children: _jsxs("div", { className: "mb-brandrow", children: [_jsx(Brand, {}), _jsx("span", { className: "mb-vlabel", children: "This device" }), _jsxs("span", { className: "mb-sync" + (connected ? "" : " off"), children: [_jsx("span", { className: "mb-dot" }), connected ? "synced" : "offline"] })] }) }), _jsxs("div", { className: "mb-body", children: [!isClient && (role === "manager" || role === "admin") && (_jsxs("button", { className: "mb-settings-cta", onClick: () => setSettingsOpen(true), children: [_jsxs("span", { children: [_jsx("b", { children: "Settings" }), _jsx("small", { children: "Company details, order emails, staff, warehouses, pricing" })] }), _jsx("span", { className: "mb-chev", children: "\u203A" })] })), _jsxs("div", { className: "mb-rows", children: [_jsxs("div", { className: "mb-row", children: [_jsx("span", { className: "mb-rk", children: "Signed in" }), _jsx("span", { className: "mb-rv", children: session?.user.email ?? "—" })] }), _jsxs("div", { className: "mb-row", children: [_jsx("span", { className: "mb-rk", children: "Access level" }), _jsx("span", { className: "mb-rv", children: tokenRole(session?.access_token)
                                            ?? _jsx("span", { style: { color: "var(--warn)" }, children: "not in your token" }) })] }), _jsxs("div", { className: "mb-row", children: [_jsx("span", { className: "mb-rk", children: "Sync" }), _jsx("span", { className: "mb-rv", children: connected ? "connected" : "offline — writes queue locally" })] }), _jsxs("div", { className: "mb-row", children: [_jsx("span", { className: "mb-rk", children: "Last synced" }), _jsx("span", { className: "mb-rv", children: status.lastSyncedAt ? timeAgo(status.lastSyncedAt.toISOString()) : "never" })] }), _jsxs("div", { className: "mb-row", children: [_jsx("span", { className: "mb-rk", children: "Catalogue" }), _jsxs("span", { className: "mb-rv", children: [parts.length, " parts"] })] })] }), _jsx("div", { className: "mb-count", children: "Appearance" }), _jsxs("div", { className: "mb-rows", children: [_jsxs("div", { className: "mb-row", children: [_jsx("span", { className: "mb-rk", children: "Theme" }), _jsx("span", { className: "mb-seg", children: ["auto", "light", "dark"].map((t) => (_jsx("button", { className: "mb-segbtn" + (themePref === t ? " on" : ""), onClick: () => pickTheme(t), children: t === "auto" ? "Auto" : t === "light" ? "Light" : "Dark" }, t))) })] }), themePref === "auto" && (_jsxs("div", { className: "mb-row", children: [_jsx("span", { className: "mb-rk", children: "Following" }), _jsx("span", { className: "mb-rv", children: sysLight ? "phone · light" : "phone · dark" })] }))] }), _jsx("div", { className: "mb-count", children: "Data on this device" }), audit === null ? (_jsx("button", { className: "mb-btn s", style: { width: "100%" }, onClick: () => {
                            api.deviceAudit()
                                .then(setAudit).catch((e) => { console.error(e); setAudit([]); });
                        }, children: "Check what synced" })) : (_jsx("div", { className: "mb-rows", children: audit.map((a) => {
                            // On a client device these must be zero. Anything else is a leak,
                            // so it is coloured like one rather than left to be noticed.
                            const shouldBeEmpty = isClient && [
                                "part_cost", "price", "price_tier", "stock_policy", "stock_movement",
                                "location", "customer", "sales_order", "sales_line", "part_alias",
                            ].includes(a.table);
                            const bad = shouldBeEmpty && a.rows > 0;
                            return (_jsxs("div", { className: "mb-row", children: [_jsx("span", { className: "mb-rk mb-mono", style: { flex: 1 }, children: a.table }), _jsxs("span", { className: "mb-rv", style: {
                                            color: bad ? "var(--red)" : a.rows > 0 ? "var(--green)" : "var(--dimmer)",
                                        }, children: [a.rows < 0 ? "not synced" : a.rows, bad ? "  ⚠ should be 0" : ""] })] }, a.table));
                        }) })), _jsx("button", { className: "mb-btn s", style: { width: "100%", marginTop: 14 }, onClick: () => { void signOut(); }, children: "Sign out" }), _jsxs("div", { className: "mb-note", children: ["Counts posted here go to the ", _jsx("b", { children: "stock ledger" }), " \u2014 nothing is ever overwritten. Working offline is fine: movements queue on the phone and post themselves when signal returns."] }), !tokenRole(session?.access_token) && (_jsxs("div", { className: "mb-note", children: [_jsx("b", { children: "Access level missing." }), " Your sign-in token doesn't carry a role yet, which is what decides the data this device is allowed to hold. Until the access-token hook is switched on, every signed-in device receives everything. Sign out and back in after it is enabled."] }))] })] }));
    // ─── staff: the order desk ─────────────────────────────────────────────────
    const STAGES = [
        { key: "to_price", label: "Needs pricing", hint: "came in from a customer" },
        { key: "with_customer", label: "With the customer", hint: "quoted, waiting on their answer" },
        { key: "to_pick", label: "Ready to pick", hint: "accepted — pull the stock" },
    ];
    const ordersView = (_jsxs("div", { className: "mb-view", children: [_jsx("div", { className: "mb-top", children: _jsxs("div", { className: "mb-brandrow", children: [_jsx(Brand, {}), _jsx("span", { className: "mb-vlabel", children: "Orders" }), _jsxs("span", { className: "mb-sync" + (connected ? "" : " off"), children: [_jsx("span", { className: "mb-dot" }), connected ? "synced" : "offline"] })] }) }), _jsxs("div", { className: "mb-body", children: [orders === null && !ordersErr && _jsx("div", { className: "mb-count", children: "Loading\u2026" }), ordersErr && (_jsxs("div", { className: "mb-empty", children: [_jsx("div", { children: "Could not load the order desk." }), _jsx("div", { className: "mb-csku", style: { marginTop: 6 }, children: ordersErr }), _jsx("button", { className: "mb-btn s", style: { marginTop: 14, maxWidth: 220, margin: "14px auto 0" }, onClick: loadOrders, children: "Try again" })] })), orders !== null && !ordersErr && orders.length === 0 && (_jsx("div", { className: "mb-empty", children: "No orders on the desk." })), orders && STAGES.map((s) => {
                        const inStage = orders.filter((o) => o.stage === s.key);
                        if (inStage.length === 0)
                            return null;
                        return (_jsxs("div", { children: [_jsxs("div", { className: "mb-count", children: [s.label, " \u00B7 ", inStage.length, " \u2014 ", s.hint] }), inStage.map((o) => {
                                    const open = openOrder === o.id;
                                    return (_jsxs("div", { className: "mb-rows", style: { marginBottom: 12 }, children: [_jsxs("button", { className: "mb-row", style: { width: "100%", background: "none", border: 0, textAlign: "left" }, onClick: () => { setOpenOrder(open ? null : o.id); setDraftPrices({}); }, children: [_jsxs("span", { style: { flex: 1, minWidth: 0 }, children: [_jsx("div", { className: "mb-cname", children: o.customer_name }), _jsxs("div", { className: "mb-csku mb-mono", children: [o.number, " \u00B7 ", o.lines.length, " line", o.lines.length === 1 ? "" : "s"] })] }), _jsx("span", { className: "mb-rv", children: o.total_minor > 0 ? fmtR(o.total_minor) : _jsx("span", { style: { color: "var(--warn)" }, children: "no price" }) })] }), open && (_jsxs(_Fragment, { children: [o.notes && (_jsxs("div", { className: "mb-row", children: [_jsx("span", { className: "mb-rk", children: "Their note" }), _jsx("span", { className: "mb-rv", children: o.notes })] })), o.lines.map((l) => (_jsxs("div", { className: "mb-row", children: [_jsxs("span", { style: { flex: 1, minWidth: 0 }, children: [_jsxs("div", { className: "mb-cname", children: [l.qty, " \u00D7 ", l.name] }), _jsx("div", { className: "mb-csku mb-mono", children: l.catalogue_pn ?? l.sku })] }), o.stage === "to_price" ? (_jsx("input", { className: "mb-price-in", inputMode: "decimal", placeholder: "0.00", value: draftPrices[l.id] ?? (l.unit_price_minor > 0 ? String(l.unit_price_minor / 100) : ""), onChange: (e) => setDraftPrices((d) => ({ ...d, [l.id]: e.target.value })) })) : (_jsx("span", { className: "mb-rv", children: fmtR(l.unit_price_minor * l.qty) }))] }, l.id))), o.stage === "to_price" && (o.lines.length === 0 ? (_jsxs("div", { className: "mb-row", children: [_jsx("span", { className: "mb-rk", children: "Empty" }), _jsx("span", { className: "mb-rv", style: { color: "var(--warn)" }, children: "no lines on this order \u2014 nothing to price" })] })) : (_jsxs("div", { className: "mb-row", style: { gap: 10 }, children: [_jsx("button", { className: "mb-btn s", style: { height: 46 }, disabled: savingOrder, onClick: () => { void fillList(o); }, children: "Fill from list" }), _jsx("button", { className: "mb-btn p", style: { height: 46 }, disabled: savingOrder, onClick: () => { void savePrices(o); }, children: savingOrder ? "Saving…" : "Send quote" })] }))), o.stage === "with_customer" && (_jsxs("div", { className: "mb-row", children: [_jsx("span", { className: "mb-rk", children: "Waiting" }), _jsxs("span", { className: "mb-rv", children: ["sent ", timeAgo(o.created_at), " \u00B7 they see it on their phone"] })] })), o.stage === "to_pick" && (_jsxs("div", { className: "mb-row", children: [_jsx("span", { className: "mb-rk", children: "Accepted" }), _jsx("span", { className: "mb-rv", style: { color: "var(--green)" }, children: o.client_responded_at ? timeAgo(o.client_responded_at) : "by the customer" })] }))] }))] }, o.id));
                                })] }, s.key));
                    }), orders && orders.length === 0 && (_jsxs("div", { className: "mb-empty", children: [_jsx("h3", { children: "No orders yet" }), _jsx("p", { children: "Customer requests land here the moment they're sent." })] })), _jsxs("div", { className: "mb-note", children: ["Pricing here writes to the cloud, so the customer sees it. The desktop app keeps its own separate database \u2014 pricing there does ", _jsx("b", { children: "not" }), "reach anyone's phone."] })] })] }));
    const cartView = (_jsxs("div", { className: "mb-view", children: [_jsx("div", { className: "mb-top", children: _jsxs("div", { className: "mb-brandrow", children: [_jsx(Brand, {}), _jsx("span", { className: "mb-vlabel", children: "Your request" }), _jsxs("span", { className: "mb-sync" + (connected ? "" : " off"), children: [_jsx("span", { className: "mb-dot" }), connected ? "online" : "offline"] })] }) }), _jsxs("div", { className: "mb-body", children: [cart.length === 0 ? (
                    // The full pitch only when there is nothing else on this screen —
                    // with quotes listed below it, a big "nothing here" panel reads as
                    // if their history had vanished.
                    (mine && mine.length > 0) ? (_jsx("div", { className: "mb-count", children: "Nothing new in your basket" })) : (_jsxs("div", { className: "mb-empty", children: [_jsx("h3", { children: "Nothing in your request yet" }), _jsxs("p", { children: ["Find the parts you need and tap ", _jsx("b", { children: "Add to request" }), ". Send the lot in one go and we'll come back to you with prices and availability."] })] }))) : (_jsxs(_Fragment, { children: [_jsxs("div", { className: "mb-count", children: [cart.length, " part", cart.length === 1 ? "" : "s"] }), _jsx("div", { className: "mb-rows", children: cart.map((c) => (_jsxs("div", { className: "mb-row", children: [_jsxs("span", { style: { flex: 1, minWidth: 0 }, children: [_jsx("div", { className: "mb-cname", children: c.name }), _jsx("div", { className: "mb-csku mb-mono", children: c.sku })] }), _jsxs("span", { style: { display: "flex", alignItems: "center", gap: 8 }, children: [_jsx("button", { className: "mb-chip", onClick: () => setCartQty(c.id, c.qty - 1), children: "\u2212" }), _jsx("b", { style: { minWidth: 24, textAlign: "center" }, children: c.qty }), _jsx("button", { className: "mb-chip", onClick: () => setCartQty(c.id, c.qty + 1), children: "+" })] })] }, c.id))) }), _jsx("textarea", { className: "mb-note-in", rows: 3, value: note, maxLength: 2000, placeholder: "Anything else we should know? Vehicle, urgency, delivery\u2026", onChange: (e) => setNote(e.target.value) }), _jsx("div", { className: "mb-note", children: "We'll price this and come back to you. Nothing is ordered or charged by sending it." })] })), mineErr && (_jsxs("div", { className: "mb-empty", children: [_jsx("div", { children: "Could not load your quotes." }), _jsx("div", { className: "mb-csku", style: { marginTop: 6 }, children: mineErr }), _jsx("button", { className: "mb-btn s", style: { marginTop: 14, maxWidth: 220, margin: "14px auto 0" }, onClick: loadMine, children: "Try again" })] })), mine && mine.length > 0 && (_jsxs(_Fragment, { children: [_jsx("div", { className: "mb-count", style: { marginTop: 22 }, children: "Sent to us" }), mine.map((r) => {
                                const awaiting = r.status === "quote" && r.priced;
                                return (_jsxs("div", { className: "mb-rows", style: { marginBottom: 12 }, children: [_jsxs("div", { className: "mb-row", children: [_jsx("span", { className: "mb-rk mb-mono", style: { flex: "0 0 auto" }, children: r.number }), _jsx("span", { className: "mb-rv", children: awaiting ? _jsx("b", { style: { color: "var(--amber)" }, children: "Quote ready" })
                                                        : r.status === "quote" ? "With us for pricing"
                                                            : r.status === "confirmed" ? _jsx("b", { style: { color: "var(--green)" }, children: "Accepted" })
                                                                : r.status === "cancelled" ? "Declined"
                                                                    : r.status === "fulfilled" ? "Ready for collection"
                                                                        : r.status === "invoiced" ? "Invoiced"
                                                                            : r.status })] }), r.lines.map((l) => (_jsxs("div", { className: "mb-row", children: [_jsxs("span", { style: { flex: 1, minWidth: 0 }, children: [_jsxs("div", { className: "mb-cname", children: [l.qty, " \u00D7 ", l.name] }), _jsx("div", { className: "mb-csku mb-mono", children: l.catalogue_pn ?? l.sku })] }), (l.unit_price_minor ?? 0) > 0 && (_jsx("span", { className: "mb-rv", children: fmtR((l.unit_price_minor ?? 0) * l.qty) }))] }, l.id))), r.priced && (_jsxs("div", { className: "mb-row", children: [_jsx("span", { className: "mb-rk", children: "Total" }), _jsxs("span", { className: "mb-rv", children: [_jsx("b", { children: fmtR(r.total_minor) }), " excl VAT"] })] })), awaiting && (_jsxs("div", { className: "mb-row", style: { gap: 10 }, children: [_jsx("button", { className: "mb-btn s", style: { height: 46 }, disabled: answering === r.id, onClick: () => { void answerQuote(r, false); }, children: "Decline" }), _jsx("button", { className: "mb-btn p", style: { height: 46 }, disabled: answering === r.id, onClick: () => { void answerQuote(r, true); }, children: answering === r.id ? "Sending…" : "Accept quote" })] }))] }, r.id));
                            })] }))] }), cart.length > 0 && (_jsxs("div", { className: "mb-actions", children: [_jsx("button", { className: "mb-btn s", style: { flex: "0 0 96px" }, onClick: () => setCart([]), disabled: sending, children: "Clear" }), _jsx("button", { className: "mb-btn p", onClick: () => { void submitRequest(); }, disabled: sending, children: sending ? "Sending…" : `Send request (${cart.length})` })] }))] }));
    // ─── part sheet ────────────────────────────────────────────────────────────
    const d = detail;
    const hero = d?.images.find((i) => i.is_primary)?.path ?? d?.images[0]?.path ?? null;
    const mainBin = d?.stock.find((s) => s.bin)?.bin ?? null;
    const sheet = (_jsxs("div", { className: "mb-sheet" + (sheetOpen ? " open" : ""), children: [d && (_jsxs(_Fragment, { children: [_jsxs("div", { className: "mb-shead", children: [_jsx("button", { className: "mb-back", onClick: () => { setSheetOpen(false); setCounterOpen(false); }, children: "\u2039" }), _jsx("span", { className: "mb-shead-t", children: d.category_name ?? "Part" })] }), _jsxs("div", { className: "mb-sbody", children: [hero && (_jsxs("div", { className: "mb-hero", role: "button", onClick: () => setViewer({
                                    items: d.images.map((i, n) => ({ path: i.path, label: `${d.sku} · photo ${n + 1} of ${d.images.length}` })),
                                    idx: Math.max(0, d.images.findIndex((i) => i.path === hero)),
                                }), children: [_jsx("img", { src: assetUrl(hero), alt: d.name }), _jsx("span", { className: "mb-zoomtag", children: "\u2922" })] })), _jsx("h1", { className: "mb-pname", children: d.name }), _jsxs("div", { className: "mb-psku mb-mono", children: [d.sku, d.locator ? `  ·  ${d.locator}` : ""] }), isClient ? (_jsxs("div", { className: "mb-box", children: [_jsx("div", { className: "mb-k", children: "Part number" }), _jsx("div", { className: "mb-v mono-pn", children: d.catalogue_pn ?? d.sku }), _jsx("div", { className: "mb-sub", children: "Add it to your request and we'll quote you" })] })) : (_jsxs("div", { className: "mb-2col", children: [_jsxs("div", { className: "mb-box hi", children: [_jsx("div", { className: "mb-k", children: "Bin" }), _jsx("div", { className: "mb-v", children: mainBin ?? "—" }), d.stock.length > 1 && _jsxs("div", { className: "mb-sub", children: [d.stock.length, " locations"] })] }), _jsxs("div", { className: "mb-box", children: [_jsx("div", { className: "mb-k", children: "On hand" }), _jsx("div", { className: "mb-v" + (d.total_on_hand <= 0 ? " z" : " g"), children: d.total_on_hand }), _jsxs("div", { className: "mb-sub", children: [fmtR(d.price_cents), " list"] })] })] })), d.diagram_image && (_jsxs("div", { className: "mb-dgm", role: "button", onClick: () => setViewer({
                                    items: [{ path: d.diagram_image, label: `${d.drawing_no ?? d.category_name ?? "Diagram"}${d.diagram_item ? ` · item ${d.diagram_item}` : ""}` }],
                                    idx: 0,
                                }), children: [_jsx("img", { src: assetUrl(d.diagram_image), alt: "Section diagram", loading: "lazy" }), _jsx("span", { className: "mb-zoomtag", children: "\u2922" }), _jsxs("div", { className: "mb-dgm-cap", children: [d.diagram_item && _jsx("span", { className: "mb-itembdg", children: d.diagram_item }), _jsxs("span", { children: [_jsx("div", { className: "mb-dgm-k", children: "Diagram" }), _jsx("div", { className: "mb-dgm-v", children: d.drawing_no ?? d.category_name ?? "" })] })] })] })), _jsxs("div", { className: "mb-rows", children: [d.catalogue_pn && _jsxs("div", { className: "mb-row", children: [_jsx("span", { className: "mb-rk", children: "OEM No" }), _jsx("span", { className: "mb-rv mb-mono", children: d.catalogue_pn })] }), d.inventory_pn && d.inventory_pn !== d.catalogue_pn &&
                                        _jsxs("div", { className: "mb-row", children: [_jsx("span", { className: "mb-rk", children: "Received as" }), _jsx("span", { className: "mb-rv mb-mono", children: d.inventory_pn })] }), d.brand && _jsxs("div", { className: "mb-row", children: [_jsx("span", { className: "mb-rk", children: "Brand" }), _jsx("span", { className: "mb-rv", children: d.brand })] }), !isClient && d.stock.filter((s) => s.on_hand !== 0 || s.bin).map((s) => (_jsxs("div", { className: "mb-row", children: [_jsx("span", { className: "mb-rk", children: s.location_code }), _jsxs("span", { className: "mb-rv", children: [s.on_hand, " on hand", s.bin ? ` · bin ${s.bin}` : ""] })] }, s.location_id))), !isClient && d.notes && _jsxs("div", { className: "mb-row", children: [_jsx("span", { className: "mb-rk", children: "Notes" }), _jsx("span", { className: "mb-rv", children: d.notes })] })] }), !isClient && (_jsxs(_Fragment, { children: [_jsxs("div", { className: "mb-count", children: ["Photos", d.images.length > 0 ? ` · ${d.images.length}` : ""] }), _jsxs("div", { className: "mb-padmin", children: [d.images.map((i, n) => (_jsxs("div", { className: "mb-pcell" + (i.is_primary ? " star" : ""), children: [_jsx("img", { src: assetUrl(i.path), alt: "", loading: "lazy", onClick: () => setViewer({
                                                            items: d.images.map((im, m) => ({ path: im.path, label: `${d.sku} · photo ${m + 1} of ${d.images.length}` })),
                                                            idx: n,
                                                        }) }), _jsxs("div", { className: "mb-pops", children: [_jsx("button", { className: "mb-pop" + (i.is_primary ? " on" : ""), "aria-label": "Make primary", disabled: photoBusy || i.is_primary, onClick: () => { void makePrimary(i.id); }, children: "\u2605" }), _jsx("button", { className: "mb-pop del", "aria-label": "Delete photo", disabled: photoBusy, onClick: () => { void deletePhoto(i.id); }, children: "\u2715" })] })] }, i.id))), _jsxs("button", { className: "mb-pcell add", disabled: photoBusy, onClick: () => fileRef.current?.click(), children: [_jsx("span", { className: "mb-addplus", children: "\uFF0B" }), _jsx("span", { children: photoBusy ? "Working…" : "Add photo" })] })] }), _jsx("input", { ref: fileRef, type: "file", accept: "image/*", hidden: true, onChange: (e) => {
                                            const f = e.target.files?.[0];
                                            e.target.value = "";
                                            if (f)
                                                void addPhoto(f);
                                        } })] })), !isClient && d.ledger.length > 0 && (_jsxs(_Fragment, { children: [_jsx("div", { className: "mb-count", children: "Recent movements" }), _jsx("div", { className: "mb-rows", children: d.ledger.slice(0, 8).map((m) => (_jsxs("div", { className: "mb-row", children: [_jsx("span", { className: "mb-rk", children: m.location_code }), _jsxs("span", { className: "mb-rv", children: [_jsx("b", { style: { color: m.delta > 0 ? "var(--green)" : "var(--red)" }, children: m.delta > 0 ? `+${m.delta}` : m.delta }), "  ", m.reason, " \u00B7 ", timeAgo(m.created_at)] })] }, m.id))) })] }))] }), _jsx("div", { className: "mb-actions", children: isClient ? (inCart(d.id) > 0 ? (_jsxs(_Fragment, { children: [_jsx("button", { className: "mb-btn s", onClick: () => addToCart(d, -1), children: "\u2212" }), _jsxs("button", { className: "mb-btn s", style: { flex: "0 0 96px" }, onClick: () => setTab("cart"), children: [inCart(d.id), " in list"] }), _jsx("button", { className: "mb-btn p", onClick: () => addToCart(d, 1), children: "+" })] })) : (_jsx("button", { className: "mb-btn p", onClick: () => addToCart(d, 1), children: "Add to request" }))) : (_jsxs(_Fragment, { children: [_jsx("button", { className: "mb-btn p", onClick: () => issueOne(d), disabled: d.stock.length === 0, children: "Issue 1" }), _jsx("button", { className: "mb-btn s", onClick: () => setCounterOpen(true), disabled: d.stock.length === 0, children: "Count / receive" })] })) })] })), d && counterOpen && (_jsx(Counter, { d: d, onPost: post, onMove: move, onClose: () => setCounterOpen(false) }))] }));
    // Settings takes the whole screen rather than living inside a tab: it is a
    // different mode of use (setting the business up) from everything else here
    // (running it), and mixing the two invites a mis-tap on a live order desk.
    if (settingsOpen) {
        return (_jsx("div", { className: "mb-root" + (light ? " light" : ""), children: _jsx(SettingsView, { role: role, onClose: () => setSettingsOpen(false) }) }));
    }
    return (_jsxs("div", { className: "mb-root" + (light ? " light" : ""), children: [tab === "home" ? homeView
                : tab === "info" ? infoView
                    : tab === "cart" ? (isClient ? cartView : ordersView)
                        : listView, sheet, viewer && (_jsx(Lightbox, { items: viewer.items, start: viewer.idx, onClose: () => setViewer(null) })), toast && (_jsxs("div", { className: "mb-toast" + (toast.err ? " err" : ""), style: { display: "flex", alignItems: "center", gap: 12 }, children: [_jsx("span", { style: { flex: 1 }, children: toast.text }), toast.undo && (_jsx("button", { className: "mb-chip on", onClick: () => { setToast(null); toast.undo?.(); }, children: "Undo" }))] })), _jsxs("nav", { className: "mb-tabs", children: [_jsxs("button", { className: "mb-tab" + (tab === "home" ? " on" : ""), onClick: () => { setTab("home"); setQ(""); setChip(null); setSheetOpen(false); }, children: [_jsx(TabHome, {}), "Home"] }), _jsxs("button", { className: "mb-tab" + (tab === "find" ? " on" : ""), onClick: () => { setTab("find"); setSheetOpen(false); }, children: [_jsx(TabFind, {}), "Find"] }), isClient ? (_jsxs("button", { className: "mb-tab" + (tab === "cart" ? " on" : ""), onClick: () => { setTab("cart"); setSheetOpen(false); }, children: [_jsxs("span", { className: "mb-tabwrap", children: [_jsx(TabCart, {}), cart.length > 0 && _jsx("span", { className: "mb-tabbadge", children: cart.length })] }), "Request"] })) : (_jsxs(_Fragment, { children: [_jsxs("button", { className: "mb-tab" + (tab === "shelf" ? " on" : ""), onClick: () => { setTab("shelf"); setQ(""); setSheetOpen(false); }, children: [_jsx(TabShelf, {}), "Shelf"] }), _jsxs("button", { className: "mb-tab" + (tab === "cart" ? " on" : ""), onClick: () => { setTab("cart"); setSheetOpen(false); }, children: [_jsxs("span", { className: "mb-tabwrap", children: [_jsx(TabCart, {}), (() => {
                                                const n = (orders ?? []).filter((o) => o.stage === "to_price" || o.stage === "to_pick").length;
                                                return n > 0 ? _jsx("span", { className: "mb-tabbadge", children: n }) : null;
                                            })()] }), "Orders"] })] })), _jsxs("button", { className: "mb-tab" + (tab === "info" ? " on" : ""), onClick: () => { setTab("info"); setSheetOpen(false); }, children: [_jsx(TabInfo, {}), "Info"] })] })] }));
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
function Lightbox({ items, start, onClose }) {
    const [idx, setIdx] = useState(Math.min(Math.max(start, 0), items.length - 1));
    const stageRef = useRef(null);
    const imgRef = useRef(null);
    const t = useRef({ s: 1, x: 0, y: 0 });
    const ptrs = useRef(new Map());
    const pinch = useRef(null);
    const drag = useRef(null);
    const lastTap = useRef(0);
    const [zoomed, setZoomed] = useState(false);
    const apply = (animate = false) => {
        const el = imgRef.current;
        if (!el)
            return;
        el.style.transition = animate ? "transform .18s ease-out" : "none";
        el.style.transform = `translate(${t.current.x}px, ${t.current.y}px) scale(${t.current.s})`;
        setZoomed(t.current.s > 1.01);
    };
    const resetView = (animate = false) => { t.current = { s: 1, x: 0, y: 0 }; apply(animate); };
    /** Pointer position relative to the stage centre. */
    const rel = (e) => {
        const r = stageRef.current.getBoundingClientRect();
        return { x: e.clientX - r.left - r.width / 2, y: e.clientY - r.top - r.height / 2 };
    };
    /** Keep the image from being panned out of reach. */
    const clampPan = (animate) => {
        const img = imgRef.current, stage = stageRef.current;
        if (!img || !stage)
            return;
        const mx = Math.max(0, (img.offsetWidth * t.current.s - stage.clientWidth) / 2);
        const my = Math.max(0, (img.offsetHeight * t.current.s - stage.clientHeight) / 2);
        t.current.x = Math.min(mx, Math.max(-mx, t.current.x));
        t.current.y = Math.min(my, Math.max(-my, t.current.y));
        apply(animate);
    };
    const zoomAt = (p, sNew) => {
        const { s, x, y } = t.current;
        const c = { x: (p.x - x) / s, y: (p.y - y) / s };
        t.current = { s: sNew, x: p.x - c.x * sNew, y: p.y - c.y * sNew };
        if (sNew <= 1.01)
            t.current = { s: 1, x: 0, y: 0 };
        clampPan(true);
    };
    const onDown = (e) => {
        stageRef.current?.setPointerCapture(e.pointerId);
        ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (ptrs.current.size === 2) {
            const [a, b] = [...ptrs.current.values()];
            const d0 = Math.hypot(a.x - b.x, a.y - b.y);
            const m = rel({ clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2 });
            const { s, x, y } = t.current;
            pinch.current = { d0: Math.max(d0, 1), s0: s, cx: (m.x - x) / s, cy: (m.y - y) / s };
            drag.current = null;
        }
        else if (ptrs.current.size === 1) {
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
    const onMove = (e) => {
        if (!ptrs.current.has(e.pointerId))
            return;
        ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pinch.current && ptrs.current.size >= 2) {
            const [a, b] = [...ptrs.current.values()];
            const d = Math.max(Math.hypot(a.x - b.x, a.y - b.y), 1);
            const m = rel({ clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2 });
            const s = Math.min(6, Math.max(1, pinch.current.s0 * (d / pinch.current.d0)));
            t.current = { s, x: m.x - pinch.current.cx * s, y: m.y - pinch.current.cy * s };
            apply();
        }
        else if (drag.current) {
            const dx = e.clientX - drag.current.px, dy = e.clientY - drag.current.py;
            if (Math.abs(dx) + Math.abs(dy) > 6)
                drag.current.moved = true;
            if (t.current.s > 1.01) {
                t.current.x = drag.current.x0 + dx;
                t.current.y = drag.current.y0 + dy;
                apply();
            }
        }
    };
    const onUp = (e) => {
        const wasDrag = drag.current;
        ptrs.current.delete(e.pointerId);
        if (ptrs.current.size < 2)
            pinch.current = null;
        if (ptrs.current.size === 0) {
            if (t.current.s > 1.01) {
                clampPan(true);
            }
            else if (wasDrag && wasDrag.moved && items.length > 1) {
                // swipe left/right at 1× flips through the photos
                const dx = e.clientX - wasDrag.px;
                if (dx < -60 && idx < items.length - 1) {
                    setIdx(idx + 1);
                    resetView();
                }
                else if (dx > 60 && idx > 0) {
                    setIdx(idx - 1);
                    resetView();
                }
            }
            drag.current = null;
        }
    };
    const onWheel = (e) => {
        zoomAt(rel(e), Math.min(6, Math.max(1, t.current.s * (e.deltaY < 0 ? 1.18 : 0.85))));
    };
    const item = items[idx];
    return (_jsxs("div", { className: "mb-lb", children: [_jsxs("div", { className: "mb-lb-head", children: [_jsx("button", { className: "mb-back", onClick: onClose, children: "\u2715" }), _jsx("span", { className: "mb-lb-cap", children: item.label }), zoomed && _jsx("button", { className: "mb-chip", onClick: () => resetView(true), children: "Fit" })] }), _jsx("div", { ref: stageRef, className: "mb-lb-stage", onPointerDown: onDown, onPointerMove: onMove, onPointerUp: onUp, onPointerCancel: onUp, onWheel: onWheel, children: _jsx("img", { ref: imgRef, className: "mb-lb-img", src: assetUrl(item.path), alt: item.label, draggable: false, onLoad: () => resetView() }) }), items.length > 1 && (_jsx("div", { className: "mb-lb-dots", children: items.map((_, n) => (_jsx("span", { className: "mb-lb-dot" + (n === idx ? " on" : ""), onClick: () => { setIdx(n); resetView(); } }, n))) })), !zoomed && _jsxs("div", { className: "mb-lb-hint", children: ["pinch or double-tap to zoom", items.length > 1 ? " · swipe for more" : ""] })] }));
}
// ─── the counter ─────────────────────────────────────────────────────────────
// Pick a location, set a quantity with the big paddles, then Receive or Issue.
// The sign is decided by the BUTTON, not the stepper — the stepper is always a
// positive "how many", which survives gloves and hurry better than a signed
// number ever did.
function Counter({ d, onPost, onMove, onClose }) {
    const [locId, setLocId] = useState(d.stock.find((s) => s.on_hand > 0)?.location_id ?? d.stock[0]?.location_id ?? null);
    const [n, setN] = useState(1);
    // Moving is a different intent from booking stock in or out, so it gets its
    // own mode rather than a third button that silently needs a second location.
    const [moving, setMoving] = useState(false);
    const [destId, setDestId] = useState(null);
    const loc = d.stock.find((s) => s.location_id === locId) ?? null;
    const dest = d.stock.find((s) => s.location_id === destId) ?? null;
    const canMove = d.stock.length > 1;
    const fire = (reason, label) => {
        if (locId == null)
            return;
        void onPost(d, locId, n, reason, label);
        onClose();
    };
    const fireMove = () => {
        if (locId == null || destId == null)
            return;
        void onMove(d, locId, destId, n, `${n} × ${d.sku} moved ${loc?.location_code ?? ""} → ${dest?.location_code ?? ""}`);
        onClose();
    };
    return (_jsxs("div", { className: "mb-sheet open", style: { zIndex: 55 }, children: [_jsxs("div", { className: "mb-shead", children: [_jsx("button", { className: "mb-back", onClick: onClose, children: "\u2039" }), _jsxs("span", { className: "mb-shead-t", children: [moving ? "Move" : "Count", " \u2014 ", d.sku] })] }), _jsxs("div", { className: "mb-sbody", children: [_jsx("div", { className: "mb-locrow", style: { marginTop: 18 }, children: d.stock.map((s) => (_jsxs("button", { className: "mb-chip" + (s.location_id === locId ? " on" : ""), onClick: () => setLocId(s.location_id), children: [s.location_code, " \u00B7 ", s.on_hand, s.bin ? ` · ${s.bin}` : ""] }, s.location_id))) }), _jsxs("div", { className: "mb-stepper", children: [_jsx("button", { className: "mb-sbtn", onClick: () => setN((v) => Math.max(1, v - 1)), children: "\u2212" }), _jsx("div", { className: "mb-sval", children: n }), _jsx("button", { className: "mb-sbtn", onClick: () => setN((v) => Math.min(999, v + 1)), children: "+" })] }), moving && (_jsxs(_Fragment, { children: [_jsx("div", { className: "mb-count", style: { marginTop: 6 }, children: "Move to" }), _jsx("div", { className: "mb-locrow", children: d.stock.filter((s) => s.location_id !== locId).map((s) => (_jsxs("button", { className: "mb-chip" + (s.location_id === destId ? " on" : ""), onClick: () => setDestId(s.location_id), children: [s.location_code, " \u00B7 ", s.on_hand, s.bin ? ` · ${s.bin}` : ""] }, s.location_id))) })] })), loc && !moving && (_jsxs("div", { className: "mb-count", style: { textAlign: "center" }, children: [loc.location_code, " has ", loc.on_hand, " now \u2192 ", loc.on_hand + n, " after receive,", " ", loc.on_hand - n, " after issue"] })), loc && moving && dest && (_jsxs("div", { className: "mb-count", style: { textAlign: "center" }, children: [loc.location_code, " ", loc.on_hand, " \u2192 ", loc.on_hand - n, " \u00B7", " ", dest.location_code, " ", dest.on_hand, " \u2192 ", dest.on_hand + n] })), moving && loc && n > loc.on_hand && (_jsxs("div", { className: "mb-count", style: { textAlign: "center", color: "var(--warn)" }, children: [loc.location_code, " only has ", loc.on_hand, ". Moving ", n, " leaves it short \u2014 do a count first if the shelf disagrees."] })), _jsx("div", { className: "mb-note", children: moving ? (_jsxs(_Fragment, { children: ["Moving writes ", _jsx("b", { children: "two" }), " ledger lines \u2014 out of one place, into the other. The total on hand does not change, only where it sits. Undo moves it straight back."] })) : (_jsxs(_Fragment, { children: [_jsx("b", { children: "Receive" }), " books stock in (a delivery, a return to shelf).", " ", _jsx("b", { children: "Issue" }), " books it out (sold or taken for a job). Both write a ledger line \u2014 Undo posts the opposite line, nothing is deleted."] })) }), canMove && (_jsx("button", { className: "mb-btn s", style: { width: "100%", marginTop: 14 }, onClick: () => { setMoving((v) => !v); setDestId(null); }, children: moving ? "← Back to receive / issue" : "Move between locations instead" }))] }), _jsx("div", { className: "mb-actions", children: moving ? (_jsxs("button", { className: "mb-btn p", disabled: locId == null || destId == null, onClick: fireMove, children: ["Move ", n, " \u2192 ", dest?.location_code ?? "…"] })) : (_jsxs(_Fragment, { children: [_jsxs("button", { className: "mb-btn s", disabled: locId == null, onClick: () => fire("receipt", `+${n} ${d.sku} received into ${loc?.location_code ?? ""}`), children: ["+ Receive ", n] }), _jsxs("button", { className: "mb-btn p", disabled: locId == null, onClick: () => fire("sale", `−${n} ${d.sku} issued from ${loc?.location_code ?? ""}`), children: ["\u2212 Issue ", n] })] })) })] }));
}
