// Live-data harness: stands in for sync/system.ts. Reads hit the seeded sql.js
// DB; writes are refused so nothing pretends to have been saved.
import { open, getAll } from "./db";

const refuse = async () => { throw new Error("[live harness] read-only"); };
export const powerSync = {
  init: () => open(),
  getAll: async <T,>(sql: string, params?: unknown[]) => { await open(); return getAll<T>(sql, params); },
  getOptional: async <T,>(sql: string, params?: unknown[]) => { await open(); return getAll<T>(sql, params)[0] ?? null; },
  execute: refuse,
  writeTransaction: refuse,
};
export const connectPowerSync = async () => undefined;
export const disconnectPowerSync = async () => undefined;
export const clearPowerSync = async () => undefined;
