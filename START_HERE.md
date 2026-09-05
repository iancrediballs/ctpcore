# CTP Core — portable project folder

Packed 2026-09-04. This is the complete China Truck Parts ERP project, moved off the
Windows workstation. Unzip it anywhere on the new machine and work from it directly.

## What this is

A real git repository — not a copy of files. Full history, 31 commits, 197 tracked files.
Run `git log` inside it and you'll see the whole build from the beginning.

It already knows where it's meant to be pushed:

    origin  https://github.com/iancrediballs/ctpcore.git

That repo exists and is empty. When you're ready, from inside this folder:

    git push -u origin main

Your machine's git credentials will handle the login. Nothing else needs configuring.

## Getting started on the new machine

    cd ctpcore-portable
    cd app
    npm install
    npm run dev

`npm install` needs to run because `node_modules` is deliberately not included — it's
hundreds of megabytes of downloadable dependencies and would have made this folder
unusable to move.

## What is deliberately NOT in here

**`app/public/assets/` — 298 MB of images.** Every one of these already lives in the
Supabase `ctp-assets` bucket, which is where the running app loads them from anyway.
The desktop app reads them locally; if you need them on the new machine, pull them from
the bucket rather than copying them across.

**`node_modules/` and build output.** Reinstall with `npm install` as above.

**Secrets.** There is no `.env` file in this project and never was. The Supabase keys and
the Resend API key live in the Supabase and Vercel dashboards, not in the code. Nothing
here needs a secret to open, read, or edit — only deploying does.

**The Tauri desktop app's database.** That sits in `%APPDATA%\net.chinatruckparts.fleetview\`
on the old workstation. See the note below before you worry about it.

## The live system (all of this is already in the cloud, untouched by the move)

| Piece | Where |
|---|---|
| Mobile PWA | https://ctp-core.vercel.app |
| Database | Supabase project `ctp-core`, ref `hkzmydowyiajkbakxfkj`, eu-central-1 |
| Assets | Supabase Storage bucket `ctp-assets` |
| Vercel | project `ctp-core`, team `ianiboyai` |
| Deploy | `npx vercel --prod` from inside `app/` |

## About the old machine's data — you can stop worrying about it

Checked 2026-09-04, live Postgres against the last SQLite snapshot from the workstation:

| | Postgres (live) | Old workstation SQLite |
|---|---|---|
| sales orders | **14** | 5 |
| customers | **5** | 4 |
| prices | **117** | 115 |
| parts | 161 | 161 |
| part images | 306 | 308 |

The cloud database has been the real system of record for weeks. The desktop app's local
database is a stale sidecar, not something you need to rescue or reconcile. The one
exception is photos: if you added or deleted part photos in the Tauri desktop app and
never ran a catch-up, those specific changes exist only on the old machine. Everything
else is safely in Postgres.

## Migration notes

The old project folder had 23 files sitting untracked that had never been committed —
lockfiles, the app README, logo v2 sources, `Batch_Layers_To_PNG.jsx`, the catalogue
import sheets, and the entire `Quotes/` set (Hermans 21232/21287/21297, the Jun–Jul
order book, the account statement, the confirmation photos). Those are now committed, in
two clearly labelled commits at the tip of history. Nothing was lost in the move and
nothing was silently changed.

Also left behind on the old machine, safe to delete whenever:
`_to_delete\cloud_migration_2026-09-04\` and `ctpcore-full.bundle` in the project root.
