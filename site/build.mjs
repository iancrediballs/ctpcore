// Public website for China Truck Parts (chinatruckparts.co.za).
//
// Zero dependencies: `node build.mjs` writes plain static HTML into dist/.
// The catalogue comes from the `public-catalogue` edge function, which returns
// only whitelisted fields (no cost, no prices, no stock quantities, no POs).
//
//   CATALOGUE_URL   override the edge function URL
//   CATALOGUE_FILE  read a local JSON file instead (same shape), for previews
//
// The build fails rather than publish an empty catalogue.
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const OUT = join(ROOT, "dist");
const BIZ = JSON.parse(readFileSync(join(ROOT, "business.json"), "utf8"));
const FUNCTIONS = "https://hkzmydowyiajkbakxfkj.supabase.co/functions/v1";
const CATALOGUE_URL = process.env.CATALOGUE_URL ?? `${FUNCTIONS}/public-catalogue`;
const SIGNUP_URL = `${FUNCTIONS}/contact-signup`;

// Must match CONSENT_VERSIONS in server/edge/contact-signup/index.ts.
export const CONSENT_VERSION = "2026-11-27";
const CONSENT = {
  email: "Email me about new stock, back-order arrivals and specials from China Truck Parts.",
  whatsapp: "Send me the same updates on WhatsApp.",
};

// ------------------------------------------------------------------ helpers
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const slug = (sku) => sku.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const sideWord = { L: "Left", R: "Right", LH: "Left", RH: "Right" };
const fmtEta = (d) => {
  if (!d) return null;
  const t = new Date(d + "T00:00:00Z");
  return isNaN(t) ? null : t.toLocaleDateString("en-ZA", { month: "long", year: "numeric", timeZone: "UTC" });
};
const AVAIL = {
  in_stock: { label: "In stock", cls: "a-in" },
  back_order: { label: "On back order", cls: "a-bo" },
  ask: { label: "Ask us", cls: "a-ask" },
};
const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(BIZ.maps_query)}`;
const waUrl = (text) => BIZ.whatsapp
  ? `https://wa.me/${BIZ.whatsapp.replace(/[^\d]/g, "")}${text ? `?text=${encodeURIComponent(text)}` : ""}`
  : null;

function write(path, html) {
  const file = join(OUT, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, html);
}

// ------------------------------------------------------------------ data
async function loadCatalogue() {
  let data;
  if (process.env.CATALOGUE_FILE) {
    data = JSON.parse(readFileSync(process.env.CATALOGUE_FILE, "utf8"));
  } else {
    const res = await fetch(CATALOGUE_URL, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`catalogue fetch failed: HTTP ${res.status}`);
    data = await res.json();
  }
  if (!Array.isArray(data.parts) || data.parts.length === 0) throw new Error("catalogue is empty; refusing to publish");
  // Defence in depth: drop anything that is not on the whitelist, whatever the source sent.
  const keep = ["sku", "oem", "name", "description", "make", "model", "side", "category", "availability", "eta", "image", "image_master", "updated_at"];
  const parts = data.parts.map((p) => Object.fromEntries(keep.map((k) => [k, p[k] ?? null])));
  const seen = new Map();
  for (const p of parts) {
    let s = slug(p.sku) || "part";
    while (seen.has(s)) s += "-x";
    seen.set(s, true);
    p.slug = s;
    if (!AVAIL[p.availability]) p.availability = "ask";
  }
  return { parts, generated_at: data.generated_at ?? new Date().toISOString() };
}

// ------------------------------------------------------------------ layout
function page({ path, title, description, body, jsonld, scripts = [], noindex = false }) {
  const url = BIZ.site_url + path;
  const full = path === "/" ? title : `${title} | ${BIZ.trading_name}`;
  return `<!doctype html>
<html lang="en-ZA">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(full)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(url)}">
${noindex ? '<meta name="robots" content="noindex">' : ""}
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(full)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:image" content="${esc(BIZ.site_url)}/brand/ctp_logo_light_v3.webp">
<meta name="theme-color" content="#07090c">
<link rel="icon" href="/brand/icon-192.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;700;800&family=Barlow:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/site.css">
${jsonld ? `<script type="application/ld+json">${JSON.stringify(jsonld).replace(/</g, "\\u003c")}</script>` : ""}
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="top">
  <a class="brand" href="/" aria-label="${esc(BIZ.trading_name)} home"><img src="/brand/ctp_logo_light_v3.webp" alt="${esc(BIZ.trading_name)}" width="200" height="60"></a>
  <nav class="nav" aria-label="Main">
    <a href="/parts/"${path.startsWith("/parts") ? ' aria-current="page"' : ""}>Parts</a>
    <a href="/visit/"${path === "/visit/" ? ' aria-current="page"' : ""}>Visit us</a>
    <a class="nav-signin" href="${esc(BIZ.app_url)}">Sign in</a>
    <a class="btn btn-red btn-sm" href="/join/">Join our list</a>
  </nav>
</header>
<main id="main">
${body}
</main>
<footer class="foot">
  <div class="foot-in">
    <div>
      <img src="/brand/ctp_logo_light_v3.webp" alt="" width="160" height="48" loading="lazy">
      <p>${esc(BIZ.legal_name)}<br>${BIZ.address_lines.map(esc).join("<br>")}</p>
    </div>
    <div>
      <p><a href="mailto:${esc(BIZ.email)}">${esc(BIZ.email)}</a>${BIZ.phone ? `<br><a href="tel:${esc(BIZ.phone.replace(/\s/g, ""))}">${esc(BIZ.phone)}</a>` : ""}</p>
      <p><a href="/parts/">Parts catalogue</a><br><a href="/visit/">Visit us</a><br><a href="/join/">Join our list</a><br><a href="${esc(BIZ.app_url)}">Customer and staff sign-in</a></p>
    </div>
    <div>
      <p><a href="/privacy/">Privacy notice (POPIA)</a><br><a href="/terms/">Website terms and disclaimer</a></p>
      <p class="fine">Prices are not shown online. Ask us for a quote.</p>
    </div>
  </div>
</footer>
${scripts.map((s) => `<script src="${s}" defer></script>`).join("\n")}
</body>
</html>
`;
}

const badge = (p) => {
  const a = AVAIL[p.availability];
  const eta = p.availability === "back_order" ? fmtEta(p.eta) : null;
  return `<span class="avail ${a.cls}">${a.label}${eta ? `<small>Expected ${esc(eta)}</small>` : ""}</span>`;
};

const img = (p, cls, w, h, eager = false) => p.image
  ? `<img class="${cls}" src="${esc(p.image)}"${p.image_master && p.image_master !== p.image ? ` data-fallback="${esc(p.image_master)}"` : ""} alt="${esc(p.name)}" width="${w}" height="${h}"${eager ? "" : ' loading="lazy"'} decoding="async">`
  : `<div class="${cls} noimg" role="img" aria-label="No photo yet"><span>Photo coming</span></div>`;

const fitLine = (p) => [p.make, p.model].filter(Boolean).join(" ");

// ------------------------------------------------------------------ pages
function home({ parts }) {
  const n = { in_stock: 0, back_order: 0 };
  for (const p of parts) if (n[p.availability] != null) n[p.availability]++;
  const cats = new Map();
  for (const p of parts) if (p.category) cats.set(p.category, (cats.get(p.category) ?? 0) + 1);
  const catList = [...cats.entries()].filter(([c]) => c !== "New from Zoho").sort((a, b) => b[1] - a[1]);

  const body = `
<section class="hero">
  <div class="hero-copy">
    <h1>FAW JH6 parts, on the shelf in Ballito.</h1>
    <p class="lede">Cab, body, lighting and trim parts for FAW JH6 trucks. Search by part name or OEM number, see what is in stock, then come in or ask us for a quote.</p>
    <form class="search" action="/parts/" method="get" role="search">
      <label for="q" class="sr">Search parts</label>
      <input id="q" name="q" type="search" placeholder="Bumper, mirror, 8406010…" autocomplete="off">
      <button class="btn btn-red" type="submit">Search parts</button>
    </form>
    <ul class="tally" aria-label="Stock today">
      <li><b>${n.in_stock}</b> parts in stock</li>
      <li><b>${n.back_order}</b> on back order</li>
      <li>JH7 and Sinotruk C7 coming</li>
    </ul>
  </div>
  <div class="hero-art" aria-hidden="true">
    <img src="/brand/truck_line.webp" alt="" width="560" height="480">
  </div>
</section>

<section class="band">
  <div class="wrap">
    <h2>Shop by part of the truck</h2>
    <ul class="cats">
      ${catList.map(([c, k]) => `<li><a href="/parts/?cat=${encodeURIComponent(c)}"><span>${esc(c)}</span><b>${k}</b></a></li>`).join("\n      ")}
    </ul>
    <p><a class="more" href="/parts/">See all ${parts.length} parts</a></p>
  </div>
</section>

<section class="wrap how">
  <h2>How buying works</h2>
  <ol class="steps">
    <li><h3>Find the part</h3><p>Search by name or the OEM number stamped on the old part. Each part shows whether it is in stock or on back order.</p></li>
    <li><h3>Ask for a price</h3><p>We quote every order. Email us${BIZ.whatsapp ? ", WhatsApp us" : ""} or come to the counter with the part number.</p></li>
    <li><h3>Collect in Ballito</h3><p>Pick up from our store in Shakas Head. Account customers order and track quotes in the CTP app.</p></li>
  </ol>
</section>

<section class="join-band">
  <div class="wrap join-in">
    <div>
      <h2>Hear when your parts land</h2>
      <p>Join our list and we will let you know about new stock, back-order arrivals and specials by email or WhatsApp. Leave any time.</p>
    </div>
    <a class="btn btn-red btn-lg" href="/join/">Join our list</a>
  </div>
</section>

${visitBlock()}
`;
  const jsonld = {
    "@context": "https://schema.org",
    "@type": "AutoPartsStore",
    name: BIZ.trading_name,
    legalName: BIZ.legal_name,
    url: BIZ.site_url,
    email: BIZ.email,
    ...(BIZ.phone ? { telephone: BIZ.phone } : {}),
    address: {
      "@type": "PostalAddress",
      streetAddress: BIZ.address_lines[0],
      addressLocality: "Ballito",
      addressRegion: "KwaZulu-Natal",
      postalCode: "4381",
      addressCountry: "ZA",
    },
  };
  return page({
    path: "/",
    title: "China Truck Parts | FAW JH6 truck parts in Ballito, KZN",
    description: `FAW JH6 truck parts in stock at Shakas Head, Ballito. ${n.in_stock} parts on the shelf. Search by name or OEM number and ask for a quote.`,
    body,
    jsonld,
  });
}

function visitBlock() {
  return `<section class="wrap visit" id="visit">
  <h2>Visit the store</h2>
  <div class="visit-grid">
    <address>
      <strong>${esc(BIZ.trading_name)}</strong><br>
      ${BIZ.address_lines.map(esc).join("<br>\n      ")}
    </address>
    <div>
      ${BIZ.hours ? `<p><strong>Hours</strong><br>${esc(BIZ.hours)}</p>` : ""}
      <p><strong>Contact</strong><br><a href="mailto:${esc(BIZ.email)}">${esc(BIZ.email)}</a>${BIZ.phone ? `<br><a href="tel:${esc(BIZ.phone.replace(/\s/g, ""))}">${esc(BIZ.phone)}</a>` : ""}</p>
      <p class="visit-acts"><a class="btn btn-ghost" href="${esc(mapsUrl)}" target="_blank" rel="noopener">Directions in Google Maps</a>${waUrl() ? ` <a class="btn btn-wa" href="${esc(waUrl())}" target="_blank" rel="noopener">WhatsApp us</a>` : ""}</p>
    </div>
  </div>
</section>`;
}

function catalogue({ parts }) {
  const cats = [...new Set(parts.map((p) => p.category).filter(Boolean))].sort();
  const body = `
<section class="wrap cat-head">
  <h1>Parts catalogue</h1>
  <p class="lede">${parts.length} FAW JH6 parts. Prices are not shown online: <a href="/join/">ask us for a quote</a>.</p>
  <form class="filters" id="filters" role="search" onsubmit="return false">
    <label class="f-q"><span class="sr">Search</span><input id="fq" name="q" type="search" placeholder="Search name, OEM or part number" autocomplete="off"></label>
    <label class="f-cat"><span class="sr">Part of the truck</span>
      <select id="fcat" name="cat"><option value="">All parts of the truck</option>${cats.map((c) => `<option>${esc(c)}</option>`).join("")}</select>
    </label>
    <fieldset class="f-av"><legend class="sr">Availability</legend>
      <label><input type="radio" name="av" value="" checked> All</label>
      <label><input type="radio" name="av" value="in_stock"> In stock</label>
      <label><input type="radio" name="av" value="back_order"> On back order</label>
    </fieldset>
  </form>
  <p class="count" id="count" aria-live="polite">${parts.length} parts</p>
</section>
<section class="wrap">
  <ul class="grid" id="grid">
    ${parts.map((p) => `<li class="card" data-q="${esc([p.name, p.sku, p.oem, p.category, p.description].filter(Boolean).join(" ").toLowerCase())}" data-cat="${esc(p.category ?? "")}" data-av="${p.availability}">
      <a href="/parts/${p.slug}/">
        ${img(p, "card-img", 300, 300)}
        <span class="card-body">
          <span class="card-name">${esc(p.name)}</span>
          <span class="card-pn">${esc(p.oem || p.sku)}</span>
          ${badge(p)}
        </span>
      </a>
    </li>`).join("\n    ")}
  </ul>
  <div class="empty" id="empty" hidden>
    <p>No parts match that search. Try the OEM number from the old part, or <a href="/join/">tell us what you need</a> and we will look for it.</p>
  </div>
</section>`;
  return page({
    path: "/parts/",
    title: "FAW JH6 parts catalogue",
    description: `Browse ${parts.length} FAW JH6 truck parts: bumpers, doors, mirrors, lights, deflectors and more. See what is in stock in Ballito.`,
    body,
    scripts: ["/catalogue.js"],
  });
}

function partPage(p, related) {
  const fit = fitLine(p);
  const ask = `I'm asking about ${p.name} (${p.oem || p.sku}).`;
  const facts = [
    ["OEM number", p.oem],
    ["Our part number", p.sku !== p.oem ? p.sku : null],
    ["Fits", fit || null],
    ["Side", sideWord[p.side] ?? p.side],
    ["Part of the truck", p.category],
  ].filter(([, v]) => v);
  const body = `
<nav class="wrap crumbs" aria-label="Breadcrumb"><a href="/parts/">Parts</a>${p.category ? ` / <a href="/parts/?cat=${encodeURIComponent(p.category)}">${esc(p.category)}</a>` : ""}</nav>
<article class="wrap part">
  <div class="part-media">${img(p, "part-img", 600, 600, true)}</div>
  <div class="part-info">
    <h1>${esc(p.name)}</h1>
    ${badge(p)}
    ${p.description ? `<p class="lede">${esc(p.description)}</p>` : ""}
    <dl class="facts">
      ${facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("\n      ")}
    </dl>
    <div class="part-acts">
      <a class="btn btn-red btn-lg" href="/join/?part=${encodeURIComponent(p.sku)}">Ask for a price</a>
      ${waUrl(ask) ? `<a class="btn btn-wa btn-lg" href="${esc(waUrl(ask))}" target="_blank" rel="noopener">WhatsApp us</a>` : `<a class="btn btn-ghost btn-lg" href="mailto:${esc(BIZ.email)}?subject=${encodeURIComponent("Price: " + (p.oem || p.sku))}&body=${encodeURIComponent(ask)}">Email us</a>`}
    </div>
    <p class="fine">Check the OEM number against your old part before you buy. Availability changes during the day; ask us to confirm.</p>
  </div>
</article>
${related.length ? `<section class="wrap related">
  <h2>More ${esc(p.category)} parts</h2>
  <ul class="grid grid-sm">
    ${related.map((r) => `<li class="card"><a href="/parts/${r.slug}/">${img(r, "card-img", 300, 300)}<span class="card-body"><span class="card-name">${esc(r.name)}</span><span class="card-pn">${esc(r.oem || r.sku)}</span>${badge(r)}</span></a></li>`).join("\n    ")}
  </ul>
</section>` : ""}`;
  const jsonld = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: p.name,
    sku: p.sku,
    ...(p.oem ? { mpn: p.oem } : {}),
    ...(p.make ? { brand: { "@type": "Brand", name: p.make } } : {}),
    ...(p.image ? { image: p.image_master || p.image } : {}),
    ...(p.description ? { description: p.description } : {}),
    category: p.category ?? undefined,
  };
  return page({
    path: `/parts/${p.slug}/`,
    title: `${p.name} ${p.oem ? `(${p.oem})` : ""} for ${fit || "FAW"}`.replace(/\s+/g, " ").trim(),
    description: `${p.name}${p.oem ? `, OEM ${p.oem}` : ""}${fit ? `, fits ${fit}` : ""}. ${AVAIL[p.availability].label} at China Truck Parts, Ballito.`,
    body,
    jsonld,
    scripts: ["/img.js"],
  });
}

function joinPage() {
  const body = `
<section class="wrap narrow">
  <h1>Join our list</h1>
  <p class="lede">Tell us who you are and what you drive. We will let you know when parts land and answer any price questions. No account or password needed.</p>
  <form class="join" id="join" novalidate data-endpoint="${esc(SIGNUP_URL)}" data-version="${CONSENT_VERSION}">
    <div class="row">
      <label for="j-name">Name</label>
      <input id="j-name" name="name" required minlength="2" maxlength="120" autocomplete="name">
    </div>
    <div class="row two">
      <div>
        <label for="j-email">Email</label>
        <input id="j-email" name="email" type="email" maxlength="200" autocomplete="email">
      </div>
      <div>
        <label for="j-phone">Mobile number</label>
        <input id="j-phone" name="phone" type="tel" maxlength="30" autocomplete="tel" placeholder="082 123 4567">
      </div>
    </div>
    <p class="hint">Give us an email address, a mobile number, or both.</p>
    <div class="row">
      <label for="j-company">Company <span class="opt">(optional)</span></label>
      <input id="j-company" name="company" maxlength="120" autocomplete="organization">
    </div>
    <fieldset class="row">
      <legend>Which trucks do you run? <span class="opt">(optional)</span></legend>
      <div class="chips">
        ${["FAW JH6", "FAW JH7", "Sinotruk C7", "Other"].map((m) => `<label class="chip"><input type="checkbox" name="models" value="${m}"> ${m}</label>`).join("\n        ")}
      </div>
    </fieldset>
    <div class="row">
      <label for="j-interest">Parts you are looking for <span class="opt">(optional)</span></label>
      <textarea id="j-interest" name="interest" rows="3" maxlength="1000"></textarea>
    </div>
    <div class="row">
      <label for="j-heard">How did you hear about us? <span class="opt">(optional)</span></label>
      <input id="j-heard" name="heard_from" maxlength="120">
    </div>
    <div class="hp" aria-hidden="true"><label>Website <input name="website" tabindex="-1" autocomplete="off"></label></div>

    <fieldset class="row consent">
      <legend>How may we contact you with updates?</legend>
      <label class="tick"><input type="checkbox" name="consent_email"> <span>${esc(CONSENT.email)}</span></label>
      <label class="tick"><input type="checkbox" name="consent_whatsapp"> <span>${esc(CONSENT.whatsapp)}</span></label>
      <p class="hint">Both are optional. We will still reply to anything you ask us. You can leave the list at any time with the link in every message, or by emailing <a href="mailto:${esc(BIZ.email)}">${esc(BIZ.email)}</a>.</p>
    </fieldset>
    <label class="tick req"><input type="checkbox" name="privacy_ack" required> <span>I have read the <a href="/privacy/" target="_blank">privacy notice</a> and agree that China Truck Parts may keep these details to answer me.</span></label>

    <p class="form-err" id="j-err" role="alert" hidden></p>
    <button class="btn btn-red btn-lg" type="submit">Join the list</button>
  </form>
  <div class="done" id="j-done" hidden tabindex="-1">
    <h2>You're on the list</h2>
    <p>Thanks. We have your details and will be in touch. If you asked about a part, we will reply with a price.</p>
    <p><a class="btn btn-ghost" href="/parts/">Back to the parts catalogue</a></p>
  </div>
</section>`;
  return page({
    path: "/join/",
    title: "Join our list",
    description: "Get email or WhatsApp updates from China Truck Parts when FAW parts land, and ask for a price.",
    body,
    scripts: ["/join.js"],
  });
}

function visitPage() {
  return page({
    path: "/visit/",
    title: "Visit us in Shakas Head, Ballito",
    description: `China Truck Parts, ${BIZ.address_lines.join(", ")}. Directions and contact details.`,
    body: visitBlock(),
  });
}

function unsubscribePage() {
  const body = `
<section class="wrap narrow">
  <h1>Leave our list</h1>
  <div id="u-ask">
    <p class="lede">Press the button to stop all email and WhatsApp updates from China Truck Parts.</p>
    <p><button class="btn btn-red btn-lg" id="u-go" data-endpoint="${esc(SIGNUP_URL)}">Unsubscribe me</button></p>
  </div>
  <p class="form-err" id="u-err" role="alert" hidden></p>
  <div id="u-done" hidden><p class="lede">Done. You will not get any more updates from us. If you change your mind, <a href="/join/">join again</a>.</p></div>
</section>`;
  return page({ path: "/unsubscribe/", title: "Leave our list", description: "Unsubscribe from China Truck Parts updates.", body, scripts: ["/unsubscribe.js"], noindex: true });
}

function privacyPage() {
  const body = `
<article class="wrap prose">
  <h1>Privacy notice</h1>
  <p class="fine">Version ${CONSENT_VERSION}. This notice explains how ${esc(BIZ.legal_name)} handles personal information under the Protection of Personal Information Act 4 of 2013 (POPIA).</p>

  <h2>Who is responsible</h2>
  <p>The responsible party is ${esc(BIZ.legal_name)}, ${esc(BIZ.address_lines.join(", "))}, ${esc(BIZ.country)}.</p>
  <p>We have not appointed a separate information officer. Under POPIA and the Promotion of Access to Information Act (PAIA), the head of our business acts as information officer. Contact them at <a href="mailto:${esc(BIZ.email)}">${esc(BIZ.email)}</a> for anything in this notice.</p>

  <h2>What we collect</h2>
  <ul>
    <li><strong>When you join our list:</strong> your name, email address and/or mobile number, and if you choose to give them, your company, the trucks you run, the parts you are looking for and how you heard about us.</li>
    <li><strong>Your contact choices:</strong> whether you agreed to email and/or WhatsApp updates, the wording you agreed to, and when.</li>
    <li><strong>Abuse protection:</strong> a one-way scrambled code made from your internet address, used only to limit repeated sign-ups. We do not store the address itself.</li>
    <li><strong>Account customers</strong> who sign in to the CTP app: the details needed to run your account, quotes and orders.</li>
  </ul>
  <p>This website does not use advertising or tracking cookies.</p>

  <h2>Why we use it</h2>
  <ul>
    <li>To answer your questions and quote for parts (with your agreement, and to take steps you ask for).</li>
    <li>To send you updates about stock, back-order arrivals and specials, <strong>only</strong> on the channels you ticked (email, WhatsApp). This is direct marketing under section 69 of POPIA, and we only do it with your consent.</li>
    <li>To keep a record of your consent and of any request to stop, so that we respect it.</li>
  </ul>

  <h2>Stopping updates</h2>
  <p>Every update has a one-step unsubscribe link. You can also email <a href="mailto:${esc(BIZ.email)}">${esc(BIZ.email)}</a>${BIZ.whatsapp ? " or reply STOP on WhatsApp" : ""}. We stop straight away and keep only a note that you opted out, so that we do not contact you again.</p>

  <h2>Who else handles your information</h2>
  <p>We do not sell or rent your information. These service providers process it for us, under contract, and only to run our systems:</p>
  <ul>
    <li><strong>Supabase</strong>: our database, hosted in Frankfurt, Germany (European Union).</li>
    <li><strong>Vercel</strong>: hosts this website.</li>
    <li><strong>Our email delivery provider</strong>: sends our emails.</li>
    <li><strong>WhatsApp (Meta)</strong>: if you agreed to WhatsApp updates.</li>
    <li><strong>Zoho Books</strong>: our accounting system, for account customers.</li>
  </ul>
  <p>Some of these providers store or process information outside South Africa. Under section 72 of POPIA we only use providers bound by laws or agreements that protect personal information at least as well as POPIA does, such as the EU's General Data Protection Regulation.</p>

  <h2>How long we keep it</h2>
  <p>We keep your details while you are on our list or an active customer. If you leave the list we keep only the opt-out record. If you ask us to delete your details, we do so unless the law requires us to keep them (for example tax records for account customers).</p>

  <h2>How we protect it</h2>
  <p>Access is limited to our sales and management staff, through individual logins. The database enforces who may see what, and all traffic is encrypted.</p>

  <h2>Your rights</h2>
  <ul>
    <li>Ask what information we hold about you, and get a copy.</li>
    <li>Ask us to correct or delete it.</li>
    <li>Object to us using it, including for direct marketing, at any time.</li>
    <li>Withdraw your consent at any time. This does not affect what we did before.</li>
    <li>Complain to the Information Regulator at <a href="https://inforegulator.org.za" target="_blank" rel="noopener">inforegulator.org.za</a> if you believe we have not handled your information properly. We would like the chance to fix it first, so please contact us too.</li>
  </ul>

  <h2>Children</h2>
  <p>This website is meant for adults buying truck parts. We do not knowingly collect information about anyone under 18.</p>

  <h2>Changes</h2>
  <p>If we change this notice we will publish the new version here with a new date. If a change affects what you agreed to, we will ask you again.</p>
</article>`;
  return page({ path: "/privacy/", title: "Privacy notice (POPIA)", description: "How China Truck Parts collects, uses and protects personal information under POPIA.", body });
}

function termsPage() {
  const body = `
<article class="wrap prose">
  <h1>Website terms and disclaimer</h1>
  <p class="fine">Version ${CONSENT_VERSION}. These terms apply to chinatruckparts.co.za, run by ${esc(BIZ.legal_name)}.</p>

  <h2>Catalogue information</h2>
  <p>Part names, numbers, photos and fitment shown here are for guidance. Photos may show a similar part, and trucks can differ by year and specification. Always check the OEM number against your old part, or ask us to confirm fitment, before you buy.</p>

  <h2>Availability</h2>
  <p>"In stock" and "On back order" are updated from our stock system regularly, but stock can change during the day. Back-order dates are the supplier's expected dates and can move. Availability is confirmed only when we quote.</p>

  <h2>Prices and orders</h2>
  <p>We do not show prices online. Every order is quoted, and a quote is only binding once we confirm it in writing. Nothing on this website is an offer to sell at a particular price.</p>

  <h2>Your rights as a consumer</h2>
  <p>Nothing in these terms limits any right you have under the Consumer Protection Act 68 of 2008 or other South African law, including your rights to safe, good-quality goods. Where the law allows, we are not liable for loss caused by relying on catalogue information without confirming it with us.</p>

  <h2>Trade marks</h2>
  <p>FAW, JH6, JH7, Sinotruk and C7 are trade marks of their owners. We use them only to describe which trucks a part fits. China Truck Parts is not the manufacturer of these trucks.</p>

  <h2>Personal information</h2>
  <p>See our <a href="/privacy/">privacy notice</a>.</p>

  <h2>Contact</h2>
  <p>${esc(BIZ.legal_name)}, ${esc(BIZ.address_lines.join(", "))}. <a href="mailto:${esc(BIZ.email)}">${esc(BIZ.email)}</a>.</p>
  <p>These terms are governed by South African law.</p>
</article>`;
  return page({ path: "/terms/", title: "Website terms and disclaimer", description: "Terms of use and disclaimer for the China Truck Parts website.", body });
}

function notFound() {
  return page({
    path: "/404",
    title: "Page not found",
    description: "That page does not exist.",
    noindex: true,
    body: `<section class="wrap narrow"><h1>That page isn't here</h1><p class="lede">The part may have moved. <a href="/parts/">Search the catalogue</a> or <a href="/">go to the home page</a>.</p></section>`,
  });
}

// ------------------------------------------------------------------ build
async function main() {
  const cat = await loadCatalogue();
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  cpSync(join(ROOT, "static"), OUT, { recursive: true });

  write("index.html", home(cat));
  write("parts/index.html", catalogue(cat));
  const byCat = new Map();
  for (const p of cat.parts) {
    if (!byCat.has(p.category)) byCat.set(p.category, []);
    byCat.get(p.category).push(p);
  }
  for (const p of cat.parts) {
    const related = (byCat.get(p.category) ?? []).filter((r) => r !== p && p.category).slice(0, 4);
    write(`parts/${p.slug}/index.html`, partPage(p, related));
  }
  write("join/index.html", joinPage());
  write("visit/index.html", visitPage());
  write("privacy/index.html", privacyPage());
  write("terms/index.html", termsPage());
  write("unsubscribe/index.html", unsubscribePage());
  write("404.html", notFound());

  const urls = ["/", "/parts/", "/join/", "/visit/", "/privacy/", "/terms/", ...cat.parts.map((p) => `/parts/${p.slug}/`)];
  const lastmod = new Map(cat.parts.map((p) => [`/parts/${p.slug}/`, (p.updated_at ?? "").slice(0, 10)]));
  write("sitemap.xml", `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${BIZ.site_url}${u}</loc>${lastmod.get(u) ? `<lastmod>${lastmod.get(u)}</lastmod>` : ""}</url>`).join("\n")}
</urlset>
`);
  write("robots.txt", `User-agent: *\nAllow: /\nDisallow: /unsubscribe/\nSitemap: ${BIZ.site_url}/sitemap.xml\n`);
  console.log(`built ${urls.length} pages from ${cat.parts.length} parts (catalogue ${cat.generated_at})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
