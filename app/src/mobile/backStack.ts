// Browser / phone Back closes what is open instead of leaving the app.
//
// Until 27 Nov nothing in CTP Core touched browser history (no pushState
// anywhere), so the part sheet, a drawing, a photo, Settings and every
// confirm box lived on ONE history entry. Android's Back, the browser's Back
// button and iOS swipe-back all left the app (Ian, 27 Nov).
//
// How it works: every open layer registers itself here, in the order it was
// opened. While at least one layer is open we keep exactly one "guard" entry
// on top of history. Back pops the guard; we close the newest layer and, if
// any are still open, put a fresh guard back. When the last layer is closed
// from inside the app (its own Back / ✕ button), we step back over the guard
// so history does not fill up with dead entries.
//
// One guard rather than one entry per layer on purpose: layers open and close
// in the same React commit all the time (a photo closes as the part sheet
// opens), and history.back() is asynchronous, so per-layer entries drift out
// of step with what is on screen. A single guard cannot drift.

import { useEffect, useRef } from "react";

type Layer = { close: () => void };

const stack: Layer[] = [];
const GUARD = "ctpBackGuard";
// A reload keeps the current entry. If that entry is one of our guards there
// is nothing open any more, so the first sync steps back over it.
let guarded = typeof history !== "undefined" && !!(history.state && history.state[GUARD]);
let stepping = false;      // we called history.back() to drop the guard
let queued = false;

function sync() {
  queued = false;
  if (stepping) return;    // the popstate for our own back() will re-sync
  if (stack.length > 0 && !guarded) {
    history.pushState({ ...(history.state ?? {}), [GUARD]: true }, "", location.href);
    guarded = true;
  } else if (stack.length === 0 && guarded) {
    stepping = true;
    history.back();
  }
}

function schedule() {
  if (queued) return;
  queued = true;
  // Batch: a layer closing and another opening in one commit must not
  // step back and then push again.
  window.setTimeout(sync, 0);
}

if (typeof window !== "undefined") {
  window.addEventListener("popstate", () => {
    guarded = false;
    if (stepping) { stepping = false; schedule(); return; }
    // The user pressed Back. Close the newest layer. If it refuses (the
    // marker editor saving a typed item number first), it stays in the
    // stack and the guard goes back on.
    const top = stack[stack.length - 1];
    top?.close();
    schedule();
  });
  if (guarded) schedule();
}

/** While `open` is true, Back calls `close` (newest open layer first). */
export function useBackClose(open: boolean, close: () => void) {
  const ref = useRef(close);
  ref.current = close;
  useEffect(() => {
    if (!open) return;
    const layer: Layer = { close: () => ref.current() };
    stack.push(layer);
    schedule();
    return () => {
      const i = stack.indexOf(layer);
      if (i >= 0) stack.splice(i, 1);
      schedule();
    };
  }, [open]);
}

/** replaceState that keeps our guard marker on the entry it rewrites. */
export function replaceUrl(url: string) {
  history.replaceState(history.state, "", url);
}
