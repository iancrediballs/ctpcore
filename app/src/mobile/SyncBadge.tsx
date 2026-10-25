// The header's sync badge (SO-4). It used to be `connected ? "synced" :
// "offline"`, which said "offline" for the first seconds of every normal app
// open, said "synced" while queued stock moves were still going up, and never
// told a warehouse user whether their offline counts had left the phone.
//
//   syncing      connecting on app open, or downloading changes
//   N to send    writes queued on this device (ps_crud), online or not
//   synced       connected, nothing queued, nothing downloading
//   offline      not connected (after the first-connect window)
import { useEffect, useState } from "react";
import { usePowerSync, useStatus } from "@powersync/react";

/** How long after opening the app a not-yet-connected state still reads as
 *  "syncing" rather than "offline" — unless the browser itself says offline. */
const FIRST_CONNECT_MS = 12_000;
const POLL_MS = 2_000;

export function useSyncBadge(): { label: string; cls: string } {
  const status = useStatus();
  const db = usePowerSync();
  const [pending, setPending] = useState(0);
  const [firstConnect, setFirstConnect] = useState(true);

  useEffect(() => {
    if (status.connected) { setFirstConnect(false); return; }
    const t = window.setTimeout(() => setFirstConnect(false), FIRST_CONNECT_MS);
    return () => window.clearTimeout(t);
  }, [status.connected]);

  // The upload queue. Polled (cheap: a COUNT on a small table) and re-read on
  // every status change, so it falls to 0 as soon as the upload completes.
  useEffect(() => {
    let live = true;
    const read = () => {
      db.getUploadQueueStats()
        .then((s) => { if (live) setPending(s.count); })
        .catch(() => { /* not initialised yet */ });
    };
    read();
    const t = window.setInterval(read, POLL_MS);
    return () => { live = false; window.clearInterval(t); };
  }, [db, status]);

  const browserOffline = typeof navigator !== "undefined" && navigator.onLine === false;
  if (pending > 0) return { label: `${pending} to send`, cls: " off" };
  if (status.connected) {
    return status.dataFlowStatus?.downloading || !status.hasSynced
      ? { label: "syncing", cls: " busy" }
      : { label: "synced", cls: "" };
  }
  if (firstConnect && !browserOffline) return { label: "syncing", cls: " busy" };
  return { label: "offline", cls: " off" };
}

export function SyncBadge() {
  const { label, cls } = useSyncBadge();
  return (
    <span className={"mb-sync" + cls} aria-live="polite">
      <span className="mb-dot" />{label}
    </span>
  );
}
