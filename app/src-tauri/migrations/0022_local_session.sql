-- ============================================================================
--  CTP Core — CACHED SIGN-IN FOR OFFLINE WORKING (migration 0022)
--
--  WHY THIS TABLE EXISTS
--  The counter must keep trading with no connectivity. That is a headline
--  feature, and it means the app has to answer "is this person allowed to use
--  this machine right now?" without asking a server. It can only do that from
--  something it already holds.
--
--  ⚠ LOCAL-ONLY. LIKE device_identity, THIS MUST NEVER JOIN THE SYNC SET —
--    not sync-rules.yaml, not sync-streams.yaml, not AppSchema.ts. Syncing
--    cached credentials would copy every machine's stored sign-in material to
--    every other machine. There is no version of that which is acceptable.
--
--  ONE ROW PER PERSON, NOT PER MACHINE
--  Each person gets their own login (Ian's decision, 8 Sep). A counter machine
--  is shared, so several people will sign in on it across a shift, and each
--  needs to be able to sign in offline. Hence a table rather than a singleton:
--  the machine caches whoever has signed in on it, and a handover at shift
--  change works without connectivity.
--
--  WHAT IS STORED, AND WHAT IT IS FOR
--    verifier / verifier_salt / verifier_iters
--        A PBKDF2-SHA256 hash of the password, computed in the app with a
--        random per-user salt. NOT the password, and not reversible into one.
--        It exists so an offline sign-in can check a typed password locally.
--        Recomputed on every successful online sign-in, so a password changed
--        centrally takes effect on this machine at the next online sign-in.
--    refresh_token
--        Re-establishes a real Supabase session on reconnect without retyping.
--    role / display_name
--        So the UI can gate what it shows while offline. Refreshed every
--        reconnect; between reconnects the machine honours what it last saw.
--    last_verified_at
--        The clock the entire offline window is measured from. Set on every
--        successful contact with the server, and on nothing else.
--
--  WHAT THIS PROTECTS AGAINST, AND WHAT IT DOES NOT — stated plainly, because
--  the temptation is to imply more than it delivers.
--
--    IT PROTECTS AGAINST: someone using the app without knowing a valid
--    password on an unattended machine; a departed employee working
--    indefinitely (their access ends at the next reconnect, and at the window
--    boundary regardless); and the password itself leaking from disk, since
--    only a verifier is stored.
--
--    IT DOES NOT PROTECT AGAINST anyone with physical access to this machine.
--    fleetview.db is NOT ENCRYPTED AT REST. Landed cost, margins, every
--    customer record and the full price list can be read straight off disk
--    with any SQLite browser, without the app and without any password. This
--    table does not change that either way — it is one more row in a database
--    that is already readable. A login screen is not a substitute for
--    encryption, and encryption at rest is tracked separately, tied to the
--    first hire alongside the desktop role gate.
--
--    IT ALSO DOES NOT PROTECT AGAINST someone copying this whole app-data
--    directory to another machine. The cached sign-in travels with it, and
--    stays usable for the remainder of the window.
--
--  FIRST LAUNCH WITH NO NETWORK: a machine that has never been online has no
--  row here and therefore cannot sign in at all. That is correct — there is
--  nothing to check a password against — but it must be SAID rather than
--  reported as a generic auth failure. See offlineSession.ts.
-- ============================================================================

CREATE TABLE IF NOT EXISTS local_session (
  user_id          TEXT PRIMARY KEY,        -- auth.users.id / app_user.id (UUID)
  email            TEXT NOT NULL,
  display_name     TEXT,
  role             TEXT,                    -- last role seen from the server
  verifier         TEXT NOT NULL,           -- PBKDF2-SHA256, base64
  verifier_salt    TEXT NOT NULL,           -- base64
  verifier_iters   INTEGER NOT NULL,
  refresh_token    TEXT,
  last_verified_at TEXT NOT NULL,           -- last successful SERVER contact
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Indexed on lower(email), not email. Addresses are case-insensitive in
-- practice, and get_local_session looks them up with lower() — so a
-- case-sensitive index would happily store ian@x.co AND IAN@X.CO, after which
-- the lookup matches two rows and returns whichever it finds first. The symptom
-- would be an intermittent "wrong password" for a person whose password is
-- perfectly correct, which is close to undiagnosable from a support call.
CREATE UNIQUE INDEX IF NOT EXISTS local_session_email_idx ON local_session(lower(email));
