// Add a customer, Zoho-first (Phase 1, docs/06; 0057, server/edge/zoho-company).
//
// Company = a Zoho Books customer contact; person = a Zoho contact person on it.
// Pick the company (searchable; Zoho-linked ones listed), or "+ New company":
// CHECK ZOHO shows what Zoho and CTP Core already have that matches, and only
// then can it be linked or created in Zoho. Same for the person. Nothing here
// creates a login: "Invite to the app" (admins) uses the existing invite flow
// and links the new login to this person, and so to the company.
//
// Shared by the phone (counter sale) and the desktop (New quote).
import { useEffect, useMemo, useState } from "react";
import { supabase } from "../sync/supabase";

type Co = { id: number; code: string; name: string; email: string | null; vat_no: string | null;
            zoho_contact_id: string | null; people: number };
type ZMatch = { zoho_contact_id: string; name: string; company_name: string | null; email: string | null; why: string[] };
type PMatch = { zoho_contact_person_id: string; name: string; email: string | null; phone: string | null; why: string[] };
// deno-lint-ignore no-explicit-any
type Any = any;

async function call(body: Record<string, unknown>): Promise<Any> {
  const { data, error } = await supabase.functions.invoke("zoho-company", { body });
  if (error) {
    let res: Any = null;
    try { res = await (error as { context?: Response }).context?.json(); } catch { /* none */ }
    return res ?? { ok: false, error: error.message };
  }
  return data;
}

const box: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 8 };
const input = "mb-hs-in";

export default function AddCustomer({ onDone, onCancel, isAdmin }: {
  onDone: (customerId: number, label: string) => void; onCancel: () => void; isAdmin: boolean;
}) {
  const [cos, setCos] = useState<Co[]>([]);
  const [find, setFind] = useState("");
  const [coId, setCoId] = useState<number | null>(null);
  const [newCo, setNewCo] = useState(false);
  const [co, setCo] = useState({ name: "", email: "", vat_no: "", phone: "", address: "", city: "", zip: "" });
  const [coPrev, setCoPrev] = useState<Any>(null);
  const [person, setPerson] = useState({ first_name: "", last_name: "", email: "", phone: "" });
  const [pPrev, setPPrev] = useState<Any>(null);
  const [done, setDone] = useState<{ personId: number; email: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = () => supabase.from("company_directory").select("*").order("name").limit(2000)
    .then(({ data }) => setCos((data ?? []) as Co[]));
  useEffect(() => { load(); }, []);

  const shown = useMemo(() => {
    const f = find.trim().toLowerCase();
    return cos.filter((c) => !f || c.name.toLowerCase().includes(f) || (c.email ?? "").toLowerCase().includes(f));
  }, [cos, find]);
  const picked = cos.find((c) => c.id === coId) ?? null;

  const run = async (body: Record<string, unknown>) => {
    setBusy(true); setMsg(null);
    const r = await call(body);
    setBusy(false);
    if (!r?.ok) setMsg({ ok: false, text: r?.error ?? "Failed" });
    return r?.ok ? r : null;
  };

  const companyBody = () => ({ name: co.name, email: co.email, vat_no: co.vat_no, phone: co.phone,
    billing: { address: co.address, city: co.city, zip: co.zip, country: "South Africa" } });

  const checkCompany = async () => { const r = await run({ action: "company_preview", company: companyBody() }); setCoPrev(r); };
  const createCompany = async (link?: string) => {
    const r = await run({ action: "company_create", company: companyBody(), confirm: true, ...(link ? { link_zoho_contact_id: link } : {}) });
    if (!r) return;
    await load();
    setCoId(r.customer?.id ?? null); setNewCo(false); setCoPrev(null);
    setMsg({ ok: true, text: `${r.customer?.name ?? co.name} ${r.how === "created" ? "created in Zoho" : "linked to Zoho"}.` });
  };
  const checkPerson = async () => { const r = await run({ action: "person_preview", customer_id: coId, person }); setPPrev(r); };
  const createPerson = async (link?: string) => {
    const r = await run({ action: "person_create", customer_id: coId, person, confirm: true,
                          ...(link ? { link_zoho_contact_person_id: link } : {}) });
    if (!r) return;
    setDone({ personId: r.person_id, email: person.email });
    setMsg({ ok: true, text: `${person.first_name} ${r.how === "added" ? "added to" : "linked on"} the Zoho contact.` });
  };
  const invite = async () => {
    setBusy(true); setMsg(null);
    const { data, error } = await supabase.functions.invoke("admin-users", { body: {
      action: "invite", email: done!.email, role: "customer",
      display_name: `${person.first_name} ${person.last_name}`.trim(), person_id: done!.personId } });
    setBusy(false);
    if (error || !data?.ok) return setMsg({ ok: false, text: (data as Any)?.error ?? error?.message ?? "Invite failed" });
    setMsg({ ok: true, text: `Invite sent to ${done!.email}${data.person_linked ? " — the login belongs to this company" : ""}.` });
  };

  const strong = (m: ZMatch) => m.why.some((w) => w.startsWith("same"));

  return (
    <div style={box}>
      <div className="mb-count" style={{ paddingTop: 0 }}>Add customer</div>

      {/* 1. company */}
      {!newCo && (
        <>
          <input className={input} type="search" placeholder="Search companies…" value={find} onChange={(e) => setFind(e.target.value)} />
          <select className={input} value={coId ?? ""} onChange={(e) => setCoId(e.target.value ? Number(e.target.value) : null)}>
            <option value="">— company —</option>
            {shown.map((c) => <option key={c.id} value={c.id}>{c.name}{c.zoho_contact_id ? "" : " (not in Zoho)"}</option>)}
          </select>
          <button className="mb-btn" disabled={busy} onClick={() => { setNewCo(true); setCoId(null); setCo({ ...co, name: find }); }}>+ New company</button>
        </>
      )}
      {newCo && (
        <>
          <input className={input} placeholder="Company name" value={co.name} onChange={(e) => { setCo({ ...co, name: e.target.value }); setCoPrev(null); }} />
          <input className={input} placeholder="Accounts email" value={co.email} onChange={(e) => { setCo({ ...co, email: e.target.value }); setCoPrev(null); }} />
          <input className={input} placeholder="VAT number (if registered)" value={co.vat_no} onChange={(e) => { setCo({ ...co, vat_no: e.target.value }); setCoPrev(null); }} />
          <input className={input} placeholder="Phone" value={co.phone} onChange={(e) => setCo({ ...co, phone: e.target.value })} />
          <input className={input} placeholder="Billing address" value={co.address} onChange={(e) => setCo({ ...co, address: e.target.value })} />
          <div style={{ display: "flex", gap: 8 }}>
            <input className={input} style={{ flex: 2 }} placeholder="City" value={co.city} onChange={(e) => setCo({ ...co, city: e.target.value })} />
            <input className={input} style={{ flex: 1 }} placeholder="Code" value={co.zip} onChange={(e) => setCo({ ...co, zip: e.target.value })} />
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="mb-btn" disabled={busy} onClick={() => { setNewCo(false); setCoPrev(null); }}>Back</button>
            <button className="mb-btn p" disabled={busy || !co.name.trim()} onClick={checkCompany}>{busy ? "Checking…" : "Check Zoho"}</button>
          </div>
          {coPrev && (
            <div className="mb-csku" style={box}>
              <div><b>{coPrev.suggestion}</b></div>
              {coPrev.ctp_matches.map((m: Any) => (
                <button key={m.id} className="mb-btn" onClick={() => { setCoId(m.id); setNewCo(false); setCoPrev(null); }}>
                  Use {m.name} ({m.code}) — already in CTP Core</button>
              ))}
              {!coPrev.ctp_matches.length && coPrev.zoho_matches.map((m: ZMatch) => (
                <button key={m.zoho_contact_id} className="mb-btn" disabled={busy} onClick={() => createCompany(m.zoho_contact_id)}>
                  Link Zoho contact “{m.name}”{m.email ? ` · ${m.email}` : ""} ({m.why.join(", ")})</button>
              ))}
              {!coPrev.ctp_matches.length && !coPrev.zoho_matches.some(strong) && (
                <button className="mb-btn p" disabled={busy} onClick={() => createCompany()}>Create “{co.name}” in Zoho as a customer</button>
              )}
            </div>
          )}
        </>
      )}

      {/* 2. person */}
      {picked && !done && (
        <>
          <div className="mb-csku">Person at <b>{picked.name}</b>{picked.zoho_contact_id ? "" : " — link this company to Zoho first"}</div>
          {picked.zoho_contact_id && (
            <>
              <div style={{ display: "flex", gap: 8 }}>
                <input className={input} style={{ flex: 1 }} placeholder="First name" value={person.first_name} onChange={(e) => { setPerson({ ...person, first_name: e.target.value }); setPPrev(null); }} />
                <input className={input} style={{ flex: 1 }} placeholder="Last name" value={person.last_name} onChange={(e) => { setPerson({ ...person, last_name: e.target.value }); setPPrev(null); }} />
              </div>
              <input className={input} placeholder="Email" value={person.email} onChange={(e) => { setPerson({ ...person, email: e.target.value }); setPPrev(null); }} />
              <input className={input} placeholder="Phone" value={person.phone} onChange={(e) => setPerson({ ...person, phone: e.target.value })} />
              <button className="mb-btn p" disabled={busy || !person.first_name.trim()} onClick={checkPerson}>{busy ? "Checking…" : "Check Zoho"}</button>
              {pPrev && (
                <div className="mb-csku" style={box}>
                  <div><b>{pPrev.suggestion}</b></div>
                  {pPrev.zoho_matches.map((m: PMatch) => (
                    <button key={m.zoho_contact_person_id} className="mb-btn" disabled={busy || pPrev.ctp_matches.length > 0}
                      onClick={() => createPerson(m.zoho_contact_person_id)}>Link “{m.name}”{m.email ? ` · ${m.email}` : ""} ({m.why.join(", ")})</button>
                  ))}
                  {!pPrev.ctp_matches.length && !pPrev.zoho_matches.length && (
                    <button className="mb-btn p" disabled={busy} onClick={() => createPerson()}>Add {person.first_name} to the Zoho contact</button>
                  )}
                </div>
              )}
            </>
          )}
          <button className="mb-btn" onClick={() => onDone(picked.id, picked.name)}>Use {picked.name} without adding a person</button>
        </>
      )}

      {/* 3. done: optional invite through the existing flow */}
      {picked && done && (
        <>
          {isAdmin && done.email && <button className="mb-btn" disabled={busy} onClick={invite}>Invite {done.email} to the app</button>}
          <button className="mb-btn p" onClick={() => onDone(picked.id, picked.name)}>Done — use {picked.name}</button>
        </>
      )}

      {msg && <div className="mb-csku" style={{ color: msg.ok ? "var(--green, #2f855a)" : "var(--bad, #c0392b)" }}>{msg.text}</div>}
      <button className="mb-btn" onClick={onCancel}>Cancel</button>
    </div>
  );
}
