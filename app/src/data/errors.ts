// Errors the UI is meant to READ, not just catch. Kept dependency-free so any
// layer (the browser backend, a stub, the sync connector) can throw them.

/** The shelf said no. Thrown by the local check in backend.web.ts and by the
 *  server trigger (0049, SQLSTATE CT001); the UI shows the message as-is,
 *  because it is written for the counter person. */
export class ShelfRefusedError extends Error {
  constructor(message: string) { super(message); this.name = "ShelfRefusedError"; }
}

// ─── offline (SO-5) ──────────────────────────────────────────────────────────
// A server action tried with no connection used to put the browser's own
// words, "TypeError: Failed to fetch", straight into a toast. Every online-only
// action (send a request, send/accept a quote, fulfil, invoice, cancel, the
// Zoho calls) now reads the same sentence instead.

export const OFFLINE_MESSAGE =
  "You're offline — this needs a connection. Try again when you're back online.";

/** The action needs the server and the network is not there. */
export class OfflineError extends Error {
  constructor() { super(OFFLINE_MESSAGE); this.name = "OfflineError"; }
}

// What a fetch failure looks like across browsers and the Supabase clients:
// Chrome "Failed to fetch", Firefox "NetworkError when attempting to fetch
// resource", Safari "Load failed", supabase-js functions "Failed to send a
// request to the Edge Function", PostgREST "TypeError: Failed to fetch".
const NETWORK_RE = /failed to fetch|networkerror|load failed|network request failed|failed to send a request|fetch failed|err_internet_disconnected|err_name_not_resolved|err_connection/i;

/** True when an error means "could not reach the server". */
export function isOfflineError(e: unknown): boolean {
  if (e instanceof OfflineError) return true;
  const o = (e ?? {}) as { name?: unknown; message?: unknown };
  if (o.name === "FunctionsFetchError" || o.name === "AuthRetryableFetchError") return true;
  const msg = typeof o.message === "string" ? o.message : typeof e === "string" ? e : "";
  if (NETWORK_RE.test(msg)) return true;
  return e instanceof TypeError && typeof navigator !== "undefined" && navigator.onLine === false;
}

/** An error's message for a person to read, with network failures said plainly. */
export function netMsg(e: unknown): string {
  if (isOfflineError(e)) return OFFLINE_MESSAGE;
  const m = ((e ?? {}) as { message?: unknown }).message;
  return typeof m === "string" ? m : String(e);
}
