// How a marker is drawn and what its tooltip says, from the backend's link
// verdict. One place for the viewer, the editor and the parts list, so a bad
// row looks the same everywhere — flagged, never blank.
import type { WebHotspot } from "../data/api";

export function markerState(h: WebHotspot): "" | "unl" | "bad" {
  return h.link === "ok" ? "" : h.link === "none" ? "unl" : "bad";
}
export function markerTitle(h: WebHotspot): string {
  const no = h.item_no ? "#" + h.item_no + " · " : "";
  switch (h.link) {
    case "ok": return `${no}${h.name ?? ""}`;
    case "none": return `${no}no part linked`;
    case "retired": return `${no}linked to a RETIRED part${h.was_sku ? ` (${h.was_sku})` : ""} — relink it in the editor`;
    default: return `${no}linked to part #${h.part_id} which no longer exists — relink it in the editor`;
  }
}
