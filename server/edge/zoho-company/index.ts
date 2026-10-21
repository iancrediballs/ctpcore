// CTP Core — companies and people, Zoho-first (Phase 1, docs/06; 0057).
//
// Company = Zoho Books customer contact. Person = Zoho contact person.
// CTP Core keeps only the links (zoho_contact_id / zoho_contact_person_id),
// a cache of name/email/phone/VAT/address, and the login map.
//
// Every create in Zoho is two calls from the app: a PREVIEW (read-only — what
// Zoho and CTP Core already have that matches) and a CREATE with confirm:true.
// Existing Zoho contacts are never edited; the only write to an existing contact
// is ADDING a contact person. No logins are created here.
//
//   POST { action: "company_preview", company: {name, email?, vat_no?, phone?, billing?} }
//   POST { action: "company_create",  company: {...}, link_zoho_contact_id?: string, confirm: true }
//   POST { action: "person_preview",  customer_id, person: {first_name, last_name?, email?, phone?} }
//   POST { action: "person_create",   customer_id, person: {...}, link_zoho_contact_person_id?: string, confirm: true }
//
// Staff only (sales / warehouse / manager / admin).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { env, zohoInit, zohoMissing, zoho, norm, type Logger } from "../_shared/zoho.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });

type Billing = { address?: string; street2?: string; city?: string; state?: string; zip?: string; country?: string };
type Company = { name: string; email?: string; vat_no?: string; phone?: string; billing?: Billing };
type Person = { first_name: string; last_name?: string; email?: string; phone?: string };

const digits = (s: unknown) => String(s ?? "").replace(/[^0-9a-z]/gi, "").toLowerCase();
const clean = (s: unknown) => { const v = String(s ?? "").trim(); return v || undefined; };

async function staff(req: Request, db: SupabaseClient): Promise<string | null> {
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return null;
  const { data } = await db.auth.getUser(jwt);
  if (!data?.user) return null;
  const { data: me } = await db.from("app_user").select("role").eq("id", data.user.id).maybeSingle();
  return ["sales", "warehouse", "manager", "admin"].includes(me?.role ?? "") ? data.user.id : null;
}

// deno-lint-ignore no-explicit-any
async function zohoContactsLike(c: Company): Promise<any[]> {
  // read-only searches; the result is re-checked exactly below
  // deno-lint-ignore no-explicit-any
  const seen = new Map<string, any>();
  const qs: Record<string, string>[] = [{ contact_name_contains: c.name }];
  if (c.email) qs.push({ email: c.email });
  if (c.vat_no) qs.push({ search_text: c.vat_no });
  for (const q of qs) {
    const b = await zoho("GET", "/contacts", { ...q, per_page: "50" });
    for (const x of b.contacts ?? []) seen.set(String(x.contact_id), x);
  }
  const name = norm(c.name), email = norm(c.email), vat = digits(c.vat_no);
  return [...seen.values()].map((x) => {
    const why: string[] = [];
    if (norm(x.contact_name) === name || norm(x.company_name) === name) why.push("same name");
    else if (norm(x.contact_name).includes(name) || name.includes(norm(x.contact_name))) why.push("similar name");
    if (email && norm(x.email) === email) why.push("same email");
    if (vat && (digits(x.vat_reg_no) === vat || digits(x.tax_reg_no) === vat)) why.push("same VAT no.");
    return { zoho_contact_id: String(x.contact_id), name: x.contact_name, company_name: x.company_name || null,
             email: x.email || null, type: x.contact_type, status: x.status, why };
  }).filter((x) => x.why.length);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
  const actor = await staff(req, db);
  if (!actor) return json({ error: "Staff only" }, 401);
  const log: Logger = async (r) => { await db.from("zoho_push_log").insert({ ...r, actor }); };
  const body = await req.json().catch(() => ({}));

  await zohoInit(db);
  const missing = zohoMissing();
  if (missing.length) return json({ ok: false, error: `Zoho is not connected: ${missing.join(", ")}` }, 412);

  try {
    // ── company ──────────────────────────────────────────────────────────────
    if (body.action === "company_preview" || body.action === "company_create") {
      const c: Company = { name: clean(body.company?.name) ?? "", email: clean(body.company?.email)?.toLowerCase(),
                           vat_no: clean(body.company?.vat_no), phone: clean(body.company?.phone), billing: body.company?.billing };
      if (!c.name) return json({ ok: false, error: "Company name is required" }, 400);
      const zohoMatches = await zohoContactsLike(c);
      const { data: ctp } = await db.from("customer").select("id, code, name, email, vat_no, zoho_contact_id, deleted_at");
      const ctpMatches = (ctp ?? []).filter((x) => !x.deleted_at && (norm(x.name) === norm(c.name)
        || (c.email && norm(x.email) === norm(c.email)) || (c.vat_no && digits(x.vat_no) === digits(c.vat_no))))
        .map((x) => ({ id: x.id, code: x.code, name: x.name, zoho_contact_id: x.zoho_contact_id }));

      if (body.action === "company_preview") {
        return json({ ok: true, company: c, zoho_matches: zohoMatches, ctp_matches: ctpMatches,
          suggestion: ctpMatches.length ? "already in CTP Core — pick it instead"
                    : zohoMatches.length ? "already in Zoho — link it" : "new — will be created in Zoho as a customer" });
      }

      if (body.confirm !== true) return json({ ok: false, error: "Preview first, then create with confirm" }, 400);
      if (ctpMatches.length) return json({ ok: false, error: `Already in CTP Core as ${ctpMatches[0].code} — pick it instead`, ctp_matches: ctpMatches }, 409);

      // deno-lint-ignore no-explicit-any
      let contact: any;
      let how: string;
      if (body.link_zoho_contact_id) {
        const id = String(body.link_zoho_contact_id);
        if (!zohoMatches.some((m) => m.zoho_contact_id === id)) return json({ ok: false, error: "That Zoho contact was not in the preview" }, 400);
        contact = (await zoho("GET", `/contacts/${id}`)).contact;   // read only — never edited
        how = "linked";
      } else {
        if (zohoMatches.some((m) => m.why.includes("same name") || m.why.includes("same email") || m.why.includes("same VAT no."))) {
          return json({ ok: false, error: "Zoho already has a matching contact — link it instead of creating a duplicate", zoho_matches: zohoMatches }, 409);
        }
        const b = c.billing ?? {};
        contact = (await zoho("POST", "/contacts", {}, {
          contact_name: c.name, company_name: c.name, contact_type: "customer", customer_sub_type: "business",
          ...(c.email ? { email: c.email } : {}), ...(c.phone ? { phone: c.phone } : {}),
          ...(c.vat_no ? { tax_treatment: "vat_registered", vat_reg_no: c.vat_no } : { tax_treatment: "vat_not_registered" }),
          billing_address: { address: b.address ?? "", street2: b.street2 ?? "", city: b.city ?? "", state: b.state ?? "",
                             zip: b.zip ?? "", country: b.country ?? "South Africa" },
          notes: "Created from CTP Core",
        })).contact;
        how = "created";
      }
      // the cache row, through the same no-duplicate function as the sync (0056)
      const { data: sync, error } = await db.rpc("zoho_sync_customers", {
        p_contacts: [{ contact_id: String(contact.contact_id), contact_name: contact.contact_name,
                       company_name: contact.company_name || null, email: contact.email || null }], p_apply: true });
      if (error) throw new Error(`cache: ${error.message}`);
      const { data: row } = await db.from("customer").select("id, code, name").eq("zoho_contact_id", String(contact.contact_id))
        .is("deleted_at", null).maybeSingle();
      if (row) {
        await db.from("customer").update({
          vat_no: contact.vat_reg_no || contact.tax_reg_no || c.vat_no || null,
          phone: contact.phone || c.phone || null,
          billing_address: contact.billing_address ?? null, updated_at: new Date().toISOString(),
        }).eq("id", row.id);
      }
      await log({ doc_type: "contact", ctp_id: row?.id ?? null, ctp_ref: row?.code ?? null, action: how === "created" ? "create" : "link",
                  ok: true, zoho_id: String(contact.contact_id), message: `Company ${contact.contact_name} ${how} in Zoho` });
      return json({ ok: true, how, customer: row, zoho_contact_id: String(contact.contact_id), sync });
    }

    // ── person ───────────────────────────────────────────────────────────────
    if (body.action === "person_preview" || body.action === "person_create") {
      const p: Person = { first_name: clean(body.person?.first_name) ?? "", last_name: clean(body.person?.last_name),
                          email: clean(body.person?.email)?.toLowerCase(), phone: clean(body.person?.phone) };
      if (!p.first_name) return json({ ok: false, error: "First name is required" }, 400);
      const { data: co } = await db.from("customer").select("id, code, name, zoho_contact_id, deleted_at").eq("id", Number(body.customer_id)).maybeSingle();
      if (!co || co.deleted_at) return json({ ok: false, error: "No such company" }, 404);
      if (!co.zoho_contact_id) return json({ ok: false, error: `${co.name} is not linked to Zoho yet — link the company first` }, 409);

      // deno-lint-ignore no-explicit-any
      const zp: any[] = (await zoho("GET", `/contacts/${co.zoho_contact_id}/contactpersons`)).contact_persons ?? [];
      const full = norm(`${p.first_name} ${p.last_name ?? ""}`);
      const matches = zp.map((x) => {
        const why: string[] = [];
        if (p.email && norm(x.email) === p.email) why.push("same email");
        if (norm(`${x.first_name ?? ""} ${x.last_name ?? ""}`) === full) why.push("same name");
        return { zoho_contact_person_id: String(x.contact_person_id), name: `${x.first_name ?? ""} ${x.last_name ?? ""}`.trim(),
                 email: x.email || null, phone: x.phone || x.mobile || null, why };
      }).filter((x) => x.why.length);
      const { data: ctpPeople } = await db.from("customer_person").select("id, first_name, last_name, email, zoho_contact_person_id")
        .eq("customer_id", co.id).is("deleted_at", null);
      const ctpMatches = (ctpPeople ?? []).filter((x) => (p.email && norm(x.email) === p.email)
        || norm(`${x.first_name ?? ""} ${x.last_name ?? ""}`) === full);

      if (body.action === "person_preview") {
        return json({ ok: true, company: { id: co.id, name: co.name }, person: p, zoho_matches: matches, ctp_matches: ctpMatches,
          suggestion: ctpMatches.length ? "already in CTP Core" : matches.length ? "already on the Zoho contact — link it"
                    : "new — will be added as a contact person on the Zoho contact" });
      }
      if (body.confirm !== true) return json({ ok: false, error: "Preview first, then create with confirm" }, 400);
      if (ctpMatches.length) return json({ ok: false, error: "This person is already in CTP Core for this company" }, 409);

      let personId: string;
      let how: string;
      if (body.link_zoho_contact_person_id) {
        personId = String(body.link_zoho_contact_person_id);
        if (!matches.some((m) => m.zoho_contact_person_id === personId)) return json({ ok: false, error: "That Zoho contact person was not in the preview" }, 400);
        how = "linked";
      } else {
        if (matches.length) return json({ ok: false, error: "The Zoho contact already has this person — link them instead", zoho_matches: matches }, 409);
        const b = await zoho("POST", "/contacts/contactpersons", {}, {
          contact_id: co.zoho_contact_id, first_name: p.first_name, ...(p.last_name ? { last_name: p.last_name } : {}),
          ...(p.email ? { email: p.email } : {}), ...(p.phone ? { phone: p.phone } : {}),
        });
        personId = String(b.contact_person?.contact_person_id ?? b.contact_person_id);
        how = "added";
      }
      const { data: row, error } = await db.from("customer_person").insert({
        customer_id: co.id, zoho_contact_person_id: personId, first_name: p.first_name, last_name: p.last_name ?? null,
        email: p.email ?? null, phone: p.phone ?? null, origin: "zoho-company",
      }).select("id").single();
      if (error) throw new Error(`cache: ${error.message}`);
      await log({ doc_type: "contact", ctp_id: co.id, ctp_ref: co.code, action: how === "added" ? "create" : "link", ok: true,
                  zoho_id: personId, message: `Person ${p.first_name} ${p.last_name ?? ""} ${how} on Zoho contact ${co.name}` });
      return json({ ok: true, how, person_id: row.id, zoho_contact_person_id: personId });
    }

    return json({ ok: false, error: "Unknown action" }, 400);
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 502);
  }
});
