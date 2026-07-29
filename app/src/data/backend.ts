// CTP Core — data transport contract.
//
// Every screen in this app used to call `invoke("cmd", args)` directly, which
// hard-wires the UI to Tauri + the Rust/rusqlite layer. A browser has no Rust,
// so the mobile PWA needs a second implementation of the same surface.
//
// This is the seam: one tiny interface, two implementations.
//   backend.tauri.ts — passthrough to invoke()      (desktop, unchanged)
//   backend.web.ts   — PowerSync SQL + Supabase     (mobile PWA)
//
// api.ts picks one at load time and exposes a named function per command.
export interface Backend {
  call<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
}
