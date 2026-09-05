import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
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
const ROLE_HELP = {
    customer: "Sees only their own quotes and orders. No prices, no stock, no bins.",
    sales: "Full catalogue, stock and the order desk. Can quote and price.",
    warehouse: "Full catalogue and stock. Receives, issues and counts.",
    manager: "Everything sales and warehouse can do, plus settings and accounting.",
    admin: "Everything, including adding and removing staff.",
};
const ROLES = ["customer", "sales", "warehouse", "manager", "admin"];
// Basis points are how the database stores rates (1500 = 15.00%), because
// integers cannot drift the way a stored 0.15 can. People type percentages.
const pctFromBps = (b) => b == null ? "" : (b / 100).toFixed(2).replace(/\.00$/, "");
const bpsFromPct = (s) => {
    const n = Number(String(s).replace(",", ".").trim());
    return Number.isFinite(n) ? Math.round(n * 100) : NaN;
};
export default function SettingsView({ role, onClose }) {
    const [section, setSection] = useState("company");
    const [toast, setToast] = useState(null);
    const [err, setErr] = useState(null);
    const canManage = role === "manager" || role === "admin";
    const isAdmin = role === "admin";
    const flash = (m) => { setErr(null); setToast(m); setTimeout(() => setToast(null), 3500); };
    const fail = (e) => {
        setToast(null);
        setErr(e instanceof Error ? e.message : String(e));
    };
    if (!canManage) {
        return (_jsxs("div", { className: "st-wrap", children: [_jsx(Header, { onClose: onClose }), _jsxs("div", { className: "mb-empty", children: [_jsx("h3", { children: "Settings are for managers" }), _jsx("p", { children: "Your login can use the app but not change how it is set up. Ask whoever runs the system if something here needs changing." })] })] }));
    }
    return (_jsxs("div", { className: "st-wrap", children: [_jsx(Header, { onClose: onClose }), _jsx("div", { className: "st-tabs", children: [
                    ["company", "Company"],
                    ["email", "Order emails"],
                    ...(isAdmin ? [["staff", "Staff & access"]] : []),
                    ["places", "Warehouses"],
                    ["tiers", "Pricing tiers"],
                ].map(([k, label]) => (_jsx("button", { className: "st-tab" + (section === k ? " on" : ""), onClick: () => { setSection(k); setErr(null); }, children: label }, k))) }), err && _jsxs("div", { className: "st-err", children: ["\u2715 ", err] }), toast && _jsxs("div", { className: "st-ok", children: ["\u2713 ", toast] }), _jsxs("div", { className: "st-body", children: [section === "company" && _jsx(CompanyPanel, { flash: flash, fail: fail }), section === "email" && _jsx(EmailPanel, { flash: flash, fail: fail }), section === "staff" && _jsx(StaffPanel, { flash: flash, fail: fail }), section === "places" && _jsx(PlacesPanel, { flash: flash, fail: fail }), section === "tiers" && _jsx(TiersPanel, { flash: flash, fail: fail })] })] }));
}
function Header({ onClose }) {
    return (_jsxs("div", { className: "st-head", children: [_jsx("button", { className: "st-back", onClick: onClose, "aria-label": "Close settings", children: "\u2039" }), _jsx("span", { className: "st-title", children: "Settings" })] }));
}
/* ── Company & invoicing ─────────────────────────────────────────────────── */
function CompanyPanel({ flash, fail }) {
    const [c, setC] = useState(null);
    const [busy, setBusy] = useState(false);
    useEffect(() => {
        supabase.from("company")
            .select("name,address,phone,email,tax_id,reg_no,bank_details,terms,currency,default_tax_bps,invoice_prefix,quote_prefix")
            .eq("id", 1).maybeSingle()
            .then(({ data, error }) => error ? fail(error) : setC(data));
    }, []);
    if (!c)
        return _jsx("div", { className: "st-loading", children: "Loading\u2026" });
    const set = (k, v) => setC({ ...c, [k]: v });
    const save = async () => {
        setBusy(true);
        const { error } = await supabase.rpc("set_company_profile", { payload: c });
        setBusy(false);
        error ? fail(error) : flash("Company details saved. New quotes and invoices use them immediately.");
    };
    return (_jsxs(_Fragment, { children: [_jsx("p", { className: "st-lead", children: "This is the letterhead. It prints at the top of every quote and every tax invoice you send a customer." }), _jsx(Field, { label: "Registered name", value: c.name, onChange: (v) => set("name", v) }), _jsx(Field, { label: "Trading address", value: c.address ?? "", onChange: (v) => set("address", v), multiline: true }), _jsx(Field, { label: "Phone", value: c.phone ?? "", onChange: (v) => set("phone", v) }), _jsx(Field, { label: "Email", value: c.email ?? "", onChange: (v) => set("email", v) }), _jsx(Field, { label: "VAT number", value: c.tax_id ?? "", onChange: (v) => set("tax_id", v), hint: "Leave blank rather than guess. A wrong VAT number on a tax invoice breaks your customer's own VAT claim." }), _jsx(Field, { label: "Company registration number", value: c.reg_no ?? "", onChange: (v) => set("reg_no", v) }), _jsx(Field, { label: "Default VAT rate", value: pctFromBps(c.default_tax_bps), onChange: (v) => { const b = bpsFromPct(v); if (!Number.isNaN(b))
                    set("default_tax_bps", b); }, suffix: "%", hint: "Applied to new orders. South African VAT is 15%." }), _jsxs("div", { className: "st-row2", children: [_jsx(Field, { label: "Quote prefix", value: c.quote_prefix, onChange: (v) => set("quote_prefix", v) }), _jsx(Field, { label: "Invoice prefix", value: c.invoice_prefix, onChange: (v) => set("invoice_prefix", v) })] }), _jsx(Field, { label: "Banking details", value: c.bank_details ?? "", onChange: (v) => set("bank_details", v), multiline: true, hint: "Printed in the invoice footer so customers can pay without asking." }), _jsx(Field, { label: "Payment terms", value: c.terms ?? "", onChange: (v) => set("terms", v), multiline: true }), _jsx("button", { className: "st-save", disabled: busy, onClick: save, children: busy ? "Saving…" : "Save company details" })] }));
}
/* ── Order emails ────────────────────────────────────────────────────────── */
function EmailPanel({ flash, fail }) {
    const [s, setS] = useState(null);
    const [recipients, setRecipients] = useState("");
    const [busy, setBusy] = useState(false);
    const [testing, setTesting] = useState(false);
    useEffect(() => {
        supabase.from("notify_setting")
            .select("enabled,recipients,from_name,reply_to,on_request,on_quote_accepted,on_quote_declined")
            .eq("id", 1).maybeSingle()
            .then(({ data, error }) => {
            if (error)
                return fail(error);
            const row = data;
            setS(row);
            setRecipients((row.recipients ?? []).join(", "));
        });
    }, []);
    if (!s)
        return _jsx("div", { className: "st-loading", children: "Loading\u2026" });
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
    return (_jsxs(_Fragment, { children: [_jsx("p", { className: "st-lead", children: "Who hears about it when a customer sends a request or answers a quote." }), _jsx(Toggle, { label: "Send order emails", checked: s.enabled, onChange: (v) => setS({ ...s, enabled: v }), hint: "Turn everything off without losing your settings." }), _jsx(Field, { label: "Send to", value: recipients, onChange: setRecipients, hint: "Separate several addresses with commas." }), _jsx(Field, { label: "Reply-to address", value: s.reply_to ?? "", onChange: (v) => setS({ ...s, reply_to: v }), hint: "Where a reply goes if someone answers one of these emails." }), _jsx(Field, { label: "Sender name", value: s.from_name, onChange: (v) => setS({ ...s, from_name: v }) }), _jsx("div", { className: "st-sub", children: "Send an email when\u2026" }), _jsx(Toggle, { label: "A customer sends a parts request", checked: s.on_request, onChange: (v) => setS({ ...s, on_request: v }) }), _jsx(Toggle, { label: "A customer accepts a quote", checked: s.on_quote_accepted, onChange: (v) => setS({ ...s, on_quote_accepted: v }) }), _jsx(Toggle, { label: "A customer declines a quote", checked: s.on_quote_declined, onChange: (v) => setS({ ...s, on_quote_declined: v }) }), _jsx("button", { className: "st-save", disabled: busy, onClick: save, children: busy ? "Saving…" : "Save email settings" }), _jsx("button", { className: "st-second", disabled: testing, onClick: test, children: testing ? "Sending…" : "Send a test email" }), _jsx("p", { className: "st-note", children: "The test proves the whole chain works \u2014 the app, the mail service, and the address above. If it does not arrive within a minute or two, something in that chain needs attention." })] }));
}
/* ── Staff & access ──────────────────────────────────────────────────────── */
function StaffPanel({ flash, fail }) {
    const [users, setUsers] = useState(null);
    const [busy, setBusy] = useState(null);
    const [email, setEmail] = useState("");
    const [name, setName] = useState("");
    const [newRole, setNewRole] = useState("warehouse");
    const call = useCallback(async (body) => {
        const { data, error } = await supabase.functions.invoke("admin-users", { body });
        if (error) {
            // The function's own message is far more useful than "Edge Function
            // returned a non-2xx status code", so dig it out of the response.
            let msg = error.message;
            try {
                const ctx = error.context;
                if (ctx) {
                    const j = await ctx.json();
                    if (j?.error)
                        msg = j.error;
                }
            }
            catch { /* keep the generic message */ }
            throw new Error(msg);
        }
        if (data?.error)
            throw new Error(data.error);
        return data;
    }, []);
    const load = useCallback(async () => {
        try {
            const d = await call({ action: "list" });
            setUsers(d.users);
        }
        catch (e) {
            fail(e);
            setUsers([]);
        }
    }, [call]);
    useEffect(() => { load(); }, [load]);
    const invite = async () => {
        setBusy("invite");
        try {
            await call({ action: "invite", email, role: newRole, display_name: name });
            flash(`Invitation sent to ${email}. They set their own password from the email.`);
            setEmail("");
            setName("");
            await load();
        }
        catch (e) {
            fail(e);
        }
        finally {
            setBusy(null);
        }
    };
    const setRole = async (u, r) => {
        setBusy(u.id);
        try {
            await call({ action: "set_role", id: u.id, role: r });
            flash(`${u.email} is now ${r}.`);
            await load();
        }
        catch (e) {
            fail(e);
        }
        finally {
            setBusy(null);
        }
    };
    const remove = async (u) => {
        setBusy(u.id);
        try {
            await call({ action: "remove", id: u.id });
            flash(`Removed ${u.email}.`);
            await load();
        }
        catch (e) {
            fail(e);
        }
        finally {
            setBusy(null);
        }
    };
    return (_jsxs(_Fragment, { children: [_jsx("p", { className: "st-lead", children: "Who can sign in, and what they see once they do. Roles are enforced by the database itself, not just by hiding buttons." }), _jsxs("div", { className: "st-card", children: [_jsx("div", { className: "st-sub", children: "Invite someone" }), _jsx(Field, { label: "Email address", value: email, onChange: setEmail }), _jsx(Field, { label: "Name", value: name, onChange: setName }), _jsx("div", { className: "st-lbl", children: "Role" }), _jsx("select", { className: "st-in", value: newRole, onChange: (e) => setNewRole(e.target.value), children: ROLES.map((r) => _jsx("option", { value: r, children: r }, r)) }), _jsx("p", { className: "st-note", children: ROLE_HELP[newRole] }), _jsx("button", { className: "st-save", disabled: busy === "invite" || !email.includes("@"), onClick: invite, children: busy === "invite" ? "Sending…" : "Send invitation" }), _jsx("p", { className: "st-note", children: "They receive an email and choose their own password. No one \u2014 including you \u2014 ever sees or sets it." })] }), _jsx("div", { className: "st-sub", children: "Everyone with access" }), users === null && _jsx("div", { className: "st-loading", children: "Loading\u2026" }), users?.length === 0 && _jsx("div", { className: "st-note", children: "Nobody listed." }), users?.map((u) => (_jsxs("div", { className: "st-user", children: [_jsxs("div", { className: "st-uinfo", children: [_jsx("div", { className: "st-uname", children: u.display_name || u.email }), _jsx("div", { className: "st-umail", children: u.email }), _jsxs("div", { className: "st-umeta", children: [u.confirmed ? "" : "invitation not accepted yet · ", u.last_sign_in_at
                                        ? `last signed in ${new Date(u.last_sign_in_at).toLocaleDateString()}`
                                        : "never signed in"] })] }), _jsxs("div", { className: "st-uact", children: [_jsxs("select", { className: "st-in st-role", value: u.role ?? "", disabled: busy === u.id, onChange: (e) => setRole(u, e.target.value), children: [!u.role && _jsx("option", { value: "", children: "no role" }), ROLES.map((r) => _jsx("option", { value: r, children: r }, r))] }), _jsx("button", { className: "st-remove", disabled: busy === u.id, onClick: () => remove(u), children: "Remove" })] })] }, u.id)))] }));
}
/* ── Warehouses ──────────────────────────────────────────────────────────── */
function PlacesPanel({ flash, fail }) {
    const [rows, setRows] = useState(null);
    const [code, setCode] = useState("");
    const [name, setName] = useState("");
    const [busy, setBusy] = useState(false);
    const load = useCallback(() => {
        supabase.from("location").select("id,code,name,deleted_at").order("code")
            .then(({ data, error }) => error ? fail(error) : setRows((data ?? [])));
    }, []);
    useEffect(load, [load]);
    const add = async () => {
        setBusy(true);
        const { error } = await supabase.rpc("upsert_location", { p_id: null, p_code: code, p_name: name });
        setBusy(false);
        if (error)
            return fail(error);
        flash(`Added ${code.toUpperCase()}.`);
        setCode("");
        setName("");
        load();
    };
    const retire = async (l) => {
        const { error } = await supabase.rpc("retire_location", { p_id: l.id });
        if (error)
            return fail(error);
        flash(`${l.code} retired.`);
        load();
    };
    return (_jsxs(_Fragment, { children: [_jsx("p", { className: "st-lead", children: "Where stock physically lives. Every receipt, issue and count is recorded against one of these." }), rows?.filter((r) => !r.deleted_at).map((l) => (_jsxs("div", { className: "st-user", children: [_jsxs("div", { className: "st-uinfo", children: [_jsx("div", { className: "st-uname", children: l.code }), _jsx("div", { className: "st-umail", children: l.name })] }), _jsx("div", { className: "st-uact", children: _jsx("button", { className: "st-remove", onClick: () => retire(l), children: "Retire" }) })] }, l.id))), _jsxs("div", { className: "st-card", children: [_jsx("div", { className: "st-sub", children: "Add a warehouse" }), _jsxs("div", { className: "st-row2", children: [_jsx(Field, { label: "Short code", value: code, onChange: setCode }), _jsx(Field, { label: "Name", value: name, onChange: setName })] }), _jsx("button", { className: "st-save", disabled: busy || !code.trim(), onClick: add, children: busy ? "Adding…" : "Add warehouse" }), _jsx("p", { className: "st-note", children: "A warehouse holding stock cannot be retired \u2014 move the stock out first. Retiring never deletes history; past movements keep pointing at it." })] })] }));
}
/* ── Pricing tiers ───────────────────────────────────────────────────────── */
function TiersPanel({ flash, fail }) {
    const [rows, setRows] = useState(null);
    const [edits, setEdits] = useState({});
    const load = useCallback(() => {
        supabase.from("price_tier").select("id,code,name,discount_bps,min_margin_bps").order("code")
            .then(({ data, error }) => {
            if (error)
                return fail(error);
            const list = (data ?? []);
            setRows(list);
            setEdits(Object.fromEntries(list.map((t) => [t.id, {
                    d: pctFromBps(t.discount_bps), m: pctFromBps(t.min_margin_bps),
                }])));
        });
    }, []);
    useEffect(load, [load]);
    const save = async (t) => {
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
        if (error)
            return fail(error);
        flash(`${t.name} updated.`);
        load();
    };
    return (_jsxs(_Fragment, { children: [_jsx("p", { className: "st-lead", children: "What each kind of customer pays off the list price, and how far a salesperson may go before the margin floor stops them." }), rows === null && _jsx("div", { className: "st-loading", children: "Loading\u2026" }), rows?.map((t) => (_jsxs("div", { className: "st-card", children: [_jsxs("div", { className: "st-sub", children: [t.name, " ", _jsx("span", { className: "st-code", children: t.code })] }), _jsxs("div", { className: "st-row2", children: [_jsx(Field, { label: "Discount off list", value: edits[t.id]?.d ?? "", suffix: "%", onChange: (v) => setEdits({ ...edits, [t.id]: { ...edits[t.id], d: v } }) }), _jsx(Field, { label: "Minimum margin", value: edits[t.id]?.m ?? "", suffix: "%", onChange: (v) => setEdits({ ...edits, [t.id]: { ...edits[t.id], m: v } }) })] }), _jsxs("button", { className: "st-save", onClick: () => save(t), children: ["Save ", t.name] })] }, t.id))), _jsx("p", { className: "st-note", children: "Changing a tier does not rewrite quotes already sent. Every order line keeps the price it was quoted at \u2014 that is deliberate, and it is why a price change today cannot silently alter what you promised last week." })] }));
}
/* ── small shared inputs ─────────────────────────────────────────────────── */
function Field({ label, value, onChange, hint, multiline, suffix }) {
    return (_jsxs("div", { className: "st-field", children: [_jsx("div", { className: "st-lbl", children: label }), _jsxs("div", { className: suffix ? "st-withsuffix" : "", children: [multiline
                        ? _jsx("textarea", { className: "st-in", rows: 3, value: value, onChange: (e) => onChange(e.target.value) })
                        : _jsx("input", { className: "st-in", value: value, onChange: (e) => onChange(e.target.value) }), suffix && _jsx("span", { className: "st-suffix", children: suffix })] }), hint && _jsx("p", { className: "st-note", children: hint })] }));
}
function Toggle({ label, checked, onChange, hint }) {
    return (_jsxs("div", { className: "st-field", children: [_jsxs("label", { className: "st-toggle", children: [_jsx("input", { type: "checkbox", checked: checked, onChange: (e) => onChange(e.target.checked) }), _jsx("span", { children: label })] }), hint && _jsx("p", { className: "st-note", children: hint })] }));
}
