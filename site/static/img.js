// Web-sized photo missing? Fall back to the full photo once.
document.addEventListener("error", (e) => {
  const el = e.target;
  if (el && el.tagName === "IMG" && el.dataset.fallback) {
    const f = el.dataset.fallback;
    delete el.dataset.fallback;
    el.src = f;
  }
}, true);
