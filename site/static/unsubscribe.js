// One-click unsubscribe. Needs a button press so link scanners in mail
// systems cannot unsubscribe people by merely opening the link.
(() => {
  const btn = document.getElementById("u-go");
  if (!btn) return;
  const token = new URLSearchParams(location.search).get("t") ?? "";
  const err = document.getElementById("u-err");
  if (!/^[0-9a-f-]{36}$/i.test(token)) {
    document.getElementById("u-ask").hidden = true;
    err.textContent = `This unsubscribe link is incomplete. Email us and we will remove you.`;
    err.hidden = false;
    return;
  }
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    err.hidden = true;
    try {
      const res = await fetch(btn.dataset.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "unsubscribe", token }),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok || !out.ok) throw new Error(out.error === "invalid link" ? "This link is no longer valid. Email us and we will remove you." : "Couldn't unsubscribe you. Try again in a minute.");
      document.getElementById("u-ask").hidden = true;
      document.getElementById("u-done").hidden = false;
    } catch (x) {
      err.textContent = x.message;
      err.hidden = false;
      btn.disabled = false;
    }
  });
})();
