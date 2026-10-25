import { createClient, type Session } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./config";

// Single Supabase client for auth + Data-API writes (used by the PowerSync
// upload connector). Sessions persist so the desktop app stays logged in.
export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
});

/** The session supabase-js persisted, read straight from storage: no network,
 *  no auth lock. Unlike getSession() it never waits on a token refresh, so it
 *  answers at once offline. Its access token may be expired. */
export function readStoredSession(): Session | null {
  try {
    const key = (supabase.auth as unknown as { storageKey?: string }).storageKey;
    const raw = key ? localStorage.getItem(key) : null;
    if (!raw) return null;
    const s = JSON.parse(raw) as Session;
    return s?.access_token && s?.refresh_token && s?.user?.id ? s : null;
  } catch {
    return null;
  }
}
