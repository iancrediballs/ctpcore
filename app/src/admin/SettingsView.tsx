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

type Section = "company" | "email" | "staff" | "places" | "tiers";

type Company = {
  name: string; address: string | null; phone: string | null; email: string | null;
  tax_id: string | null; reg_no: string | null; bank_details: string | null;
  terms: string | null; currency: string; default_tax_bps: number;
  invoice_prefix: string; quote_prefix: string;
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
      .select("name,address,phone,email,tax_id,reg_no,bank_details,terms,currency,default_tax_bps,invoice_prefix,quote_prefix")
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

      <div className="st-row2">
        <Field label="Quote prefix" value={c.quote_prefix} onChange={(v) => set("quote_prefix", v)} />
        <Field label="Invoice prefix" value={c.invoice_prefix} onChange={(v) => set("invoice_prefix", v)} />
      </div>

      <Field label="Banking details" value={c.bank_details ?? ""} onChange={(v) => set("bank_details", v)} multiline
        hint="Printed in the invoice footer so customers can pay without asking." />
      <Field label="Payment terms" value={c.terms ?? ""} onChange={(v) => set("terms", v)} multiline />

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

/* ── small shared inputs ─────────────────────────────────────────────────── */

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
