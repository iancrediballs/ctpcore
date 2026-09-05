import { tauriBackend } from "./backend.tauri";
import { webBackend, isPortedToWeb } from "./backend.web";
/** True inside the Tauri desktop shell, false in a browser / installed PWA. */
export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const backend = isTauri ? tauriBackend : webBackend;
const call = (cmd, args) => backend.call(cmd, args);
/** Is this command usable on the current surface? Use to hide desktop-only UI. */
export const supports = (cmd) => isTauri || isPortedToWeb(cmd);
// ─── search & part identity ──────────────────────────────────────────────
export const searchParts = (query) => call("search_parts", { query });
export const partDetail = (partId) => call("part_detail", { partId });
export const listParts = () => call("list_parts");
export const listCategories = () => call("list_categories");
/** Web-only: category cards with SEC diagram + part count for the mobile home page. */
export const listSections = () => call("list_sections");
export const createPart = (name, categoryId) => call("create_part", { name, categoryId });
export const updatePart = (partId, patch) => call("update_part", { partId, patch });
export const listDeletedParts = () => call("list_deleted_parts");
export const checkDeletePart = (partId) => call("check_delete_part", { partId });
export const deletePart = (partId) => call("delete_part", { partId });
export const restorePart = (partId) => call("restore_part", { partId });
// ─── media ───────────────────────────────────────────────────────────────
export const savePartImage = (partId, filename, bytes, kind) => call("save_part_image", { partId, filename, bytes, kind });
export const removePartImage = (imageId) => call("remove_part_image", { imageId });
export const setPrimaryImage = (imageId) => call("set_primary_image", { imageId });
// ─── diagrams & hotspots (desktop-only for now) ──────────────────────────
export const listDiagrams = () => call("list_diagrams");
export const getDiagram = (diagramId) => call("get_diagram", { diagramId });
export const saveDiagram = (filename, bytes, title, imgW, imgH) => call("save_diagram", { filename, bytes, title, imgW, imgH });
export const deleteDiagram = (diagramId) => call("delete_diagram", { diagramId });
export const addHotspot = (diagramId, x, y, partId, itemNo) => call("add_hotspot", { diagramId, x, y, partId, itemNo });
export const updateHotspot = (id, x, y, partId, itemNo) => call("update_hotspot", { id, x, y, partId, itemNo });
export const deleteHotspot = (id) => call("delete_hotspot", { id });
// ─── inventory ledger ────────────────────────────────────────────────────
export const listLocations = () => call("list_locations");
export const postMovement = (partId, locationId, delta, reason, clientUuid, actorId) => call("post_movement", { partId, locationId, delta, reason, clientUuid, actorId });
/**
 * Move stock from one location to another.
 *
 * Both legs are posted under separate idempotency keys, so a retry on a bad
 * connection cannot move the stock twice — nor lose it.
 */
export const transferStock = (partId, fromLocationId, toLocationId, qty, outUuid, inUuid, actorId) => call("transfer_stock", {
    partId, fromLocationId, toLocationId, qty, outUuid, inUuid, actorId,
});
/** Web-only: row counts per table in THIS device's local database. */
export const deviceAudit = () => call("device_audit");
// ─── staff photo admin (web-only) ────────────────────────────────────────
/** Retire a photo everywhere: soft-deletes the row, then removes the file. */
export const adminDeletePhoto = (imageId) => call("admin_delete_photo", { imageId });
/** Make this photo the part's face. */
export const adminSetPrimaryPhoto = (imageId) => call("admin_set_primary_photo", { imageId });
/** Upload an (already resized) image and register it against the part. */
export const adminAddPhoto = (partId, blob, filename) => call("admin_add_photo", { partId, blob, filename });
// ─── customer requests (web-only) ────────────────────────────────────────
/** A signed-in customer asks for parts. Creates a quote-status order server-side. */
export const requestParts = (items, note) => call("request_parts", { items, note });
/** A client's own requests/quotes, newest first, with their lines. */
export const myRequests = () => call("my_requests");
// ─── staff order desk (web-only) ─────────────────────────────────────────
/** Every order, grouped by what it is waiting on. */
export const staffOrders = () => call("staff_orders");
/** Set line prices on a quote. Staff only; rules enforced in the database. */
export const priceQuote = (orderId, lines) => call("price_quote", { orderId, lines });
/** Fill every line from the current list price. */
export const fillQuoteFromList = (orderId) => call("fill_quote_from_list", { orderId });
/** Accept or decline one of your own quotes. */
export const respondToQuote = (orderId, accept) => call("respond_to_quote", { orderId, accept });
// ─── sales ───────────────────────────────────────────────────────────────
export const listCustomers = () => call("list_customers");
export const listOrders = () => call("list_orders");
export const getOrder = (orderId) => call("get_order", { orderId });
export const createOrder = (customerId, locationId) => call("create_order", { customerId, locationId });
export const addLine = (orderId, partId, qty) => call("add_line", { orderId, partId, qty });
export const updateLineQty = (lineId, qty) => call("update_line_qty", { lineId, qty });
export const removeLine = (lineId) => call("remove_line", { lineId });
export const setStatus = (orderId, status) => call("set_status", { orderId, status });
export const fulfillOrder = (orderId) => call("fulfill_order", { orderId });
export const setTaxRate = (orderId, bps) => call("set_tax_rate", { orderId, bps });
// ─── company & accounting ────────────────────────────────────────────────
export const getCompany = () => call("get_company");
export const setCompany = (company) => call("set_company", { company });
export const listExportQueue = (target) => call("list_export_queue", { target });
export const exportAccounting = (target, orderIds) => call("export_accounting", { target, orderIds });
// ─── Jefrey ──────────────────────────────────────────────────────────────
export const jefreyCatalogue = () => call("jefrey_catalogue");
export const jefreyAliases = () => call("jefrey_aliases");
export const jefreyLearn = (phrase, partId, polarity) => call("jefrey_learn", { phrase, partId, polarity });
export const jefreyForget = (phrase, partId) => call("jefrey_forget", { phrase, partId });
// ─── shell ───────────────────────────────────────────────────────────────
/** Opens an external URL in the OS browser. Desktop-only; on web use a plain <a>. */
export const openUrl = (url) => call("open_url", { url });
