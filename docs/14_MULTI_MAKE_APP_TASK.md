# 14 — App follow-ups for more than one make (ready to run after the Anton demo)

**Status:** planned 26 Oct 2026, **not started**. App screens were frozen for the demo.
**Why:** the server and the import pipeline (docs/13, 0079) handle any make. Four places in the app still
assume FAW JH6. They must be fixed before customers see Sinotruk C7H parts.
Line numbers are as of 26 Oct and will drift: find the spots with `grep -n "'SEC' |||\"SEC\" +|FAW JH6|rusauto43" -r app/src`.
**Rule for this task:** FAW must look and behave exactly as it does today. Each step below has a "FAW
unchanged" check.

Paste this to start it:

> Do docs/14_MULTI_MAKE_APP_TASK.md, steps 0–5. Pull main first. FAW must behave exactly as today. Give
> me the sync-rule diff and don't deploy PowerSync yourself. Bump the version, deploy, and report.

---

## 0. Groundwork (small, needed by steps 1–4)

**Client schema.** In `app/src/sync/AppSchema.ts`, add `universal: column.integer` to `part`. The column
already arrives with the part rows: sync-rules `SELECT * FROM part`, added in 0079. `part_fitment` is
already on phones.

**Make settings on phones.** `make_profile` is server-only (RLS: no anon or authenticated access), so the
phone can't read `lookup_url` and the other settings.
- Add a migration (next free number) with a narrow read-only table or view, `make_profile_public`.
  - Columns: id, code, make, model, display_name, lookup_url, pn_pattern, active, updated_at.
  - No accounts, costs or scheme ids.
  - Grant select to authenticated.
- Add it to sync-rules and sync-streams as a global bucket.
- Give Ian the **exact diff**. Ian deploys PowerSync.
- Add the table to AppSchema.

**Fallback.** If the sync change isn't live yet, the app falls back to FAW's current behaviour. A missing
profile counts as FAW JH6.

## 1. Drawings per make

**Now:** the section drawing is found by `drawing_key = 'SEC' || category_id`:
- `app/src/data/backend.web.ts:182` (part detail);
- `app/src/data/backend.web.ts:635` (section list);
- `app/src/mobile/MobileShell.tsx:517` (drawing keys).

These are FAW's drawings. A Sinotruk part in section BMP would open FAW's bumper drawing.

**Change:**
- **Part detail.** Choose the diagram whose `section_code` is the part's section and whose make/model
  equal the part's make/model. If there is none, fall back to `'SEC' || category_id`, which is FAW's
  drawing.
  - Better still, use `part_diagram_callout` (hotspots), whose drawing is exact.
  - Universal parts: use the callout drawing, or none.
- **Section list.** Same rule, using the make chosen on the home page (step 2). With no make chosen,
  the list behaves exactly as today.
- **MobileShell drawings.** Key by the diagram's real `drawing_key` instead of `"SEC" + s.id`.

**FAW unchanged:** every FAW section opens the same drawing as before, with the same hotspots. Before and
after, compare a list of section → image_path.

## 2. Make filter that includes "all makes" parts

**Now:** the Find filters (`MobileShell.tsx` around 1443–1452 and 1585, and `SEARCH_SQL` in
`backend.web.ts`) filter on `part.make` / `part.model` only. The model list doesn't follow the make. The
app never reads `part_fitment`.

**Change:** a part matches make M (and model N) when any of these holds:
1. `part.make = M` (and `part.model = N`); or
2. it has a `part_fitment` row for a `vehicle_model` with that make (and model); or
3. `part.universal = 1`. Show these with a small "All makes" tag.

Also:
- The model list is filtered by the chosen make (from `vehicle_model`).
- Search applies the same filter and shows the make on each result.
- Add an optional make chooser on the home page, remembered per device (localStorage, wrapped in
  try/catch). It feeds step 1.

**FAW unchanged:** with no filter, the results are identical (same count). Make=FAW gives the same list as
today, plus any universal parts. That's correct, but tell Ian.

## 3. Jefrey quote heading

**Now:** `app/src/jefrey/skills.ts:107` writes `"REQUEST FOR QUOTATION — FAW JH6"`. Other FAW
assumptions:
- the sample text says "JH6";
- `brain.ts:100-152` knows only the JH6 vehicle and FAW part-number shapes;
- `skills.ts:462` can pair an L/H with an R/H across makes.

**Change:**
- **Heading.** Build it from the makes of the parts on the quote:
  - one make: `REQUEST FOR QUOTATION — Sinotruk C7H` (the profile's display_name);
  - several makes: `REQUEST FOR QUOTATION — FAW JH6 / Sinotruk C7H`;
  - universal parts alone: no suffix.
- **Part numbers.** Recognise them using each profile's `pn_pattern`.
- **L/R pairing.** Only pair parts of the same make.

**FAW unchanged:** an FAW-only quote prints the same heading. Snapshot-test the text.

## 4. Lookup button

**Now:** `app/src/App.tsx:403-405` always opens a Google search `site:rusauto43.ru <pn>`. That's FAW's
supplier catalogue.

**Change:**
- Take the URL from `make_profile_public.lookup_url` for the part's make, replacing `{pn}` with the
  encoded catalogue_pn or inventory_pn.
- The button title comes from the profile.
- Hide the button when the make has no `lookup_url`. Sinotruk has none until Ian supplies one.

**FAW unchanged:** the FAWJH6 profile's lookup_url is the same rusauto search, so the URL is identical.

## 5. Check, deploy, hand off

1. Run `npx tsc` and the existing local tests.
2. Seed check on a preview, or after the Sinotruk import:
   - one Sinotruk part with a drawing;
   - one universal part.

   Run the four FAW-unchanged checks above, with screenshots.
3. Bump `CACHE` in `app/public/sw.js`, then `npx.cmd vercel deploy --prod --scope ian-33be3d61 --yes`.
4. Update HANDOFF and docs/13 "For after the demo". Mark items 1–4 done; items 5–7 (locator art, "New
   from Zoho" make, `public_parts` make filter) stay open.

**Not in this task:** locator art per make, "New from Zoho" make passthrough, `public_parts` make filter,
renaming the part sheet's "Brand" row. These are items 5–7 in docs/13.
