// What the link that opened this page was asking for.
//
// 2026-10-07: inviting a user was a dead end. Supabase's invite and
// "reset password" emails point at the app with a token in the URL fragment.
// supabase-js consumes that fragment on startup and signs the person IN — so
// AuthGate saw a session, decided they were logged in, and dropped them
// straight into the app. They never got a chance to choose a password, so the
// next time they visited they had no way back in. A password reset did the same
// thing, which is why resending it never helped.
//
// The fix needs to know WHY the page was opened, and that information only
// exists in the URL for the moment before supabase-js strips it. So this module
// reads it once, at import time, and must be imported before the Supabase
// client is constructed — main.tsx does that on its first line.
export type AuthIntent = "invite" | "recovery" | null;

function read(): AuthIntent {
  if (typeof window === "undefined") return null;
  // Implicit flow puts it in the fragment; PKCE puts it in the query string.
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const query = new URLSearchParams(window.location.search);
  const type = hash.get("type") ?? query.get("type");
  if (type === "invite" || type === "signup") return "invite";
  if (type === "recovery") return "recovery";
  return null;
}

/** Captured once, at module load, before supabase-js clears the URL. */
export const initialAuthIntent: AuthIntent = read();
