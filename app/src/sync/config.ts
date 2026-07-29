// CTP Core — backend connection config (Phase B1).
// These are CLIENT-SAFE values: the Supabase publishable key is designed to ship
// in the browser (RLS is the security wall), and the PowerSync URL is public.
// NO secret keys here. The powersync_role DB password lives only in PowerSync.
export const SUPABASE_URL = "https://hkzmydowyiajkbakxfkj.supabase.co";
export const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_3AoeploPPtxcTU7oFqVfFA_D7l-vwQG";
export const POWERSYNC_URL = "https://6a445bd8deeddd0df6093d43.powersync.journeyapps.com";

// Master switch for the Phase B1 login gate + background sync. Kept OFF so the
// existing Rust-backed app is untouched until the runtime setup (test user,
// app_user row, Data-API grants) is done — then flip to true to test.
export const AUTH_ENABLED = false;

