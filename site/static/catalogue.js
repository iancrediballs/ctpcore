// Catalogue filters: search text, part of the truck, availability. Reads and
// writes ?q=&cat=&av= so a filtered list can be shared or bookmarked.
(() => {
  const grid = document.getElementById("grid");
  if (!grid) return;
  const cards = [...grid.children];
  const q = document.getElementById("fq");
  const cat = document.getElementById("fcat");
  const form = document.getElementById("filters");
  const count = document.getElementById("count");
  const empty = document.getElementById("empty");

  const params = new URLSearchParams(location.search);
  q.value = params.get("q") ?? "";
  cat.value = params.get("cat") ?? "";
  const av0 = params.get("av") ?? "";
  for (const r of form.elements.av) r.checked = r.value === av0;

  const norm = (s) => s.toLowerCase().replace(/[\s-]+/g, "");
  function apply() {
    const words = q.value.toLowerCase().split(/\s+/).filter(Boolean);
    const c = cat.value;
    const av = form.elements.av.value;
    let shown = 0;
    for (const el of cards) {
      const hay = el.dataset.q;
      const compact = norm(hay);
      const ok = (!c || el.dataset.cat === c)
        && (!av || el.dataset.av === av)
        && words.every((w) => hay.includes(w) || compact.includes(norm(w)));
      el.hidden = !ok;
      if (ok) shown++;
    }
    count.textContent = shown === 1 ? "1 part" : `${shown} parts`;
    empty.hidden = shown !== 0;
    const p = new URLSearchParams();
    if (q.value.trim()) p.set("q", q.value.trim());
    if (c) p.set("cat", c);
    if (av) p.set("av", av);
    history.replaceState(null, "", p.toString() ? `?${p}` : location.pathname);
  }
  form.addEventListener("input", apply);
  form.addEventListener("change", apply);
  apply();
})();

document.addEventListener("error", (e) => {
  const el = e.target;
  if (el && el.tagName === "IMG" && el.dataset.fallback) {
    const f = el.dataset.fallback;
    delete el.dataset.fallback;
    el.src = f;
  }
}, true);
