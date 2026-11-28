// Public build: @powersync/react over the seeded sql.js DB (see db.ts).
import { useEffect, useState } from "react";
import { open, getAll } from "./db";

const at = new Date();
export const useStatus = () => ({ connected: true, lastSyncedAt: at, hasSynced: true });
export function useQuery<T>(sql: string, params: unknown[] = []) {
  const [data, setData] = useState<T[]>([]);
  const key = sql + JSON.stringify(params);
  useEffect(() => { let live = true; void open().then(() => { if (live) setData(getAll<T>(sql, params)); }); return () => { live = false; }; }, [key]);
  return { data, isLoading: false, error: undefined };
}
export const PowerSyncContext = { Provider: ({ children }: { children: unknown }) => children };
// SyncBadge reads these; the public build has no sync engine and no upload queue.
export const usePowerSync = () => ({ getAll: async () => [], get: async () => null, execute: async () => ({}),
  getUploadQueueStats: async () => ({ count: 0 }), registerListener: () => () => undefined, onChange: () => () => undefined });
