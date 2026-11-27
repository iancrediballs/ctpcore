// Join-our-list form -> contact-signup edge function. No login, no cookies.
(() => {
  const form = document.getElementById("join");
  if (!form) return;
  const err = document.getElementById("j-err");
  const done = document.getElementById("j-done");
  const startedAt = Date.now();

  // Arrived from a part page: put the part in the "looking for" box.
  const part = new URLSearchParams(location.search).get("part");
  if (part && !form.interest.value) form.interest.value = `Price for part ${part.slice(0, 60)}`;

  const show = (msg) => { err.textContent = msg; err.hidden = false; err.scrollIntoView({ block: "center" }); };

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    err.hidden = true;
    const f = form.elements;
    const email = f.email.value.trim();
    const phone = f.phone.value.trim();
    if (f.name.value.trim().length < 2) return show("Please enter your name.");
    if (!email && !phone) return show("Please give an email address or a mobile number.");
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return show("That email address doesn't look right.");
    if (f.consent_email.checked && !email) return show("Add an email address to get email updates.");
    if (f.consent_whatsapp.checked && !phone) return show("Add a mobile number to get WhatsApp updates.");
    if (!f.privacy_ack.checked) return show("Please confirm you have read the privacy notice.");

    const btn = form.querySelector("button[type=submit]");
    btn.disabled = true;
    btn.textContent = "Joining…";
    try {
      const res = await fetch(form.dataset.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "signup",
          name: f.name.value,
          email,
          phone,
          company: f.company.value,
          models: [...form.querySelectorAll("input[name=models]:checked")].map((i) => i.value),
          interest: f.interest.value,
          heard_from: f.heard_from.value,
          website: f.website.value,
          consent_email: f.consent_email.checked,
          consent_whatsapp: f.consent_whatsapp.checked,
          privacy_ack: f.privacy_ack.checked,
          consent_text_version: form.dataset.version,
          started_at: startedAt,
        }),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok || !out.ok) throw new Error(out.error || "Couldn't send your details. Check your connection and try again.");
      form.hidden = true;
      done.hidden = false;
      done.focus();
    } catch (x) {
      show(x.message);
      btn.disabled = false;
      btn.textContent = "Join the list";
    }
  });
})();
