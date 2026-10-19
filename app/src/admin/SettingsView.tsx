// CTP Core — Settings.
//
// Everything an owner or manager needs to change about how the business runs,
// without asking a developer: the letterhead that prints on every invoice, who
// gets order email, who can sign in and what they can see, the warehouses, and
// the discount tiers.
//
// Two rules shape this file:
//
//   1. Every write goes through a SECURITY DEFINER function in Postgres, never
//      a direct table write. The permission check lives server-side, in one
//      place, and a client that decides not to check cannot skip it.
//   2. Staff management goes through an Edge Function, because creating a login
//      needs the service-role key and that key must never reach a browser.
//
// Read access is plain PostgREST — RLS already restricts these tables to staff.

import { useCallback, useEffect, useState } from "react";
import { supabase } from "../sync/supabase";
import type { Role } from "../auth/AuthProvider";

type Section = "company" | "email" | "staff" | "places" | "tiers" | "zoho";

type Company = {
  name: string; address: string | null; phone: string | null; email: string | null;
  tax_id: string | null; reg_no: string | null; bank_details: string | null;
  terms: string | null; currency: string; default_tax_bps: number;
  invoice_prefix: string; quote_prefix: string; app_url: string | null;
};

type NotifySetting = {
  enabled: boolean; recipients: string[]; from_name: string; reply_to: string | null;
  on_request: boolean; on_quote_accepted: boolean; on_quote_declined: boolean;
};

type StaffUser = {
  id: string; email: string | null; role: string | null; display_name: string | null;
  last_sign_in_at: string | null; confirmed: boolean;
};

type Location = { id: number; code: string; name: string; deleted_at: string | null };
type Tier = { id: number; code: string; name: string; discount_bps: number; min_margin_bps: number | null };

const ROLE_HELP: Record<string, string> = {
  customer:  "Sees only their own quotes and orders. No prices, no stock, no bins.",
  sales:     "Full catalogue, stock and the order desk. Can quote and price.",
  warehouse: "Full catalogue and stock. Receives, issues and counts.",
  manager:   "Everything sales and warehouse can do, plus settings and accounting.",
  admin:     "Everything, including adding and removing staff.",
};
const ROLES = ["customer", "sales", "warehouse", "manager", "admin"] as const;

// Basis points are how the database stores rates (1500 = 15.00%), because
// integers cannot drift the way a stored 0.15 can. People type percentages.
const pctFromBps = (b: number | null | undefined) =>
  b == null ? "" : (b / 100).toFixed(2).replace(/\.00$/, "");
const bpsFromPct = (s: string) => {
  const n = Number(String(s).replace(",", ".").trim());
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
};

export default function SettingsView({ role, onClose }: { role: Role; onClose: () => void }) {
  const [section, setSection] = useState<Section>("company");
  const [toast, setToast] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const canManage = role === "manager" || role === "admin";
  const isAdmin = role === "admin";

  const flash = (m: string) => { setErr(null); setToast(m); setTimeout(() => setToast(null), 3500); };
  const fail = (e: unknown) => {
    setToast(null);
    setErr(e instanceof Error ? e.message : String(e));
  };

  if (!canManage) {
    return (
      <div className="st-wrap">
        <Header onClose={onClose} />
        <div className="mb-empty">
          <h3>Settings are for managers</h3>
          <p>Your login can use the app but not change how it is set up.
             Ask whoever runs the system if something here needs changing.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="st-wrap">
      <Header onClose={onClose} />

      <div className="st-tabs">
        {([
          ["company", "Company"],
          ["email", "Order emails"],
          ...(isAdmin ? [["staff", "Staff & access"]] as [Section, string][] : []),
          ["places", "Warehouses"],
          ["tiers", "Pricing tiers"],
          ["zoho", "Zoho"],
        ] as [Section, string][]).map(([k, label]) => (
          <button key={k} className={"st-tab" + (section === k ? " on" : "")}
            onClick={() => { setSection(k); setErr(null); }}>{label}</button>
        ))}
      </div>

      {err && <div className="st-err">✕ {err}</div>}
      {toast && <div className="st-ok">✓ {toast}</div>}

      <div className="st-body">
        {section === "company" && <CompanyPanel flash={flash} fail={fail} />}
        {section === "email"   && <EmailPanel   flash={flash} fail={fail} />}
        {section === "staff"   && <StaffPanel   flash={flash} fail={fail} />}
        {section === "places"  && <PlacesPanel  flash={flash} fail={fail} />}
        {section === "tiers"   && <TiersPanel   flash={flash} fail={fail} />}
        {section === "zoho"    && <ZohoPanel    flash={flash} fail={fail} />}
      </div>
    </div>
  );
}

function Header({ onClose }: { onClose: () => void }) {
  return (
    <div className="st-head">
      <button className="st-back" onClick={onClose} aria-label="Close settings">‹</button>
      <span className="st-title">Settings</span>
    </div>
  );
}

type PanelProps = { flash: (m: string) => void; fail: (e: unknown) => void };

/* ── Company & invoicing ─────────────────────────────────────────────────── */

function CompanyPanel({ flash, fail }: PanelProps) {
  const [c, setC] = useState<Company | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    supabase.from("company")
      .select("name,address,phone,email,tax_id,reg_no,bank_details,terms,currency,default_tax_bps,invoice_prefix,quote_prefix,app_url")
      .eq("id", 1).maybeSingle()
      .then(({ data, error }) => error ? fail(error) : setC(data as Company));
  }, []);

  if (!c) return <div className="st-loading">Loading…</div>;

  const set = (k: keyof Company, v: string | number) => setC({ ...c, [k]: v } as Company);

  const save = async () => {
    setBusy(true);
    const { error } = await supabase.rpc("set_company_profile", { payload: c });
    setBusy(false);
    error ? fail(error) : flash("Company details saved. New quotes and invoices use them immediately.");
  };

  return (
    <>
      <p className="st-lead">
        This is the letterhead. It prints at the top of every quote and every tax
        invoice you send a customer.
      </p>

      <Field label="Registered name" value={c.name} onChange={(v) => set("name", v)} />
      <Field label="Trading address" value={c.address ?? ""} onChange={(v) => set("address", v)} multiline />
      <Field label="Phone" value={c.phone ?? ""} onChange={(v) => set("phone", v)} />
      <Field label="Email" value={c.email ?? ""} onChange={(v) => set("email", v)} />

      <Field label="VAT number" value={c.tax_id ?? ""} onChange={(v) => set("tax_id", v)}
        hint="Leave blank rather than guess. A wrong VAT number on a tax invoice breaks your customer's own VAT claim." />
      <Field label="Company registration number" value={c.reg_no ?? ""} onChange={(v) => set("reg_no", v)} />

      <Field label="Default VAT rate" value={pctFromBps(c.default_tax_bps)}
        onChange={(v) => { const b = bpsFromPct(v); if (!Number.isNaN(b)) set("default_tax_bps", b); }}
        suffix="%" hint="Applied to new orders. South African VAT is 15%." />

      {/* Each prefix says exactly what it drives. A setting that reads as if it
          controls something it doesn't is worse than no setting: it gets
          changed, nothing happens, and the whole screen stops being trusted. */}
      <Field label="Tax invoice number prefix" value={c.invoice_prefix} onChange={(v) => set("invoice_prefix", v)}
        hint={`Goes in front of every invoice number the app issues: prefix + date + count for the day, e.g. ${c.invoice_prefix}${todayYYMMDD()}01. Leave blank for the bare number your existing invoices use. Numbers already issued never change.`} />
      <Field label="Quote number prefix" value={c.quote_prefix} onChange={(v) => set("quote_prefix", v)}
        hint="Goes in front of quotes staff raise themselves — on the desktop now, and on the phone once walk-in quotes arrive. Requests that customers send from their phone are always numbered RQ-, because a request is not a quote until it has been priced." />

      <Field label="Banking details" value={c.bank_details ?? ""} onChange={(v) => set("bank_details", v)} multiline
        hint="Printed in the invoice footer so customers can pay without asking." />
      <Field label="Payment terms" value={c.terms ?? ""} onChange={(v) => set("terms", v)} multiline />

      <Field label="Phone app address" value={c.app_url ?? ""} onChange={(v) => set("app_url", v)}
        hint="Where the desktop's 'Open shared settings' link sends people. Change it here if the app moves to a custom domain — no new installer needed. Blank falls back to https://ctpcore.vercel.app." />

      <button className="st-save" disabled={busy} onClick={save}>
        {busy ? "Saving…" : "Save company details"}
      </button>
    </>
  );
}

/* ── Order emails ────────────────────────────────────────────────────────── */

function EmailPanel({ flash, fail }: PanelProps) {
  const [s, setS] = useState<NotifySetting | null>(null);
  const [recipients, setRecipients] = useState("");
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    supabase.from("notify_setting")
      .select("enabled,recipients,from_name,reply_to,on_request,on_quote_accepted,on_quote_declined")
      .eq("id", 1).maybeSingle()
      .then(({ data, error }) => {
        if (error) return fail(error);
        const row = data as NotifySetting;
        setS(row);
        setRecipients((row.recipients ?? []).join(", "));
      });
  }, []);

  if (!s) return <div className="st-loading">Loading…</div>;

  const save = async () => {
    setBusy(true);
    const payload = {
      ...s,
      recipients: recipients.split(",").map((x) => x.trim()).filter(Boolean),
    };
    const { error } = await supabase.rpc("set_notify_setting", { payload });
    setBusy(false);
    error ? fail(error) : flash("Notification settings saved.");
  };

  const test = async () => {
    setTesting(true);
    const { data, error } = await supabase.rpc("send_test_notification");
    setTesting(false);
    error ? fail(error) : flash(String(data));
  };

  return (
    <>
      <p className="st-lead">
        Who hears about it when a customer sends a request or answers a quote.
      </p>

      <Toggle label="Send order emails" checked={s.enabled}
        onChange={(v) => setS({ ...s, enabled: v })}
        hint="Turn everything off without losing your settings." />

      <Field label="Send to" value={recipients} onChange={setRecipients}
        hint="Separate several addresses with commas." />
      <Field label="Reply-to address" value={s.reply_to ?? ""}
        onChange={(v) => setS({ ...s, reply_to: v })}
        hint="Where a reply goes if someone answers one of these emails." />
      <Field label="Sender name" value={s.from_name}
        onChange={(v) => setS({ ...s, from_name: v })} />

      <div className="st-sub">Send an email when…</div>
      <Toggle label="A customer sends a parts request" checked={s.on_request}
        onChange={(v) => setS({ ...s, on_request: v })} />
      <Toggle label="A customer accepts a quote" checked={s.on_quote_accepted}
        onChange={(v) => setS({ ...s, on_quote_accepted: v })} />
      <Toggle label="A customer declines a quote" checked={s.on_quote_declined}
        onChange={(v) => setS({ ...s, on_quote_declined: v })} />

      <button className="st-save" disabled={busy} onClick={save}>
        {busy ? "Saving…" : "Save email settings"}
      </button>
      <button className="st-second" disabled={testing} onClick={test}>
        {testing ? "Sending…" : "Send a test email"}
      </button>
      <p className="st-note">
        The test proves the whole chain works — the app, the mail service, and the
        address above. If it does not arrive within a minute or two, something in
        that chain needs attention.
      </p>
    </>
  );
}

/* ── Staff & access ──────────────────────────────────────────────────────── */

function StaffPanel({ flash, fail }: PanelProps) {
  const [users, setUsers] = useState<StaffUser[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [newRole, setNewRole] = useState<string>("warehouse");

  const call = useCallback(async (body: Record<string, unknown>) => {
    const { data, error } = await supabase.functions.invoke("admin-users", { body });
    if (error) {
      // The function's own message is far more useful than "Edge Function
      // returned a non-2xx status code", so dig it out of the response.
      let msg = error.message;
      try {
        const ctx = (error as { context?: Response }).context;
        if (ctx) { const j = await ctx.json(); if (j?.error) msg = j.error; }
      } catch { /* keep the generic message */ }
      throw new Error(msg);
    }
    if ((data as { error?: string })?.error) throw new Error((data as { error: string }).error);
    return data;
  }, []);

  const load = useCallback(async () => {
    try {
      const d = await call({ action: "list" }) as { users: StaffUser[] };
      setUsers(d.users);
    } catch (e) { fail(e); setUsers([]); }
  }, [call]);

  useEffect(() => { load(); }, [load]);

  const invite = async () => {
    setBusy("invite");
    try {
      await call({ action: "invite", email, role: newRole, display_name: name });
      flash(`Invitation sent to ${email}. They set their own password from the email.`);
      setEmail(""); setName("");
      await load();
    } catch (e) { fail(e); } finally { setBusy(null); }
  };

  const setRole = async (u: StaffUser, r: string) => {
    setBusy(u.id);
    try {
      await call({ action: "set_role", id: u.id, role: r });
      flash(`${u.email} is now ${r}.`);
      await load();
    } catch (e) { fail(e); } finally { setBusy(null); }
  };

  const remove = async (u: StaffUser) => {
    setBusy(u.id);
    try {
      await call({ action: "remove", id: u.id });
      flash(`Removed ${u.email}.`);
      await load();
    } catch (e) { fail(e); } finally { setBusy(null); }
  };

  return (
    <>
      <p className="st-lead">
        Who can sign in, and what they see once they do. Roles are enforced by the
        database itself, not just by hiding buttons.
      </p>

      <div className="st-card">
        <div className="st-sub">Invite someone</div>
        <Field label="Email address" value={email} onChange={setEmail} />
        <Field label="Name" value={name} onChange={setName} />
        <div className="st-lbl">Role</div>
        <select className="st-in" value={newRole} onChange={(e) => setNewRole(e.target.value)}>
          {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
        <p className="st-note">{ROLE_HELP[newRole]}</p>
        <button className="st-save" disabled={busy === "invite" || !email.includes("@")}
          onClick={invite}>
          {busy === "invite" ? "Sending…" : "Send invitation"}
        </button>
        <p className="st-note">
          They receive an email and choose their own password. No one — including
          you — ever sees or sets it.
        </p>
      </div>

      <div className="st-sub">Everyone with access</div>
      {users === null && <div className="st-loading">Loading…</div>}
      {users?.length === 0 && <div className="st-note">Nobody listed.</div>}
      {users?.map((u) => (
        <div className="st-user" key={u.id}>
          <div className="st-uinfo">
            <div className="st-uname">{u.display_name || u.email}</div>
            <div className="st-umail">{u.email}</div>
            <div className="st-umeta">
              {u.confirmed ? "" : "invitation not accepted yet · "}
              {u.last_sign_in_at
                ? `last signed in ${new Date(u.last_sign_in_at).toLocaleDateString()}`
                : "never signed in"}
            </div>
          </div>
          <div className="st-uact">
            <select className="st-in st-role" value={u.role ?? ""} disabled={busy === u.id}
              onChange={(e) => setRole(u, e.target.value)}>
              {!u.role && <option value="">no role</option>}
              {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            <button className="st-remove" disabled={busy === u.id} onClick={() => remove(u)}>
              Remove
            </button>
          </div>
        </div>
      ))}
    </>
  );
}

/* ── Warehouses ──────────────────────────────────────────────────────────── */

function PlacesPanel({ flash, fail }: PanelProps) {
  const [rows, setRows] = useState<Location[] | null>(null);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    supabase.from("location").select("id,code,name,deleted_at").order("code")
      .then(({ data, error }) => error ? fail(error) : setRows((data ?? []) as Location[]));
  }, []);
  useEffect(load, [load]);

  const add = async () => {
    setBusy(true);
    const { error } = await supabase.rpc("upsert_location",
      { p_id: null, p_code: code, p_name: name });
    setBusy(false);
    if (error) return fail(error);
    flash(`Added ${code.toUpperCase()}.`);
    setCode(""); setName(""); load();
  };

  const retire = async (l: Location) => {
    const { error } = await supabase.rpc("retire_location", { p_id: l.id });
    if (error) return fail(error);
    flash(`${l.code} retired.`);
    load();
  };

  return (
    <>
      <p className="st-lead">
        Where stock physically lives. Every receipt, issue and count is recorded
        against one of these.
      </p>

      {rows?.filter((r) => !r.deleted_at).map((l) => (
        <div className="st-user" key={l.id}>
          <div className="st-uinfo">
            <div className="st-uname">{l.code}</div>
            <div className="st-umail">{l.name}</div>
          </div>
          <div className="st-uact">
            <button className="st-remove" onClick={() => retire(l)}>Retire</button>
          </div>
        </div>
      ))}

      <div className="st-card">
        <div className="st-sub">Add a warehouse</div>
        <div className="st-row2">
          <Field label="Short code" value={code} onChange={setCode} />
          <Field label="Name" value={name} onChange={setName} />
        </div>
        <button className="st-save" disabled={busy || !code.trim()} onClick={add}>
          {busy ? "Adding…" : "Add warehouse"}
        </button>
        <p className="st-note">
          A warehouse holding stock cannot be retired — move the stock out first.
          Retiring never deletes history; past movements keep pointing at it.
        </p>
      </div>
    </>
  );
}

/* ── Pricing tiers ───────────────────────────────────────────────────────── */

function TiersPanel({ flash, fail }: PanelProps) {
  const [rows, setRows] = useState<Tier[] | null>(null);
  const [edits, setEdits] = useState<Record<number, { d: string; m: string }>>({});

  const load = useCallback(() => {
    supabase.from("price_tier").select("id,code,name,discount_bps,min_margin_bps").order("code")
      .then(({ data, error }) => {
        if (error) return fail(error);
        const list = (data ?? []) as Tier[];
        setRows(list);
        setEdits(Object.fromEntries(list.map((t) => [t.id, {
          d: pctFromBps(t.discount_bps), m: pctFromBps(t.min_margin_bps),
        }])));
      });
  }, []);
  useEffect(load, [load]);

  const save = async (t: Tier) => {
    const e = edits[t.id];
    const d = bpsFromPct(e.d);
    const m = e.m.trim() === "" ? null : bpsFromPct(e.m);
    if (Number.isNaN(d) || (m !== null && Number.isNaN(m))) {
      return fail(new Error("Those need to be numbers, like 12.5"));
    }
    const { error } = await supabase.rpc("upsert_price_tier", {
      p_id: t.id, p_code: t.code, p_name: t.name,
      p_discount_bps: d, p_min_margin_bps: m,
    });
    if (error) return fail(error);
    flash(`${t.name} updated.`);
    load();
  };

  return (
    <>
      <p className="st-lead">
        What each kind of customer pays off the list price, and how far a
        salesperson may go before the margin floor stops them.
      </p>

      {rows === null && <div className="st-loading">Loading…</div>}
      {rows?.map((t) => (
        <div className="st-card" key={t.id}>
          <div className="st-sub">{t.name} <span className="st-code">{t.code}</span></div>
          <div className="st-row2">
            <Field label="Discount off list" value={edits[t.id]?.d ?? ""} suffix="%"
              onChange={(v) => setEdits({ ...edits, [t.id]: { ...edits[t.id], d: v } })} />
            <Field label="Minimum margin" value={edits[t.id]?.m ?? ""} suffix="%"
              onChange={(v) => setEdits({ ...edits, [t.id]: { ...edits[t.id], m: v } })} />
          </div>
          <button className="st-save" onClick={() => save(t)}>Save {t.name}</button>
        </div>
      ))}
      <p className="st-note">
        Changing a tier does not rewrite quotes already sent. Every order line
        keeps the price it was quoted at — that is deliberate, and it is why a
        price change today cannot silently alter what you promised last week.
      </p>
    </>
  );
}

/* ── Zoho ────────────────────────────────────────────────────────────────── */

// The Zoho link is a PULL: the zoho-sync Edge Function reads Zoho items (the
// OAuth refresh token lives in function secrets, never here) and mirrors them
// into zoho_item. "Check" changes nothing in CTP Core and lists what would
// change; "Pull & apply" writes names, list prices and landed costs. Zoho stock
// is shown beside CTP Core's own ledger, never merged into it.

type ZohoRow = {
  zoho_item_id: string; sku: string; name: string | null; status: string | null;
  rate_minor: number | null; stock_on_hand: number | null; part_id: number | null;
  synced_at: string;
};
type ZohoRun = { started_at: string; finished_at: string | null; ok: boolean | null;
  items_seen: number | null; linked: number | null; error: string | null };
type ZohoResult = {
  ok: boolean; applied?: boolean; items_seen?: number; linked?: number; zoho_stock_units?: number;
  unmatched?: { sku: string | null; name: string }[];
  changes?: { sku: string; field: string; from: unknown; to: unknown }[];
  error?: string;
};

const zar = (m: number | null | undefined) =>
  m == null ? "—" : "R " + (m / 100).toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function ZohoPanel({ flash, fail }: PanelProps) {
  const [rows, setRows] = useState<ZohoRow[] | null>(null);
  const [last, setLast] = useState<ZohoRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ZohoResult | null>(null);
  const [filter, setFilter] = useState("");

  const load = useCallback(() => {
    supabase.from("zoho_item")
      .select("zoho_item_id,sku,name,status,rate_minor,stock_on_hand,part_id,synced_at")
      .order("sku").limit(2000)
      .then(({ data, error }) => { if (error) return fail(error); setRows((data ?? []) as ZohoRow[]); });
    supabase.from("zoho_sync_run").select("started_at,finished_at,ok,items_seen,linked,error")
      .order("started_at", { ascending: false }).limit(1)
      .then(({ data }) => setLast(((data ?? [])[0] as ZohoRun) ?? null));
  }, []);
  useEffect(load, [load]);

  const sync = async (apply: boolean) => {
    if (apply && !confirm("Write Zoho's item names, selling prices and landed costs into CTP Core?\n\nPast quotes and invoices keep their prices.")) return;
    setBusy(true); setResult(null);
    const { data, error } = await supabase.functions.invoke("zoho-sync", { body: { apply } });
    setBusy(false);
    // A non-2xx reply arrives as `error`; its body still carries our message.
    let res = data as ZohoResult | null;
    if (error) {
      try { res = await (error as { context?: Response }).context?.json(); } catch { /* fall through */ }
      if (!res) return fail(error);
    }
    setResult(res);
    if (res?.ok) flash(apply ? `Zoho applied: ${res.changes?.length ?? 0} changes.` : `Zoho checked: ${res.items_seen} items.`);
    load();
  };

  const f = filter.trim().toLowerCase();
  const shown = (rows ?? []).filter((r) => !f || r.sku.toLowerCase().includes(f) || (r.name ?? "").toLowerCase().includes(f));

  return (
    <>
      <p className="st-lead">
        CTP Core reads items and stock from Zoho, and sends its own invoices
        (to customers) and supplier bills to Zoho. The item code is the Zoho SKU
        (the Multicat code).
      </p>

      <ZohoPushCard flash={flash} fail={fail} />

      <div className="st-card">
        <div className="st-sub">Last sync</div>
        {last
          ? <p className="st-note">
              {new Date(last.started_at).toLocaleString("en-ZA")} · {last.ok ? "OK" : last.ok === false ? "FAILED" : "running"}
              {last.items_seen != null && ` · ${last.items_seen} Zoho items, ${last.linked} linked`}
              {last.error && <><br />{last.error}</>}
            </p>
          : <p className="st-note">Never synced from the app. The 19 Oct 2026 catalogue load linked the 155 items.</p>}
        <div className="st-row2">
          <button className="st-save" disabled={busy} onClick={() => sync(false)}>{busy ? "Working…" : "Check Zoho"}</button>
          <button className="st-save" disabled={busy} onClick={() => sync(true)}>Pull &amp; apply</button>
        </div>
      </div>

      {result && (
        <div className="st-card">
          <div className="st-sub">{result.ok ? (result.applied ? "Applied" : "Would change") : "Error"}</div>
          {!result.ok && <p className="st-note">{result.error}</p>}
          {result.ok && <p className="st-note">
            {result.items_seen} Zoho items · {result.linked} linked · {result.zoho_stock_units ?? 0} units on hand in Zoho
          </p>}
          {(result.changes ?? []).slice(0, 200).map((c, i) => (
            <p className="st-note" key={i}><span className="st-code">{c.sku}</span> {c.field}: {String(c.from ?? "—")} → {String(c.to)}</p>
          ))}
          {(result.unmatched ?? []).length > 0 && <>
            <div className="st-sub">In Zoho, not in CTP Core</div>
            {result.unmatched!.map((u, i) => (
              <p className="st-note" key={i}><span className="st-code">{u.sku ?? "(no SKU)"}</span> {u.name}</p>
            ))}
          </>}
        </div>
      )}

      <div className="st-card">
        <div className="st-sub">Zoho items ({rows?.length ?? "…"})</div>
        <Field label="Find" value={filter} onChange={setFilter} />
        {shown.slice(0, 300).map((r) => (
          <p className="st-note" key={r.zoho_item_id}>
            <span className="st-code">{r.sku}</span> {r.name}
            {" · "}{zar(r.rate_minor)}
            {" · Zoho stock "}{r.stock_on_hand ?? "—"}
            {r.status === "inactive" && " · inactive"}
            {r.part_id == null && " · NOT LINKED"}
          </p>
        ))}
      </div>
    </>
  );
}

// Write-back (0047, server/edge/zoho-push). Invoices issued in CTP Core become
// Zoho invoices; supplier receipts posted on the desktop become Zoho bills.
// Only from the go-live date on — the history is imported into Zoho by the
// accountant and must never be pushed a second time.

type ZohoConfig = { push_enabled: boolean; push_from: string | null; invoice_as_draft: boolean;
  bill_as_draft: boolean; tax_id: string | null };
type QueueRow = { doc_type: string; ctp_id: number; ctp_ref: string; doc_at: string; last_error: string | null };
type PushLog = { id: number; at: string; doc_type: string; ctp_ref: string | null; action: string;
  ok: boolean; message: string | null };

function ZohoPushCard({ flash, fail }: PanelProps) {
  const [cfg, setCfg] = useState<ZohoConfig | null>(null);
  const [from, setFrom] = useState("");
  const [taxId, setTaxId] = useState("");
  const [queue, setQueue] = useState<QueueRow[]>([]);
  const [log, setLog] = useState<PushLog[]>([]);
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<string | null>(null);

  const load = useCallback(() => {
    supabase.from("zoho_config").select("push_enabled,push_from,invoice_as_draft,bill_as_draft,tax_id").eq("id", 1).maybeSingle()
      .then(({ data, error }) => {
        if (error) return fail(error);
        const c = data as ZohoConfig | null;
        setCfg(c); setFrom(c?.push_from ? c.push_from.slice(0, 16) : ""); setTaxId(c?.tax_id ?? "");
      });
    supabase.from("zoho_push_queue").select("doc_type,ctp_id,ctp_ref,doc_at,last_error").order("doc_at")
      .then(({ data }) => setQueue((data ?? []) as QueueRow[]));
    supabase.from("zoho_push_log").select("id,at,doc_type,ctp_ref,action,ok,message")
      .order("at", { ascending: false }).limit(30)
      .then(({ data }) => setLog((data ?? []) as PushLog[]));
  }, []);
  useEffect(load, [load]);

  const save = async (patch: Partial<ZohoConfig>) => {
    if (!cfg) return;
    const next = { ...cfg, ...patch };
    const pushFrom = from ? new Date(from).toISOString() : null;
    if (next.push_enabled && !cfg.push_enabled &&
        !confirm(`Start sending to Zoho?\n\nOnly invoices and receipts from ${pushFrom ? new Date(pushFrom).toLocaleString("en-ZA") : "(no date)"} onward will be sent — never anything earlier.`)) return;
    const { error } = await supabase.rpc("set_zoho_config", {
      p_push_enabled: next.push_enabled, p_push_from: pushFrom,
      p_invoice_as_draft: next.invoice_as_draft, p_bill_as_draft: next.bill_as_draft, p_tax_id: taxId || null,
    });
    if (error) return fail(error);
    flash("Zoho settings saved.");
    load();
  };

  const call = async (body: Record<string, unknown>, label: string) => {
    setBusy(true); setOut(null);
    const { data, error } = await supabase.functions.invoke("zoho-push", { body });
    setBusy(false);
    let res = data as Record<string, unknown> | null;
    if (error) {
      try { res = await (error as { context?: Response }).context?.json(); } catch { /* keep */ }
      if (!res) return fail(error);
    }
    setOut(JSON.stringify(res, null, 2));
    if (res && res.ok === false) fail(new Error(`${label}: ${String(res.error ?? "some documents failed — see below")}`));
    else flash(`${label}: done.`);
    load();
  };

  if (!cfg) return <div className="st-card"><div className="st-sub">Sending to Zoho</div>
    <p className="st-note">Not set up on the server yet (migration 0047).</p></div>;

  const failed = queue.filter((q) => q.last_error);
  return (
    <>
      <div className="st-card">
        <div className="st-sub">Sending to Zoho {cfg.push_enabled ? "· ON" : "· OFF"}</div>
        <Field label="Go-live: send documents from" value={from} onChange={setFrom}
          hint="YYYY-MM-DDTHH:MM, Johannesburg time. Nothing invoiced or received before this is ever sent — the accountant imports the history." />
        <Toggle label="Send invoices to Zoho as DRAFT" checked={cfg.invoice_as_draft}
          onChange={(v) => save({ invoice_as_draft: v })} hint="Draft = the accountant reviews and sends it from Zoho." />
        <Toggle label="Send supplier bills to Zoho as DRAFT" checked={cfg.bill_as_draft}
          onChange={(v) => save({ bill_as_draft: v })} />
        <Field label="Zoho tax id for VAT (optional)" value={taxId} onChange={setTaxId}
          hint="Blank = use the Zoho tax whose rate matches the order's VAT rate." />
        <div className="st-row2">
          <button className="st-save" onClick={() => save({})}>Save</button>
          <button className="st-save" onClick={() => save({ push_enabled: !cfg.push_enabled })}>
            {cfg.push_enabled ? "Stop sending" : "Start sending"}</button>
        </div>
      </div>

      <div className="st-card">
        <div className="st-sub">Waiting to send ({queue.length}){failed.length ? ` · ${failed.length} FAILED` : ""}</div>
        {queue.length === 0 && <p className="st-note">Nothing waiting.</p>}
        {queue.map((q) => (
          <p className="st-note" key={q.doc_type + q.ctp_id}>
            {q.doc_type === "invoice" ? "Invoice" : "Bill"} <span className="st-code">{q.ctp_ref}</span>
            {" · "}{new Date(q.doc_at).toLocaleString("en-ZA")}
            {q.last_error && <><br /><b>✕ {q.last_error}</b></>}
          </p>
        ))}
        <div className="st-row2">
          <button className="st-save" disabled={busy || queue.length === 0} onClick={() => call({ action: "push" }, "Send to Zoho")}>
            {busy ? "Working…" : "Send now"}</button>
          <button className="st-save" disabled={busy} onClick={() => {
            if (confirm("Create a TEST draft invoice and bill in Zoho against TEST contacts, then delete them?")) call({ action: "test" }, "Zoho test");
          }}>Run Zoho test</button>
        </div>
        {out && <pre className="st-note" style={{ whiteSpace: "pre-wrap", overflowX: "auto" }}>{out}</pre>}
      </div>

      <div className="st-card">
        <div className="st-sub">Zoho log</div>
        {log.length === 0 && <p className="st-note">Nothing yet.</p>}
        {log.map((l) => (
          <p className="st-note" key={l.id}>
            {l.ok ? "✓" : <b>✕</b>} {new Date(l.at).toLocaleString("en-ZA")} · {l.doc_type} {l.ctp_ref ?? ""} · {l.action}
            {l.message && <><br />{l.message.length > 300 ? l.message.slice(0, 300) + "…" : l.message}</>}
          </p>
        ))}
      </div>
    </>
  );
}

/* ── small shared inputs ─────────────────────────────────────────────────── */

/** Today in Johannesburg as YYMMDD — only for the example in the hint. The
 *  real number is minted in the database (0042), never here. */
function todayYYMMDD(): string {
  const d = new Date(new Date().toLocaleString("en-US", { timeZone: "Africa/Johannesburg" }));
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getFullYear() % 100)}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

function Field({ label, value, onChange, hint, multiline, suffix }: {
  label: string; value: string; onChange: (v: string) => void;
  hint?: string; multiline?: boolean; suffix?: string;
}) {
  return (
    <div className="st-field">
      <div className="st-lbl">{label}</div>
      <div className={suffix ? "st-withsuffix" : ""}>
        {multiline
          ? <textarea className="st-in" rows={3} value={value} onChange={(e) => onChange(e.target.value)} />
          : <input className="st-in" value={value} onChange={(e) => onChange(e.target.value)} />}
        {suffix && <span className="st-suffix">{suffix}</span>}
      </div>
      {hint && <p className="st-note">{hint}</p>}
    </div>
  );
}

function Toggle({ label, checked, onChange, hint }: {
  label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string;
}) {
  return (
    <div className="st-field">
      <label className="st-toggle">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span>{label}</span>
      </label>
      {hint && <p className="st-note">{hint}</p>}
    </div>
  );
}
