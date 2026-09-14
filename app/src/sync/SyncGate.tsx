// The first-sync gate.
//
// WHY. The shell rendered the moment the session existed, while the first
// sync was still streaming. Every list refreshes only when lastSyncedAt moves,
// which happens once, at the first complete checkpoint — so for that whole
// stretch the sections were empty, images and diagrams did not change when
// you switched between sections, and the badge said "synced" because the
// socket was up. Ian: "you are able to click around and it seems broken".
// It was not broken, it was incomplete, and nothing on screen said so.
//
// WHAT. Until this device has completed one full sync, this renders in place
// of the shell: real numbers from the SDK (operations downloaded of total),
// a plain state name, and a Retry when the stream has been quiet for longer
// than the SDK's own socket timeout. hasSynced is persisted by the SDK, so a
// device that has synced once never sees this again — the second launch is
// local and instant, exactly as before.
//
// WHAT IT DOES NOT DO. It does not hide the app on a later reconnect, and it
// does not wait for images: those come from the storage bucket on demand and
// cache through the service worker; the catalogue is usable before them.
import { useEffect, useState } from "react";
import { useStatus } from "@powersync/react";
import { reconnectPowerSync, subscribeSyncBoot, type SyncBootState } from "./system";

// The SDK closes a silent socket after 30 s and reconnects 5 s later. Only
// after that has had its chance do we call it a stall and offer the button.
const STALL_MS = 45_000;

export function SyncGate({ children }: { children: React.ReactNode }) {
  const status = useStatus();
  const [boot, setBoot] = useState<SyncBootState>({ phase: "idle", error: null, attempt: 0 });
  useEffect(() => subscribeSyncBoot(setBoot), []);

  const done = status.hasSynced === true;
  const progress = status.downloadProgress;
  const downloaded = progress?.downloadedOperations ?? 0;
  const total = progress?.totalOperations ?? 0;

  // Stall = nothing about the picture has changed for STALL_MS. Any change to
  // the key rearms it: a reconnect, a byte of progress, a retry attempt.
  const key = `${boot.phase}:${boot.attempt}:${status.connected}:${status.connecting}:${downloaded}:${total}`;
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    setStalled(false);
    if (done) return;
    const t = setTimeout(() => setStalled(true), STALL_MS);
    return () => clearTimeout(t);
  }, [key, done]);

  const [retrying, setRetrying] = useState(false);
  if (done) return <>{children}</>;

  const streamError = status.dataFlowStatus.downloadError;
  const error = boot.error ?? (streamError ? (streamError instanceof Error ? streamError.message : String(streamError)) : null);
  const failed = boot.phase === "failed";

  let headline: string, detail: string;
  if (failed) {
    headline = "Couldn't start the catalogue";
    detail = "Part of the app didn't download. Check the connection and try again.";
  } else if (boot.phase !== "started") {
    headline = "Opening the catalogue…";
    detail = "Setting up local storage on this device.";
  } else if (total > 0) {
    headline = `Syncing ${downloaded.toLocaleString()} of ${total.toLocaleString()} records`;
    detail = status.connected ? "First time on this device — the catalogue is coming down once, then it lives here." : "Reconnecting…";
  } else if (status.connected) {
    headline = "Connected — preparing the catalogue";
    detail = "Waiting for the server to start sending records.";
  } else {
    headline = "Connecting…";
    detail = "Reaching the sync server.";
  }
  const pct = total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : 0;
  const showRetry = failed || stalled || !!streamError;

  const retry = async () => {
    setRetrying(true);
    try { await reconnectPowerSync(); }
    catch (e) { console.error("sync retry failed:", e); }
    finally { setRetrying(false); }
  };

  return (
    <div className="login-wrap">
      <div className="login-card sync-gate" role="status" aria-live="polite">
        <div className="login-brand">CTP <b>Core</b></div>
        <div className="sync-head">{headline}</div>
        <div className="sync-bar" aria-hidden={total === 0}>
          <div className={"sync-fill" + (total === 0 ? " idle" : "")} style={{ width: total > 0 ? pct + "%" : undefined }} />
        </div>
        <div className="login-sub">{detail}</div>
        {(stalled && !failed) && (
          <div className="sync-stall">Nothing has arrived for a while. The line may be slow — you can keep waiting, or retry.</div>
        )}
        {error && <div className="login-err">✕ {error}</div>}
        {showRetry && (
          <button className="login-btn" onClick={retry} disabled={retrying}>
            {retrying ? "Retrying…" : "Retry"}
          </button>
        )}
        {failed && boot.attempt > 1 && (
          <div className="login-sub">Still failing? Close the app completely and open it again.</div>
        )}
      </div>
    </div>
  );
}
