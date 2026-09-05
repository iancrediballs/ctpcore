// CTP Core — the one data API every screen talks to.
//
// Views must import from here, never from "@tauri-apps/api/core" directly.
// Each function mirrors a Rust command 1:1 (same name, same args, same shape)
// and stays generic in its return type, so a call site swaps like-for-like:
//
//   before:  await invoke<Hit[]>("search_parts", { query: term })
//   after:   await api.searchParts<Hit[]>(term)
//
// On desktop this is a passthrough to invoke() — identical behaviour.
// On the mobile PWA it routes to PowerSync/Supabase instead.
import type { Backend } from "./backend";
import { tauriBackend } from "./backend.tauri";
import { webBackend, isPortedToWeb } from "./backend.web";

/** True inside the Tauri desktop shell, false in a browser / installed PWA. */
export const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const backend: Backend = isTauri ? tauriBackend : webBackend;

const call = <T>(cmd: string, args?: Record<string, unknown>): Promise<T> =>
  backend.call<T>(cmd, args);

/** Is this command usable on the current surface? Use to hide desktop-only UI. */
export const supports = (cmd: string): boolean => isTauri || isPortedToWeb(cmd);

// ─── search & part identity ──────────────────────────────────────────────
export const searchParts = <T>(query: string) => call<T>("search_parts", { query });
export const partDetail = <T>(partId: number) => call<T>("part_detail", { partId });
export const listParts = <T>() => call<T>("list_parts");
export const listCategories = <T>() => call<T>("list_categories");
/** Web-only: category cards with SEC diagram + part count for the mobile home page. */
export const listSections = <T>() => call<T>("list_sections");
export const createPart = (name: string, categoryId: number) =>
  call<number>("create_part", { name, categoryId });
export const updatePart = (partId: number, patch: Record<string, unknown>) =>
  call<void>("update_part", { partId, patch });
export const listDeletedParts = <T>() => call<T>("list_deleted_parts");
export const checkDeletePart = <T>(partId: number) => call<T>("check_delete_part", { partId });
export const deletePart = <T>(partId: number) => call<T>("delete_part", { partId });
export const restorePart = (partId: number) => call<void>("restore_part", { partId });

// ─── media ───────────────────────────────────────────────────────────────
export const savePartImage = (
  partId: number, filename: string, bytes: number[], kind: string
) => call<void>("save_part_image", { partId, filename, bytes, kind });
export const removePartImage = (imageId: number) => call<void>("remove_part_image", { imageId });
export const setPrimaryImage = (imageId: number) => call<void>("set_primary_image", { imageId });

// ─── diagrams & hotspots (desktop-only for now) ──────────────────────────
export const listDiagrams = <T>() => call<T>("list_diagrams");
export const getDiagram = <T>(diagramId: number) => call<T>("get_diagram", { diagramId });
export const saveDiagram = (
  filename: string, bytes: number[], title: string, imgW: number, imgH: number
) => call<number>("save_diagram", { filename, bytes, title, imgW, imgH });
export const deleteDiagram = (diagramId: number) => call<void>("delete_diagram", { diagramId });
export const addHotspot = (
  diagramId: number, x: number, y: number, partId: number | null, itemNo: string | null
) => call<number>("add_hotspot", { diagramId, x, y, partId, itemNo });
export const updateHotspot = (
  id: number, x: number, y: number, partId: number | null, itemNo: string | null
) => call<void>("update_hotspot", { id, x, y, partId, itemNo });
export const deleteHotspot = (id: number) => call<void>("delete_hotspot", { id });

// ─── inventory ledger ────────────────────────────────────────────────────
export const listLocations = <T>() => call<T>("list_locations");
export const postMovement = <T>(
  partId: number, locationId: number, delta: number,
  reason: string, clientUuid: string, actorId: number | null
) => call<T>("post_movement", { partId, locationId, delta, reason, clientUuid, actorId });

/**
 * Move stock from one location to another.
 *
 * Both legs are posted under separate idempotency keys, so a retry on a bad
 * connection cannot move the stock twice — nor lose it.
 */
export const transferStock = <T>(
  partId: number, fromLocationId: number, toLocationId: number,
  qty: number, outUuid: string, inUuid: string, actorId: number | null
) => call<T>("transfer_stock", {
  partId, fromLocationId, toLocationId, qty, outUuid, inUuid, actorId,
});

/** Web-only: row counts per table in THIS device's local database. */
export const deviceAudit = <T>() => call<T>("device_audit");

// ─── staff photo admin (web-only) ────────────────────────────────────────
/** Retire a photo everywhere: soft-deletes the row, then removes the file. */
export const adminDeletePhoto = <T>(imageId: number) =>
  call<T>("admin_delete_photo", { imageId });
/** Make this photo the part's face. */
export const adminSetPrimaryPhoto = <T>(imageId: number) =>
  call<T>("admin_set_primary_photo", { imageId });
/** Upload an (already resized) image and register it against the part. */
export const adminAddPhoto = <T>(partId: number, blob: Blob, filename: string) =>
  call<T>("admin_add_photo", { partId, blob, filename });

// ─── customer requests (web-only) ────────────────────────────────────────
/** A signed-in customer asks for parts. Creates a quote-status order server-side. */
export const requestParts = <T>(items: { part_id: number; qty: number }[], note: string | null) =>
  call<T>("request_parts", { items, note });
/** A client's own requests/quotes, newest first, with their lines. */
export const myRequests = <T>() => call<T>("my_requests");
// ─── staff order desk (web-only) ─────────────────────────────────────────
/** Every order, grouped by what it is waiting on. */
export const staffOrders = <T>() => call<T>("staff_orders");
/** Set line prices on a quote. Staff only; rules enforced in the database. */
export const priceQuote = <T>(orderId: number, lines: { line_id: number; unit_price_minor: number }[]) =>
  call<T>("price_quote", { orderId, lines });
/** Fill every line from the current list price. */
export const fillQuoteFromList = <T>(orderId: number) =>
  call<T>("fill_quote_from_list", { orderId });

/** Accept or decline one of your own quotes. */
export const respondToQuote = <T>(orderId: number, accept: boolean) =>
  call<T>("respond_to_quote", { orderId, accept });

// ─── sales ───────────────────────────────────────────────────────────────
export const listCustomers = <T>() => call<T>("list_customers");
export const listOrders = <T>() => call<T>("list_orders");
export const getOrder = <T>(orderId: number) => call<T>("get_order", { orderId });
export const createOrder = <T>(customerId: number, locationId: number) =>
  call<T>("create_order", { customerId, locationId });
export const addLine = <T>(orderId: number, partId: number, qty: number) =>
  call<T>("add_line", { orderId, partId, qty });
export const updateLineQty = <T>(lineId: number, qty: number) =>
  call<T>("update_line_qty", { lineId, qty });
export const removeLine = <T>(lineId: number) => call<T>("remove_line", { lineId });
export const setStatus = <T>(orderId: number, status: string) =>
  call<T>("set_status", { orderId, status });
export const fulfillOrder = <T>(orderId: number) => call<T>("fulfill_order", { orderId });
export const setTaxRate = <T>(orderId: number, bps: number) =>
  call<T>("set_tax_rate", { orderId, bps });

// ─── company & accounting ────────────────────────────────────────────────
export const getCompany = <T>() => call<T>("get_company");
export const setCompany = (company: unknown) => call<void>("set_company", { company });
export const listExportQueue = <T>(target: string) => call<T>("list_export_queue", { target });
export const exportAccounting = <T>(target: string, orderIds: number[]) =>
  call<T>("export_accounting", { target, orderIds });

// ─── Jefrey ──────────────────────────────────────────────────────────────
export const jefreyCatalogue = <T>() => call<T>("jefrey_catalogue");
export const jefreyAliases = <T>() => call<T>("jefrey_aliases");
export const jefreyLearn = (phrase: string, partId: number, polarity: number) =>
  call<void>("jefrey_learn", { phrase, partId, polarity });
export const jefreyForget = (phrase: string, partId: number) =>
  call<void>("jefrey_forget", { phrase, partId });

// ─── shell ───────────────────────────────────────────────────────────────
/** Opens an external URL in the OS browser. Desktop-only; on web use a plain <a>. */
export const openUrl = (url: string) => call<void>("open_url", { url });
