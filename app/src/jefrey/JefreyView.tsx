// CTP Core — Jefrey. Offline parts assistant: identify, quote, source,
// reconcile, pick, audit, ask. Everything runs against a local snapshot of the
// catalogue, so it works with no connection and answers in milliseconds.
import { Fragment, useEffect, useMemo, useRef, useState, useCallback } from "react";
import * as api from "../data/api";
import {
  Part, Row, RustPart, AliasRow, fromRust, identify, memory, normalise,
} from "./brain";
import {
  buildQuote, buildRFQ, buildPickList, auditCatalogue, ask, draftReply,
  reconcile, crossRefs, resolved, money, Quote, Answer, Finding, GoodsFinding,
} from "./skills";

type Mode = "identify" | "goods" | "ask" | "audit";
type Panel = "none" | "quote" | "rfq" | "pick" | "reply";
type JState = "idle" | "scanning" | "confident" | "ambiguous" | "void";

const SAMPLE = `Good morning Ian
Please quote the following for the JH6:
1) 2803035B1063 - 6 pcs
2) fender lh  x2
3) drivers door skin qty 3
4) bull bar bracket right hand - 5 pcs
5) mud flap rear x4
Thanks`;

/* ---------------------------------------------------------------- Jefrey */

function JefreyHead({ state }: { state: JState }) {
  return (
    <svg className={"jf-svg jf-" + state} viewBox="0 0 120 132" width="86" height="95">
      <defs>
        <linearGradient id="jfsteel" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#39444d" /><stop offset=".45" stopColor="#242d34" /><stop offset="1" stopColor="#161d22" />
        </linearGradient>
        <linearGradient id="jfsteel2" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#1b2228" /><stop offset=".5" stopColor="#2c363e" /><stop offset="1" stopColor="#1b2228" />
        </linearGradient>
        <clipPath id="jfvisor"><rect x="26" y="46" width="68" height="20" rx="4" /></clipPath>
      </defs>
      <g className="jf-head">
        <rect x="58.2" y="6" width="3.6" height="14" fill="#2b353d" />
        <circle className="jf-led" cx="60" cy="5" r="3.4" />
        <circle cx="60" cy="5" r="6.5" fill="currentColor" opacity=".13" />
        <rect x="48" y="98" width="24" height="10" fill="#1a2126" />
        <rect x="38" y="106" width="44" height="7" rx="2" fill="#232c33" />
        <rect x="14" y="19" width="92" height="82" rx="9" fill="url(#jfsteel)" stroke="#4a5761" strokeWidth="1.2" />
        <rect x="20" y="25" width="80" height="2" rx="1" fill="#4d5b66" opacity=".55" />
        {[[23, 28], [97, 28], [23, 92], [97, 92]].map(([cx, cy]) => (
          <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="2.6" fill="#151b20" stroke="#525f6a" strokeWidth=".9" />
        ))}
        <rect x="6" y="50" width="9" height="26" rx="3" fill="url(#jfsteel2)" stroke="#3d4952" />
        <rect x="105" y="50" width="9" height="26" rx="3" fill="url(#jfsteel2)" stroke="#3d4952" />
        <rect x="24" y="44" width="72" height="24" rx="5" fill="#080b0d" stroke="#3d4952" strokeWidth="1.1" />
        <g clipPath="url(#jfvisor)">
          <rect className="jf-glow" x="26" y="46" width="68" height="20" />
          <rect className="jf-eye" x="52" y="49" width="16" height="14" rx="3" />
          <rect className="jf-scan" x="26" y="42" width="68" height="1.6" fill="#ffe0b0" />
        </g>
        <rect x="34" y="76" width="52" height="16" rx="3" fill="#12181c" stroke="#333f47" strokeWidth=".9" />
        {[79.5, 83.2, 86.9].map((y) => <rect key={y} x="38" y={y} width="44" height="1.7" rx=".8" fill="#3b4750" />)}
        <text x="60" y="38" textAnchor="middle" fontFamily="ui-monospace,monospace" fontSize="7.5" letterSpacing="2.2" fill="#5b6a75">JFY-01</text>
      </g>
    </svg>
  );
}

/* ------------------------------------------------------------------ view */

export default function JefreyView() {
  const [cat, setCat] = useState<Part[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [aliasN, setAliasN] = useState(0);

  const [mode, setMode] = useState<Mode>("identify");
  const [text, setText] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel>("none");
  const [ms, setMs] = useState(0);
  const [jstate, setJState] = useState<JState>("idle");
  const [say, setSay] = useState("Paste a customer request. I read it here on this machine — no connection needed.");
  const [toast, setToast] = useState<string | null>(null);

  const [goodsText, setGoodsText] = useState("");
  const [goods, setGoods] = useState<ReturnType<typeof reconcile> | null>(null);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<Answer | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const flash = useCallback((m: string) => {
    setToast(m);
    window.setTimeout(() => setToast(null), 2800);
  }, []);

  /* ---- load the catalogue snapshot + everything Jefrey has been taught --- */
  const reload = useCallback(async () => {
    try {
      const [raw, aliases] = await Promise.all([
        api.jefreyCatalogue<RustPart[]>(),
        api.jefreyAliases<AliasRow[]>(),
      ]);
      memory.load(aliases);
      setAliasN(memory.size);
      setCat(fromRust(raw));
      setErr(null);
    } catch (e) {
      setErr(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const audit = useMemo(() => (cat.length ? auditCatalogue(cat) : null), [cat]);
  const quote: Quote | null = useMemo(() => (rows.length ? buildQuote(rows) : null), [rows]);
  const rfq = useMemo(() => (rows.length ? buildRFQ(rows) : null), [rows]);
  const pick = useMemo(() => (rows.length ? buildPickList(rows) : null), [rows]);

  const counts = useMemo(() => {
    const c = { confirmed: 0, probable: 0, contested: 0, uncertain: 0, unmatched: 0 };
    rows.forEach((r) => { c[r.status]++; });
    return c;
  }, [rows]);

  /* ---- run -------------------------------------------------------------- */
  function run() {
    if (!text.trim()) { setSay("Give me something to read."); return; }
    setJState("scanning");
    setSay(`Reading against ${cat.length} parts…`);
    window.setTimeout(() => {
      const t0 = performance.now();
      const out = identify(text, cat);
      setMs(Math.round((performance.now() - t0) * 10) / 10);
      setRows(out);
      setPanel("none");
      setOpen(null);

      const c = { confirmed: 0, probable: 0, contested: 0, uncertain: 0, unmatched: 0 };
      out.forEach((r) => { c[r.status]++; });
      const eyes = c.probable + c.contested + c.uncertain;
      if (!out.length) { setJState("void"); setSay("Nothing in that text reads as a part request."); return; }
      if (c.unmatched === out.length) { setJState("void"); setSay(`None of these are in the catalogue. ${c.unmatched} flagged for sourcing.`); return; }
      if (eyes) { setJState("ambiguous"); setSay(`${c.confirmed} locked in. ${eyes} I won't guess on — open a row and set me straight.`); }
      else { setJState("confident"); setSay(`${c.confirmed} of ${out.length} lines resolved outright.${c.unmatched ? ` ${c.unmatched} flagged for sourcing.` : ""}`); }
    }, 420);
  }

  /* ---- teach ------------------------------------------------------------ */
  async function teach(row: Row, idx: number) {
    const cand = row.candidates[idx];
    if (!cand) return;
    memory.learn(row.phrase, cand.part.id);
    row.candidates.forEach((o, j) => { if (j !== idx) memory.reject(row.phrase, o.part.id); });
    try {
      await api.jefreyLearn(normalise(row.phrase), cand.part.id, 1);
      await Promise.all(row.candidates.filter((_, j) => j !== idx).map((o) =>
        api.jefreyLearn(normalise(row.phrase), o.part.id, -1)));
    } catch (e) {
      flash("Saved in this session, but couldn't write it to the database: " + String(e));
    }
    setAliasN(memory.size);
    setRows((prev) => prev.map((r) => r !== row ? r : {
      ...r, chosen: idx, status: "confirmed",
      candidates: r.candidates.map((c, j) => j === idx ? { ...c, score: 100, why: "learned from your correction", contested: false } : c),
    }));
    setJState("confident");
    setSay(`Got it. "${row.phrase}" means ${cand.part.sku} from now on — that's saved, not just for today.`);
    flash(`Learned: "${row.phrase}" → ${cand.part.sku}`);
  }

  function pushOrder() {
    const ok = rows.filter((r) => r.status === "confirmed" && r.candidates[r.chosen]);
    const held = rows.length - ok.length;
    const val = ok.reduce((s, r) => s + r.qty * r.candidates[r.chosen].part.list, 0);
    flash(`${ok.length} lines → draft order · ${money(val)}${held ? ` · ${held} held back` : ""}`);
    setSay(held
      ? `Pushed ${ok.length}. Held ${held} — I'm not putting a guess on an invoice.`
      : `Draft order ready. ${ok.length} lines, ${money(val)}.`);
  }

  const copy = (s: string, label: string) =>
    navigator.clipboard.writeText(s).then(() => flash(`${label} copied.`), () => flash("Clipboard blocked."));

  const csv = () => {
    const head = ["Qty", "Customer wording", "SKU", "Part name", "Inventory PN", "Bin", "On hand", "List ZAR", "Confidence", "Status"];
    const body = rows.map((r) => {
      const c = r.candidates[r.chosen];
      return [r.qty, r.phrase, c?.part.sku ?? "", c?.part.name ?? "*** NOT IN CATALOGUE ***",
        c?.part.inv_pn ?? "", c?.part.loc ?? "", c?.part.qty ?? "", c?.part.list ?? "",
        (c?.score ?? 0) + "%", r.status];
    });
    copy([head, ...body].map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n"), "Table");
  };

  if (loading) return <div className="jf-boot">Waking Jefrey…</div>;
  if (err) return <div className="jf-boot jf-err">Jefrey couldn't read the catalogue: {err}</div>;

  return (
    <div className="jf-wrap">
      {/* ---------------- header ---------------- */}
      <div className="jf-hdr">
        <JefreyHead state={jstate} />
        <div className="jf-meta">
          <div className="jf-name">JEFREY <span className="jf-role">parts identification unit</span></div>
          <div className="jf-say">{say}</div>
          <div className="jf-stats">
            <span>{cat.length} parts loaded</span>
            <span className="jf-dot">·</span>
            <span className="jf-learned" title="Corrections Jefrey has been taught — stored in the database">{aliasN} learned aliases</span>
            <span className="jf-dot">·</span>
            <span>local · no network</span>
            {ms > 0 && <><span className="jf-dot">·</span><span>{ms} ms</span></>}
          </div>
        </div>
        <div className="jf-modes">
          {(["identify", "goods", "ask", "audit"] as Mode[]).map((m) => (
            <button key={m} className={"jf-mode" + (mode === m ? " on" : "")} onClick={() => setMode(m)}>
              {m === "identify" ? "Identify" : m === "goods" ? "Goods-in" : m === "ask" ? "Ask" : "Audit"}
              {m === "audit" && audit?.tally.critical ? <b className="jf-badge">{audit.tally.critical}</b> : null}
            </button>
          ))}
        </div>
      </div>

      {/* ---------------- IDENTIFY ---------------- */}
      {mode === "identify" && (
        <>
          <div className="jf-input">
            <textarea
              ref={taRef} value={text} spellCheck={false}
              placeholder="Paste the WhatsApp message, email or order…"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") run(); }}
            />
            <div className="jf-inbtns">
              <button className="jf-go" onClick={run}>Identify parts <span className="jf-kbd">Ctrl ↵</span></button>
              <button className="jf-ghost" onClick={() => { setText(SAMPLE); }}>Sample</button>
              <button className="jf-ghost" onClick={() => { setText(""); setRows([]); setPanel("none"); setJState("idle"); setSay("Cleared."); }}>Clear</button>
            </div>
          </div>

          {rows.length > 0 && (
            <>
              <div className="jf-strip">
                <span className="jf-s"><b>{rows.length}</b> lines</span>
                {counts.confirmed > 0 && <span className="jf-s jf-ok">● <b>{counts.confirmed}</b> confirmed</span>}
                {counts.probable > 0 && <span className="jf-s jf-warn">● <b>{counts.probable}</b> probable</span>}
                {counts.contested > 0 && <span className="jf-s jf-cont">● <b>{counts.contested}</b> contested</span>}
                {counts.uncertain > 0 && <span className="jf-s jf-warn">● <b>{counts.uncertain}</b> uncertain</span>}
                {counts.unmatched > 0 && <span className="jf-s jf-bad">● <b>{counts.unmatched}</b> source</span>}
                <span className="jf-sp" />
                <button className={"jf-act" + (panel === "quote" ? " on" : "")} onClick={() => setPanel(panel === "quote" ? "none" : "quote")}>Quote</button>
                <button className={"jf-act" + (panel === "rfq" ? " on" : "")} onClick={() => setPanel(panel === "rfq" ? "none" : "rfq")}>RFQ</button>
                <button className={"jf-act" + (panel === "pick" ? " on" : "")} onClick={() => setPanel(panel === "pick" ? "none" : "pick")}>Pick list</button>
                <button className={"jf-act" + (panel === "reply" ? " on" : "")} onClick={() => setPanel(panel === "reply" ? "none" : "reply")}>Reply</button>
                <button className="jf-act" onClick={csv}>CSV</button>
                <button className="jf-act jf-primary" onClick={pushOrder}>Push to order →</button>
              </div>

              <table className="jf-tbl">
                <thead><tr>
                  <th className="jf-r">Qty</th><th>What they asked for</th><th>Matched part</th>
                  <th>Inventory PN</th><th>Bin</th><th className="jf-r">Stock</th>
                  <th className="jf-r">List</th><th>Confidence</th>
                </tr></thead>
                <tbody>
                  {rows.map((r) => {
                    const c = r.candidates[r.chosen];
                    const isOpen = open === r.key;
                    return (
                      <Fragment key={r.key}>
                        <tr className={isOpen ? "jf-open" : ""} onClick={() => setOpen(isOpen ? null : r.key)}>
                          <td className="jf-qty">{r.qty}</td>
                          <td className="jf-req">{r.phrase}{r.side && <span className="jf-side">{r.side}</span>}</td>
                          {c ? (
                            <>
                              <td>
                                <div className={"jf-pn-name" + (c.part.flag === "no_name" ? " jf-gap" : "")}>{c.part.name}</div>
                                <div className="jf-sub">{c.part.sku} · {c.part.section}{c.part.side !== "-" ? " · " + c.part.side : ""}</div>
                              </td>
                              <td className="jf-pn">{c.part.inv_pn}
                                {c.part.cat_pn && c.part.cat_pn !== c.part.inv_pn && <small>cat {c.part.cat_pn}</small>}</td>
                              <td className="jf-loc">{c.part.loc || "—"}</td>
                              <td className={"jf-r jf-stk " + (c.part.qty === 0 ? "jf-bad" : c.part.qty <= 3 ? "jf-warn" : "jf-ok")}>{c.part.qty}</td>
                              <td className="jf-r jf-zar">{money(c.part.list)}</td>
                              <td><span className={"jf-chip jf-c-" + r.status}><b>{c.score}%</b> {r.status}</span></td>
                            </>
                          ) : (
                            <>
                              <td colSpan={5} className="jf-bad">Not in the catalogue — needs sourcing from the supplier</td>
                              <td><span className="jf-chip jf-c-unmatched"><b>—</b> source</span></td>
                            </>
                          )}
                        </tr>
                        {isOpen && (
                          <tr className="jf-drawer"><td colSpan={8}>
                            <div className="jf-dr" onClick={(e) => e.stopPropagation()}>
                              <div>
                                <h4>How Jefrey got there</h4>
                                {r.trace.map((t, i) => (
                                  <div className="jf-tr" key={i}><span className="jf-ts">{t.step}</span><span>{t.detail}</span></div>
                                ))}
                                {c && <div className="jf-tr"><span className="jf-ts">verdict</span><span>{c.why}</span></div>}
                                {c && crossRefs(c.part, cat).map((x, i) => (
                                  <div className="jf-tr jf-xref" key={"x" + i}><span className="jf-ts">{x.kind}</span><span>{x.note}</span></div>
                                ))}
                              </div>
                              <div>
                                <h4>{r.candidates.length ? "Pick the right one — Jefrey remembers it for good" : "Nothing to pick from"}</h4>
                                {r.candidates.map((cd, i) => (
                                  <div className={"jf-alt" + (i === r.chosen ? " sel" : "")} key={cd.part.id}>
                                    <span className="jf-altsc">{cd.score}%</span>
                                    <span className="jf-altnm">{cd.part.name}<small>{cd.part.sku} · {cd.part.inv_pn} · {cd.part.qty} on hand</small></span>
                                    <button onClick={() => void teach(r, i)}>{i === r.chosen ? "CURRENT" : "THIS ONE"}</button>
                                  </div>
                                ))}
                              </div>
                            </div>
                          </td></tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>

              {/* ---------------- action panels ---------------- */}
              {panel === "quote" && quote && (
                <div className="jf-panel">
                  <h3>Pro-forma</h3>
                  {quote.negativeLines.length > 0 && (
                    <div className="jf-alert">
                      {quote.negativeLines.length} line{quote.negativeLines.length > 1 ? "s are" : " is"} priced at or below landed cost
                      ({quote.negativeLines.map((l) => l.part.sku).join(", ")}). Quoting this as it stands loses money on every unit.
                    </div>
                  )}
                  <table className="jf-tbl jf-mini">
                    <thead><tr><th className="jf-r">Qty</th><th>Part</th><th className="jf-r">Unit</th><th className="jf-r">Line</th><th className="jf-r">Margin</th><th>Availability</th></tr></thead>
                    <tbody>
                      {quote.lines.map((l) => (
                        <tr key={l.part.id}>
                          <td className="jf-qty">{l.qty}</td>
                          <td>{l.part.name}<div className="jf-sub">{l.part.inv_pn}</div></td>
                          <td className="jf-r jf-zar">{money(l.unit)}</td>
                          <td className="jf-r jf-zar">{money(l.ext)}</td>
                          <td className={"jf-r jf-zar " + (l.negative ? "jf-bad" : l.margin < 0.2 ? "jf-warn" : "jf-ok")}>{(l.margin * 100).toFixed(0)}%</td>
                          <td className="jf-sub">{l.back > 0 ? `${l.avail} now · ${l.back} on ${l.lead}` : l.lead}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="jf-totals">
                    <div><span>Subtotal</span><b>{money(quote.sub)}</b></div>
                    <div><span>VAT 15%</span><b>{money(quote.vat)}</b></div>
                    <div className="jf-grand"><span>Total</span><b>{money(quote.total)}</b></div>
                    <div><span>Gross margin</span><b className={quote.margin < 0.15 ? "jf-bad" : "jf-ok"}>{(quote.margin * 100).toFixed(1)}%</b></div>
                  </div>
                  <div className="jf-assume">{quote.assumptions.map((a, i) => <span key={i}>{a}</span>)}</div>
                </div>
              )}

              {panel === "rfq" && rfq && (
                <div className="jf-panel">
                  <h3>Supplier RFQ <button className="jf-ghost jf-sm" onClick={() => copy(rfq.text, "RFQ")}>Copy</button></h3>
                  <div className="jf-sub jf-mb">{rfq.shortfall} shortfall line(s), {rfq.unknown} unidentified · est. {money(rfq.estCost)} at landed cost</div>
                  {rfq.need.length ? <pre className="jf-pre">{rfq.text}</pre>
                    : <div className="jf-sub">Nothing to source — everything on this request is on the shelf.</div>}
                </div>
              )}

              {panel === "pick" && pick && (
                <div className="jf-panel">
                  <h3>Pick list</h3>
                  <div className="jf-sub jf-mb">Route {pick.route || "—"} · {pick.units} units{pick.shorts.length ? ` · ${pick.shorts.length} short` : ""}</div>
                  <table className="jf-tbl jf-mini">
                    <thead><tr><th>Bin</th><th className="jf-r">Pick</th><th>Part</th><th>Inventory PN</th><th></th></tr></thead>
                    <tbody>
                      {pick.items.map((i) => (
                        <tr key={i.part.id}>
                          <td className="jf-loc"><b>{i.loc.txt}</b></td>
                          <td className="jf-r jf-qty">{i.pick}</td>
                          <td>{i.part.name}</td>
                          <td className="jf-pn">{i.part.inv_pn}</td>
                          <td className="jf-bad">{i.short ? `${i.short} short` : ""}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {panel === "reply" && (
                <div className="jf-panel">
                  <h3>Reply to the customer <button className="jf-ghost jf-sm" onClick={() => copy(draftReply(rows, quote), "Reply")}>Copy</button></h3>
                  <pre className="jf-pre">{draftReply(rows, quote)}</pre>
                </div>
              )}
            </>
          )}
        </>
      )}

      {/* ---------------- GOODS-IN ---------------- */}
      {mode === "goods" && (
        <div className="jf-panel">
          <h3>Goods-in reconciliation</h3>
          <div className="jf-sub jf-mb">
            {rows.length
              ? `Checking against the ${resolved(rows).length} identified line(s) from the Identify tab.`
              : "Identify an order first — that becomes what Jefrey expects the shipment to contain."}
          </div>
          <textarea className="jf-ta2" value={goodsText} spellCheck={false}
            placeholder={"Paste the supplier packing list — one line per part\n2803035B1063-DQ    6\n5103121-H02-G      2"}
            onChange={(e) => setGoodsText(e.target.value)} />
          <div className="jf-inbtns">
            <button className="jf-go" disabled={!rows.length || !goodsText.trim()}
              onClick={() => {
                const exp = resolved(rows).map(({ row, part }) => ({ part, qty: row.qty }));
                const res = reconcile(goodsText, exp, cat);
                setGoods(res);
                const bad = (res.tally.short || 0) + (res.tally.over || 0) + (res.tally.unknown || 0);
                setJState(bad ? "ambiguous" : "confident");
                setSay(bad ? `${bad} discrepanc${bad === 1 ? "y" : "ies"} against what you ordered.` : "Shipment matches the order exactly.");
              }}>Reconcile</button>
          </div>
          {goods && (
            <table className="jf-tbl jf-mini jf-mt">
              <thead><tr><th>Status</th><th>Part</th><th className="jf-r">Ordered</th><th className="jf-r">Received</th><th>Note</th></tr></thead>
              <tbody>
                {goods.findings.map((f: GoodsFinding, i) => (
                  <tr key={i}>
                    <td><span className={"jf-chip jf-g-" + f.sev}>{f.sev}</span></td>
                    <td>{f.part ? <>{f.part.name}<div className="jf-sub">{f.part.sku}</div></> : <span className="jf-sub">—</span>}</td>
                    <td className="jf-r jf-qty">{f.want || "—"}</td>
                    <td className="jf-r jf-qty">{f.got || "—"}</td>
                    <td className="jf-sub">{f.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* ---------------- ASK ---------------- */}
      {mode === "ask" && (
        <div className="jf-panel">
          <h3>Ask Jefrey</h3>
          <input className="jf-q" value={question} placeholder="how many mirrors do we have · what's in bin A1 · which parts are losing money · what still needs a photo"
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && question.trim()) { setAnswer(ask(question, cat)); setJState("confident"); } }} />
          <div className="jf-chips">
            {["stock value", "what's low on stock", "which parts are losing money", "what still needs a photo", "what's in bin A1", "how many mirrors"].map((s) => (
              <button key={s} className="jf-suggest" onClick={() => { setQuestion(s); setAnswer(ask(s, cat)); }}>{s}</button>
            ))}
          </div>
          {answer && (
            <>
              <div className="jf-answer">{answer.answer}</div>
              <div className="jf-sql" title="The rule Jefrey ran — he shows his working rather than asking you to trust him">
                <span>{answer.rule}</span> {answer.sql}
              </div>
              {answer.table && answer.table.length > 0 && (
                <table className="jf-tbl jf-mini jf-mt">
                  <thead><tr><th>Part</th><th>Inventory PN</th><th>Bin</th><th className="jf-r">On hand</th><th className="jf-r">Cost</th><th className="jf-r">List</th></tr></thead>
                  <tbody>
                    {answer.table.slice(0, 60).map((p) => (
                      <tr key={p.id}>
                        <td>{p.name}<div className="jf-sub">{p.sku} · {p.section}</div></td>
                        <td className="jf-pn">{p.inv_pn}</td>
                        <td className="jf-loc">{p.loc || "—"}</td>
                        <td className={"jf-r jf-stk " + (p.qty === 0 ? "jf-bad" : p.qty <= 3 ? "jf-warn" : "jf-ok")}>{p.qty}</td>
                        <td className="jf-r jf-zar">{money(p.cost)}</td>
                        <td className={"jf-r jf-zar " + (p.list > 0 && p.cost >= p.list ? "jf-bad" : "")}>{money(p.list)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {answer.table && answer.table.length > 60 && <div className="jf-sub jf-mt">Showing the first 60 of {answer.table.length}.</div>}
            </>
          )}
        </div>
      )}

      {/* ---------------- AUDIT ---------------- */}
      {mode === "audit" && audit && (
        <div className="jf-panel">
          <h3>Catalogue audit</h3>
          <div className="jf-strip jf-nb">
            <span className="jf-s"><b>{audit.scanned}</b> parts scanned</span>
            {(["critical", "high", "medium", "low"] as const).map((s) => audit.tally[s]
              ? <span key={s} className={"jf-s jf-a-" + s}>● <b>{audit.tally[s]}</b> {s}</span> : null)}
            {audit.exposure > 0 && <span className="jf-s jf-bad">exposure <b>{money(audit.exposure)}</b></span>}
          </div>
          <div className="jf-sub jf-mb">
            Ranked by what costs you money, not by what was easiest to find. Exposure is the loss if every
            below-cost part on the shelf sold at its list price.
          </div>
          <table className="jf-tbl jf-mini">
            <thead><tr><th>Severity</th><th>Issue</th><th>Part</th><th>Detail</th><th className="jf-r">Cost</th></tr></thead>
            <tbody>
              {audit.findings.slice(0, 120).map((f: Finding, i) => (
                <tr key={i}>
                  <td><span className={"jf-chip jf-a-" + f.sev}>{f.sev}</span></td>
                  <td className="jf-pn">{f.code}</td>
                  <td>{f.part ? <>{f.part.name}<div className="jf-sub">{f.part.sku} · {f.part.loc || "no bin"}</div></> : "—"}</td>
                  <td className="jf-sub">{f.detail}</td>
                  <td className="jf-r jf-zar">{f.cost ? money(f.cost) : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {audit.findings.length > 120 && <div className="jf-sub jf-mt">Showing the top 120 of {audit.findings.length}.</div>}
        </div>
      )}

      {toast && <div className="jf-toast">{toast}</div>}
    </div>
  );
}
