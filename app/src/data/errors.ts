// Errors the UI is meant to READ, not just catch. Kept dependency-free so any
// layer (the browser backend, a stub, the sync connector) can throw them.

/** The shelf said no. Thrown by the local check in backend.web.ts and by the
 *  server trigger (0049, SQLSTATE CT001); the UI shows the message as-is,
 *  because it is written for the counter person. */
export class ShelfRefusedError extends Error {
  constructor(message: string) { super(message); this.name = "ShelfRefusedError"; }
}
