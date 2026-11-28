#!/usr/bin/env bash
# Build the public website's copy of the app (app/vite.public.config.ts) and
# copy it into the ctp-website repo. Run from anywhere:
#   server/publish_public_app.sh [path/to/ctp-website]   (default ../ctp-website)
# Then commit and push ctp-website; Vercel redeploys the site.
#
# What lands there:
#   static/app/assets/*      the bundle (JS, CSS, sql.js wasm), hashed names
#   app-shell.html           the HTML template; build.mjs writes one copy per
#                            truck at /trucks/<slug>/ with data-make/data-model
#   static/brand/ctp_logo_body_v3.webp, ctp_truck_v3.webp   the app's logo
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
site="${1:-$here/../ctp-website}"
site="$(cd "$site" && pwd)"
test -f "$site/build.mjs" || { echo "not the ctp-website repo: $site" >&2; exit 1; }

cd "$here/app"
npx vite build --config vite.public.config.ts
rm -rf "$site/static/app"
mkdir -p "$site/static/app" "$site/static/brand"
cp -r dist-public/assets "$site/static/app/assets"
cp dist-public/public-site.html "$site/app-shell.html"
cp public/brand/ctp_logo_body_v3.webp public/brand/ctp_truck_v3.webp "$site/static/brand/"
echo "published to $site (static/app, app-shell.html). Commit and push ctp-website."
