const at = new Date();
export const useStatus = () => ({ connected: true, lastSyncedAt: at, hasSynced: true });
// MobileShell and SyncBadge read these now; the harness has no local DB.
export const useQuery = <T,>(_sql?: string, _params?: unknown[]) => ({ data: [] as T[], isLoading: false, error: undefined });
export const usePowerSync = () => ({ getAll: async () => [], get: async () => null, execute: async () => ({}),
  getUploadQueueStats: async () => ({ count: 0 }), registerListener: () => () => undefined, onChange: () => () => undefined });
export const PowerSyncContext = { Provider: ({ children }: { children: unknown }) => children };
