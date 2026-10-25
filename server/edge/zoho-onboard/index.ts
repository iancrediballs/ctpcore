// CTP Core — Zoho side of onboarding a new make / brand (0079, docs/13). Admin or service role only.
//
// tools/onboard/onboard.py imports a make into CTP first (onboard_import), then calls this to give
// every part of the batch a Zoho Inventory item. Rules (Ian):
//   * never DELETE in Zoho — rollback DEACTIVATES the items this batch created;
//   * never change a Zoho PRICE — an existing item (same SKU) is only LINKED, nothing on it is
//     written; a NEW item gets its first rate from the CTP list price and its purchase rate from the
//     preferred supplier's cost (that is creation, not a change);
//   * Manufacturer / Brand / GL accounts / unit / description come from the batch's make_profile,
//     never from a default — a profile without them is refused.
// Every call is a preview unless { apply: true }. Paced for Zoho's 100 calls a minute.
//   { action: "accounts" }                                  READ-ONLY: the GL accounts active items use
//   { action: "items", batch, apply?, limit? }             create or link the batch's items
//   { action: "deactivate", batch, apply? }                rollback: mark the batch's CREATED items inactive
//   { action: "verify", batch }                            READ-ONLY: CTP vs Zoho, item by item
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { env, zohoInit, zohoInv, taxIdFor } from "../_shared/zoho.ts";

const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
const pause = () => new Promise((r) => setTimeout(r, 700));
const rands = (minor: number | null | undefined) => (minor == null ? undefined : Math.round(Number(minor)) / 100);

async function isAdmin(req: Request, db: SupabaseClient): Promise<boolean> {
  const bearer = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!bearer) return false;
  try {   // deployed WITH verify_jwt: the gateway has checked the signature
    const claims = JSON.parse(atob(bearer.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    if (claims.role === "service_role") return true;
  } catch { /* not a JWT */ }
  const { data } = await db.auth.getUser(bearer);
  if (!data?.user) return false;
  const { data: me } = await db.from("app_user").select("role").eq("id", data.user.id).maybeSingle();
  return me?.role === "admin";
}

// deno-lint-ignore no-explicit-any
async function batchParts(db: SupabaseClient, batch: string): Promise<{ b: any; prof: any; parts: any[] }> {
  const { data: b } = await db.from("import_batch").select("*").eq("code", batch).maybeSingle();
  if (!b) throw new Error(`no batch ${batch}`);
  const { data: prof } = await db.from("make_profile").select("*").eq("code", b.profile_code).maybeSingle();
  if (!prof) throw new Error(`batch ${batch} has no make profile ${b.profile_code}`);
  const { data: rows } = await db.from("import_batch_row").select("row_id").eq("batch_code", batch).eq("entity", "part").in("action", ["created", "updated"]);
  const ids = [...new Set((rows ?? []).map((r) => r.row_id))];
  if (!ids.length) return { b, prof, parts: [] };
  const { data: parts, error } = await db.from("part")
    .select("id, sku, name, description, make, model, universal, part_type, list_price_minor, zoho_item_id, deleted_at").in("id", ids).order("sku");
  if (error) throw new Error(error.message);
  return { b, prof, parts: parts ?? [] };
}

// deno-lint-ignore no-explicit-any
async function findBySku(sku: string): Promise<any | null> {
  const r = await zohoInv("GET", "/items", { search_text: sku, per_page: "50" });
  // deno-lint-ignore no-explicit-any
  return ((r.items ?? []) as any[]).find((i) => String(i.sku ?? "").trim().toUpperCase() === sku.trim().toUpperCase()) ?? null;
}

// deno-lint-ignore no-explicit-any
const describe = (tpl: string, p: any, prof: any) =>
  tpl.replace("{make}", p.make ?? prof.make ?? "").replace("{model}", p.model ?? prof.model ?? "").replace("{sku}", p.sku).replace(/\s+/g, " ").trim();

// deno-lint-ignore no-explicit-any
async function items(db: SupabaseClient, body: any) {
  const { b, prof, parts } = await batchParts(db, String(body.batch ?? ""));
  if (b.status !== "imported") throw new Error(`batch ${b.code} is ${b.status}`);
  const missing = ["zoho_manufacturer", "zoho_sales_account_id", "zoho_purchase_account_id", "zoho_inventory_account_id"].filter((k) => !prof[k]);
  if (missing.length) throw new Error(`make profile ${prof.code} lacks ${missing.join(", ")} — fill it in before creating Zoho items`);
  // Zoho's advanced tax automation refuses a tax id on items ("associate a tax rule"): copy the sales and
  // purchase tax rules from an active item CTP already sells, so new items are taxed exactly like them
  const { data: ref } = await db.from("zoho_item").select("zoho_item_id").eq("status", "active").not("part_id", "is", null).limit(1).maybeSingle();
  const refItem = ref ? (await zohoInv("GET", `/items/${ref.zoho_item_id}`)).item : null;
  const taxRules = refItem?.sales_tax_rule_id ? { sales_tax_rule_id: refItem.sales_tax_rule_id, purchase_tax_rule_id: refItem.purchase_tax_rule_id } : null;
  const { data: cfg } = await db.from("zoho_config").select("tax_id").eq("id", 1).maybeSingle();
  const tax = taxRules ? null : await taxIdFor(1500, cfg?.tax_id ?? null);
  const { data: sup } = await db.from("part_supplier").select("part_id, cost_minor, is_preferred, supplier:supplier_id(zoho_contact_id)")
    .in("part_id", parts.map((p) => p.id)).is("deleted_at", null);
  const cost = new Map<number, number>(), vendor = new Map<number, string>();
  for (const s of (sup ?? []).sort((x, y) => Number(y.is_preferred) - Number(x.is_preferred))) {
    if (!cost.has(s.part_id) && s.cost_minor != null) cost.set(s.part_id, s.cost_minor);
    // the preferred supplier as the item's Zoho vendor, when that supplier is a Zoho contact: Zoho's vendor
    // is copied back into part.supplier by the catalogue read (0074), so without it the text goes blank
    // deno-lint-ignore no-explicit-any
    const zc = (s as any).supplier?.zoho_contact_id;
    if (s.is_preferred && zc && !vendor.has(s.part_id)) vendor.set(s.part_id, String(zc));
  }

  const apply = body.apply === true, limit = Math.min(Math.max(Number(body.limit ?? 25), 1), 40);
  const out = { batch: b.code, apply, created: [] as string[], linked: [] as string[], already: [] as string[], would_create: [] as string[],
                would_link: [] as string[], failed: [] as string[], left: 0 };
  const todo = parts.filter((p) => !p.deleted_at && !p.zoho_item_id);
  out.already = parts.filter((p) => p.zoho_item_id).map((p) => p.sku);
  out.left = Math.max(todo.length - limit, 0);
  for (const p of todo.slice(0, limit)) {
    await pause();
    try {
      const found = await findBySku(p.sku);
      if (found) {
        if (!apply) { out.would_link.push(`${p.sku} → existing ${found.item_id} (${found.status}) — linked only, nothing written in Zoho`); continue; }
        await link(db, b.code, p, found, "zoho_linked");
        out.linked.push(p.sku);
        continue;
      }
      const payload = {
        name: p.name, sku: p.sku, unit: prof.unit || "pcs", item_type: "inventory", product_type: "goods",
        rate: rands(p.list_price_minor) ?? 0, purchase_rate: rands(cost.get(p.id)) ?? 0,
        description: describe(prof.description_template, p, prof), purchase_description: describe(prof.description_template, p, prof),
        manufacturer: prof.zoho_manufacturer, ...(prof.zoho_brand ? { brand: prof.zoho_brand } : {}),
        ...(vendor.get(p.id) ? { vendor_id: vendor.get(p.id) } : {}),
        account_id: prof.zoho_sales_account_id, purchase_account_id: prof.zoho_purchase_account_id,
        inventory_account_id: prof.zoho_inventory_account_id, ...(taxRules ?? (tax ? { tax_id: tax, purchase_tax_id: tax } : {})),
      };
      if (!apply) { out.would_create.push(`${p.sku} "${p.name}" R${payload.rate} (cost R${payload.purchase_rate}) · ${payload.manufacturer}/${payload.brand ?? "-"}`); continue; }
      const made = (await zohoInv("POST", "/items", {}, payload)).item;
      await link(db, b.code, p, made, "zoho_created");
      out.created.push(`${p.sku} → ${made.item_id}`);
    } catch (e) { out.failed.push(`${p.sku}: ${e instanceof Error ? e.message : String(e)}`); }
  }
  if (apply) await log(db, b.code, `Onboard ${b.code}: ${out.created.length} Zoho items created, ${out.linked.length} linked${out.failed.length ? `, ${out.failed.length} failed` : ""}`, !out.failed.length);
  return out;
}

// deno-lint-ignore no-explicit-any
async function link(db: SupabaseClient, batch: string, p: any, z: any, action: "zoho_created" | "zoho_linked") {
  const minor = (v: unknown) => (v == null || v === "" ? null : Math.round(Number(v) * 100));
  const { error: e1 } = await db.from("zoho_item").upsert({
    zoho_item_id: String(z.item_id), part_id: p.id, sku: p.sku, name: z.name, status: z.status ?? "active",
    rate_minor: minor(z.rate), purchase_rate_minor: minor(z.purchase_rate), synced_at: new Date().toISOString(),
  });
  if (e1) throw new Error(`zoho_item: ${e1.message}`);
  const { error: e2 } = await db.from("part").update({ zoho_item_id: String(z.item_id) }).eq("id", p.id);
  if (e2) throw new Error(`part: ${e2.message}`);
  await db.from("import_batch_row").insert({ batch_code: batch, entity: "zoho_item", row_id: p.id, row_key: p.sku, action, zoho_id: String(z.item_id) });
}

// deno-lint-ignore no-explicit-any
async function deactivate(db: SupabaseClient, body: any) {
  const batch = String(body.batch ?? ""), apply = body.apply === true;
  const { data: rows } = await db.from("import_batch_row").select("row_id, row_key, zoho_id, action").eq("batch_code", batch).eq("entity", "zoho_item");
  const done = new Set((rows ?? []).filter((r) => r.action === "zoho_deactivated").map((r) => r.zoho_id));
  const made = (rows ?? []).filter((r) => r.action === "zoho_created" && !done.has(r.zoho_id));
  const linked = (rows ?? []).filter((r) => r.action === "zoho_linked");
  const out = { batch, apply, deactivated: [] as string[], would_deactivate: [] as string[], unlinked_only: [] as string[], failed: [] as string[] };
  for (const r of made) {
    if (!apply) { out.would_deactivate.push(`${r.row_key} (${r.zoho_id})`); continue; }
    await pause();
    try {
      const z = (await zohoInv("GET", `/items/${r.zoho_id}`)).item;
      if (String(z?.sku ?? "").toUpperCase() !== String(r.row_key).toUpperCase()) throw new Error(`Zoho item ${r.zoho_id} now has SKU ${z?.sku} — not touched`);
      if (z.status !== "inactive") await zohoInv("POST", `/items/${r.zoho_id}/inactive`);
      const a = (await zohoInv("GET", `/items/${r.zoho_id}`)).item;
      if (a?.status !== "inactive") throw new Error(`still ${a?.status}`);
      await db.from("zoho_item").update({ status: "inactive", synced_at: new Date().toISOString() }).eq("zoho_item_id", r.zoho_id);
      await db.from("part").update({ zoho_item_id: null }).eq("id", r.row_id).eq("zoho_item_id", r.zoho_id);
      await db.from("import_batch_row").insert({ batch_code: batch, entity: "zoho_item", row_id: r.row_id, row_key: r.row_key, action: "zoho_deactivated", zoho_id: r.zoho_id });
      out.deactivated.push(`${r.row_key} (${r.zoho_id})`);
    } catch (e) { out.failed.push(`${r.row_key}: ${e instanceof Error ? e.message : String(e)}`); }
  }
  // items that already existed in Zoho were only linked: rollback leaves them alone in Zoho
  for (const r of linked) {
    out.unlinked_only.push(r.row_key);
    if (apply) await db.from("part").update({ zoho_item_id: null }).eq("id", r.row_id).eq("zoho_item_id", r.zoho_id);
  }
  if (apply && made.length) await log(db, batch, `Onboard ${batch} rollback: ${out.deactivated.length} Zoho items deactivated${out.failed.length ? `, ${out.failed.length} failed` : ""}`, !out.failed.length);
  return out;
}

// deno-lint-ignore no-explicit-any
async function verify(db: SupabaseClient, body: any) {
  const { prof, parts } = await batchParts(db, String(body.batch ?? ""));
  const checks: string[] = [], problems: string[] = [];
  for (const p of parts) {
    if (p.deleted_at) { checks.push(`${p.sku}: deleted in CTP`); continue; }
    if (!p.zoho_item_id) { problems.push(`${p.sku}: no Zoho item linked`); continue; }
    await pause();
    try {
      const z = (await zohoInv("GET", `/items/${p.zoho_item_id}`)).item;
      const bad: string[] = [];
      if (String(z.sku).toUpperCase() !== p.sku.toUpperCase()) bad.push(`sku ${z.sku}`);
      if (z.status !== "active") bad.push(`status ${z.status}`);
      if (prof.zoho_manufacturer && z.manufacturer !== prof.zoho_manufacturer) bad.push(`manufacturer "${z.manufacturer ?? ""}"`);
      if (prof.zoho_brand && z.brand !== prof.zoho_brand) bad.push(`brand "${z.brand ?? ""}"`);
      if ((z.unit ?? "") !== (prof.unit || "pcs")) bad.push(`unit "${z.unit ?? ""}"`);
      if (!z.image_name) bad.push("no image");
      (bad.length ? problems : checks).push(`${p.sku} (${p.zoho_item_id}): ${bad.length ? bad.join(", ") : `ok · R${z.rate} · ${z.manufacturer}/${z.brand ?? "-"} · ${z.unit} · image ${z.image_name}`}`);
    } catch (e) { problems.push(`${p.sku}: ${e instanceof Error ? e.message : String(e)}`); }
  }
  return { ok: problems.length === 0, profile: prof.code, checked: parts.length, checks, problems };
}

async function accounts() {
  // The Books chart of accounts needs a scope CTP's token does not have (401, code 57). Inventory
  // returns the accounts each item uses, so read them off the active items: an account Michelle
  // made for a new make shows up once one item (even a TEST one) uses it, or she gives the id.
  const seen = new Map<string, { id: string; name: string; used_as: string; items: number }>();
  for (let page = 1; page <= 50; page++) {
    const r = await zohoInv("GET", "/items", { page: String(page), per_page: "200", filter_by: "Status.Active" });
    // deno-lint-ignore no-explicit-any
    for (const i of (r.items ?? []) as any[]) {
      for (const [k, n, as] of [["account_id", "account_name", "sales"], ["purchase_account_id", "purchase_account_name", "purchase (COGS)"],
                                ["inventory_account_id", "inventory_account_name", "inventory"]]) {
        if (!i[k]) continue;
        const key = `${as}:${i[k]}`;
        const e = seen.get(key) ?? { id: String(i[k]), name: String(i[n] ?? ""), used_as: as, items: 0 };
        e.items++; seen.set(key, e);
      }
    }
    if (!r.page_context?.has_more_page) break;
  }
  return [...seen.values()].sort((a, b) => a.used_as.localeCompare(b.used_as) || b.items - a.items);
}

async function log(db: SupabaseClient, batch: string, message: string, ok: boolean) {
  await db.from("zoho_push_log").insert({ doc_type: "item", ctp_ref: `onboard:${batch}`, action: "onboard", ok, message: message.slice(0, 2000) });
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
  if (!(await isAdmin(req, db))) return json({ error: "Admin only" }, 401);
  const body = await req.json().catch(() => ({}));
  try {
    await zohoInit(db);
    if (body.action === "accounts") return json({ ok: true, accounts: await accounts() });
    if (body.action === "items") return json({ ok: true, ...(await items(db, body)) });
    if (body.action === "deactivate") return json({ ok: true, ...(await deactivate(db, body)) });
    if (body.action === "verify") return json(await verify(db, body));
    return json({ ok: false, error: "action: accounts | items | deactivate | verify" }, 400);
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 200);
  }
});
