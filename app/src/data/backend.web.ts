// Web/PWA backend: PowerSync local SQLite for reads, Supabase for writes.
//
// STATUS: scaffold. Commands are ported one at a time (see PORTED below);
// anything not yet ported throws a clear error rather than failing silently,
// so a half-ported build is obvious in the console instead of showing blanks.
//
// Port order (mobile plan M1):
//   Tier 1 (lookup + Jefrey): search_parts, part_detail, list_parts,
//     list_categories, jefrey_catalogue, jefrey_aliases, jefrey_learn, get_company
//   Tier 2 (counter):         post_movement, list_locations, save_part_image
//   Tier 3 (sales):           list_customers, list_orders, get_order, create_order,
//     add_line, update_line_qty, remove_line, set_status, fulfill_order, set_tax_rate
//
// Desktop-only (never ported): the hotspot editor, save_diagram/delete_diagram,
// update_part, export_accounting, delete_part/restore_part, open_url.
import type { Backend } from "./backend";

type Handler = (args: Record<string, unknown>) => Promise<unknown>;

// Filled in as each command is ported. Empty for now — the seam lands first.
const PORTED: Record<string, Handler> = {};

export const webBackend: Backend = {
  async call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    const handler = PORTED[cmd];
    if (!handler) {
      throw new Error(
        `[CTP web] "${cmd}" is not available in the browser build yet. ` +
          `It still lives in the Rust layer — port it in src/data/backend.web.ts.`
      );
    }
    return (await handler(args ?? {})) as T;
  },
};

/** True when a command works in the browser build. Use to hide desktop-only UI on mobile. */
export function isPortedToWeb(cmd: string): boolean {
  return cmd in PORTED;
}
