# CTP Core — Administrator Runbook

**For whoever keeps the system running.** Assumes some technical confidence.
5 September 2026

---

## The map

| Piece | Identifier |
|---|---|
| Database + auth + storage | Supabase project `ctp-core`, ref `hkzmydowyiajkbakxfkj`, eu-central-1, Postgres 17.6 |
| Device sync | PowerSync — `6a445bd8deeddd0df6093d43.powersync.journeyapps.com` |
| Phone app hosting | Vercel project `ctp-core`, team `ianiboyai` → `ctp-core.vercel.app` |
| Image storage | Supabase bucket `ctp-assets` (public), 421 objects, 116 MB |
| Order emails | Supabase edge function `notify`, sends via Resend |
| Source | `github.com/iancrediballs/ctpcore` |
| Working copy | `C:\Users\Administrator\Desktop\CTP\ctpcore-portable` |

**There is no `.env` file and there never was.** Client-side keys live in
`app/src/sync/config.ts` and are designed to be public — row-level security is
the wall, not key secrecy. Real secrets live only in the Supabase and Vercel
dashboards.

---

## Everyday tasks

### Deploy a change to the phone app
```
cd app
npm run build
npx vercel --prod
```

### Run the desktop app in development
Double-click `start-fleetview.bat`. It handles the toolchain paths, the
`NODE_ENV` problem below, and fetching images on a fresh machine.

### Install the desktop app
Run either installer from `Desktop\CTP\INSTALLERS\`:

| File | Notes |
|---|---|
| `CTP Core_1.0.0_x64-setup.exe` | NSIS. Per-machine, no language prompt. **Use this one.** |
| `CTP Core_1.0.0_x64_en-US.msi` | Same app as an MSI, for Group Policy or scripted rollout |

Both are ~126 MB because the catalogue photos and diagrams are bundled into the
app — that is deliberate, and it is why part images render with no network.

### Rebuild the desktop installer
```
Desktop\CTP\_go.bat
```
`_go.bat` is a one-line wrapper that redirects the whole run into
`D:\ctpbuild\build4.log` and calls `_build.bat`, which does the work: it sets
`windir` (see the trap below), the D: toolchain paths, `CARGO_TARGET_DIR` on D:,
`NODE_ENV=development`, and the MSVC environment, then runs
`npm run tauri build`. Output lands in `D:\ctpbuild\target\release\bundle\`.

A clean first build took **62 minutes**; a rebuild takes about **11 minutes**,
because the ~400 dependencies are cached.

Three things in that script are load-bearing, and each one cost a failed build:

- **The linker is found by `vcvars64.bat`, not by `vswhere`.** `rustc` normally
  locates `link.exe` by asking `vswhere` where Visual Studio lives. On this
  machine `vswhere` answers **NO INSTALLED PRODUCTS** even though the tools are
  present and working on D: — the instance registration did not survive
  installing to a non-standard path with `--nocache`. The first build only
  succeeded because `setup.exe` was still running and the instance was
  registered mid-install; every build after it failed with
  ``error: linker `link.exe` not found``. `_build.bat` therefore calls
  `D:\ctpbuild\BuildTools\VC\Auxiliary\Build\vcvars64.bat` and sets
  `PATH`/`INCLUDE`/`LIB` directly, which is what a build server does anyway.
  **Do not "fix" this by reinstalling the build tools.**
- **Node is put back on `PATH` explicitly, after `vcvars`.** `vcvars` rebuilds
  `PATH`, and this machine's is long enough that the tail — where
  `C:\Program Files\nodejs` sits — does not survive. Symptom:
  `'npm' is not recognized`, seconds into the build, with a perfectly good Node
  installation on disk.
- **Nothing inside `_build.bat` redirects to a log.** Stale shells on this
  machine hold log files open, and every `>>` inside the script failed with
  *the process cannot access the file*. One redirect, on the outside, in
  `_go.bat`.

One harmless message you will see and can ignore: `'Fastboot++\' is not
recognized`. A system `PATH` entry (`C:\Program Files (x86)\ADB & Fastboot++\`)
contains an `&`, which `cmd` reads as a command separator. It is cosmetic, but
it also poisons `ERRORLEVEL` after `vcvars`, which is why the script does not
test it.

Two things that will bite if you edit `tauri.conf.json`:

- **WiX locales.** `en-ZA` is not one of them. The build compiles the entire
  application, then panics at the packaging step. Use `en-US`.
- **Non-ASCII characters in bundle metadata** get mangled on the way into the
  executable's resources — `©` came out as `c`. Keep `copyright`,
  `longDescription` and friends to plain ASCII.

### Restore the catalogue images on a new machine
```
node tools/pull_assets.mjs
```
Downloads all 421 objects from the bucket into `app/public/assets/`. Safe to
re-run — it skips what is already there. `--force` re-fetches everything.
Without this, every part shows a broken image.

### Add a staff member
1. Create the user in Supabase → Authentication.
2. **Insert a matching row in `app_user`** with the right role
   (`sales`, `warehouse`, `manager`, `admin`).

> Step 2 is not optional. Without an `app_user` row the person signs in
> successfully and then sees the customer interface with no explanation. The
> role in that table is what the sync rules gate on.

### Add a customer login
1. Create the user in Supabase → Authentication.
2. Insert an `app_user` row with role `customer`.
3. **Set `auth_user_id` on their row in the `customer` table.** This is what
   ties the login to the account; without it they sync no orders at all.

---

## Traps on this specific machine

**`NODE_ENV=production` is set system-wide.** npm honours it and skips
devDependencies, so `npm install` produces a tree with no `vite` and no
`tsc`, and the build then fails claiming they are missing. The launcher scripts
override it per-process. Doing it by hand:
```
set NODE_ENV=development && npm install --include=dev
```
Clearing that system variable permanently would be the real fix.

**The automation shell inherits a stripped environment — this one cost hours.**

Commands run through the desktop automation bridge do **not** get a full Windows
environment. Missing entirely: `windir`, `PROGRAMDATA`, `ALLUSERSPROFILE`, and
others. The registry is perfectly correct; it is only what child processes
inherit that is incomplete.

This is not cosmetic. The Visual Studio Build Tools installer failed **five
times** because of it, in a way that looks like something else entirely:

```
MS.Internal.FontCache.Util..cctor()
  → System.UriFormatException: Invalid URI: the format could not be determined
    at MS.Internal.FontCache.Util.get_Dpi()
```

WPF builds a `Uri` for the Windows fonts folder from `windir`. With the variable
absent it gets an empty string, `new Uri("")` throws, and the installer dies
during type initialisation — **before drawing anything**. That is why `--quiet`,
`--passive`, the GUI and `winget` all failed identically, and why it reads like
a font-cache or permissions fault when it is neither. Re-downloading the
installer does not help; nor does running as administrator.

The fix is one line before launching anything that touches WPF or expects a
normal environment:
```
set "windir=C:\Windows"
```

Symptoms that should send you straight here: `echo %windir%` printing the
literal `%windir%`, or `if exist "%windir%\Fonts"` reporting the folder missing
on a machine where `C:\Windows\Fonts` obviously exists.

**C: had 11 GB free.** The Rust toolchain and C++ build tools were installed to
`D:\ctpbuild\` for that reason. `start-fleetview.bat` picks them up
automatically; a bare terminal will not, so set `CARGO_HOME`,`RUSTUP_HOME` and
`PATH` if working outside the launcher.

**Git reports ~174 files modified with zero content changes.** That is a
file-permission artefact of how the folder was accessed, not real edits.
Silence it with `git config core.fileMode false`.

---

## Where the security actually lives

Three layers, and it is worth knowing which does what, because they fail
differently:

1. **`server/sync-streams.yaml` — the real boundary for devices.** PowerSync
   replicates using a role that *bypasses* row-level security, so what lands on
   a phone is decided **here and nowhere else**. A missing gate in this file is
   a data leak, not a bug. The file is written in PowerSync edition 2
   deliberately — edition 3 silently ignored gating subqueries of exactly this
   shape (advisory GHSA-q6wc-xx4m-92fj). Do not "upgrade" it without reading
   the comments at the top.
2. **Row-level security — the boundary for the API.** 25 tables, all with
   policies. `price`, `part_cost` and `price_tier` are staff-only.
3. **`SECURITY DEFINER` functions** — each begins by checking `is_staff()` or
   resolving the caller's own customer.

### Verifying a customer device leaks nothing
Sign in as the customer, open the browser console, and run:
```js
await powerSync.getAll("SELECT count(*) n FROM price")         // expect 0
await powerSync.getAll("SELECT count(*) n FROM part_cost")     // expect 0
await powerSync.getAll("SELECT count(*) n FROM stock_policy")  // expect 0
await powerSync.getAll("SELECT count(*) n FROM sales_order")   // expect only theirs
await powerSync.getAll("SELECT count(*) n FROM part")          // expect 161
```
**Do this before any password is given to anyone outside the business.** A
bucket that syncs nothing and a bucket that was never configured look identical
from the config file — only the device can tell you the truth.

---

## Diagnosis

| Symptom | Likely cause | Check |
|---|---|---|
| Phone shows empty screens after login | User has no `app_user` row, or the wrong role | Query `app_user` for their auth id |
| Customer sees no orders | `customer.auth_user_id` not set | Query `customer` for that login |
| Every part image broken | Assets not pulled on this machine | `node tools/pull_assets.mjs` |
| Order emails not arriving | `RESEND_API_KEY` or vault `notify_token` unset | Edge function logs — it **fails silently by design** so a mail problem can never block an order being saved |
| Desktop app exits instantly | Local database problem | It now shows a message box; the local file is `%APPDATA%\net.chinatruckparts.fleetview\fleetview.db` |
| Stock figure looks wrong | Almost always a missing entry, not a bug | Sum `stock_movement` for that part — on-hand is always that sum |

---

## The local desktop database

Lives at `%APPDATA%\net.chinatruckparts.fleetview\fleetview.db`. Built on first
launch by a migration runner keyed on `PRAGMA user_version`, applying
`0001`…`0015` in order and landing on `user_version = 14`. The full ladder was
replayed against a fresh database to prove it: it lands on 14, produces 224
cross-reference rows and 161 fitment rows with no orphans, and re-running it
changes nothing. It is safe both on a fresh install and on upgrade from any
earlier version.

Two things to know:

- `0013_verify.sql` sits beside `0013_pricing_reset.sql` but is **never run by
  the app** — it is a hand-run diagnostic. The shared number is a naming
  choice, not a collision.
- The first schema+seed batch is not wrapped in a transaction. If it were ever
  to fail halfway, the next launch would assume it had succeeded and leave a
  half-built database. Very unlikely, never observed. If a machine ever behaves
  as though tables are missing, **delete the local file and relaunch** — it
  rebuilds from scratch and the cloud is the record anyway.

---

## Do these soon

- [ ] **Test a database restore.** Backups run; a restore has never been proven.
- [ ] Enable leaked-password protection (Supabase → Authentication, one toggle).
- [ ] Remove the orphaned `app_user` row with no matching login.
- [ ] Add indexes on the foreign keys the performance advisor flagged —
      immaterial at 161 parts, will matter at 10,000.
- [ ] Confirm a second person can access every service account.
