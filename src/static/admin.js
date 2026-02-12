/** Admin page behaviors - loaded as external script for strict CSP */

/* Select-on-click: auto-select input contents when clicked */
for (const el of document.querySelectorAll("[data-select-on-click]")) {
  el.addEventListener("click", (e) => e.target.select());
}

/* Nav-select: navigate to selected option value on change */
for (const el of document.querySelectorAll("[data-nav-select]")) {
  el.addEventListener("change", (e) => {
    location.href = e.target.value;
  });
}

/* Multi-booking link builder: track checkbox selection order */
const multiUrl = document.querySelector("[data-multi-booking-url]");
if (multiUrl) {
  const selectedSlugs = [];
  const domain = multiUrl.dataset.domain;
  const placeholder = multiUrl.placeholder;
  for (const cb of document.querySelectorAll("[data-multi-booking-slug]")) {
    cb.addEventListener("change", () => {
      const slug = cb.dataset.multiBookingSlug;
      if (cb.checked) {
        selectedSlugs.push(slug);
      } else {
        const idx = selectedSlugs.indexOf(slug);
        if (idx !== -1) selectedSlugs.splice(idx, 1);
      }
      if (selectedSlugs.length >= 2) {
        multiUrl.value = `https://${domain}/ticket/${selectedSlugs.join("+")}`;
        multiUrl.placeholder = "";
      } else {
        multiUrl.value = "";
        multiUrl.placeholder = placeholder;
      }
    });
  }
}

/* Auto-populate closes_at from event date when closes_at is empty */
const dateInput = document.querySelector('input[name="date"]');
const closesAtInput = document.querySelector('input[name="closes_at"]');
if (dateInput && closesAtInput) {
  dateInput.addEventListener("change", () => {
    if (dateInput.value && !closesAtInput.value) {
      closesAtInput.value = dateInput.value;
    }
  });
}

/* Stripe connection test button */
const btn = document.getElementById("stripe-test-btn");
if (btn) {
  btn.addEventListener("click", async () => {
    const resultDiv = document.getElementById("stripe-test-result");
    btn.disabled = true;
    btn.textContent = "Testing...";
    resultDiv.style.display = "none";
    resultDiv.className = "";
    try {
      const csrfToken = btn
        .closest("form")
        .querySelector('input[name="csrf_token"]').value;
      const res = await fetch("/admin/settings/stripe/test", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `csrf_token=${encodeURIComponent(csrfToken)}`,
      });
      const data = await res.json();
      const lines = [];
      if (data.apiKey.valid) {
        lines.push(`API Key: Valid (${data.apiKey.mode} mode)`);
      } else {
        lines.push(
          `API Key: Invalid${data.apiKey.error ? ` - ${data.apiKey.error}` : ""}`,
        );
      }
      if (data.webhook.configured) {
        lines.push(`Webhook: ${data.webhook.status || "configured"}`);
        lines.push(`URL: ${data.webhook.url}`);
        if (data.webhook.enabledEvents) {
          lines.push(`Events: ${data.webhook.enabledEvents.join(", ")}`);
        }
      } else {
        lines.push(
          `Webhook: Not configured${data.webhook.error ? ` - ${data.webhook.error}` : ""}`,
        );
      }
      resultDiv.textContent = lines.join("\n");
      resultDiv.className = data.ok ? "success" : "error";
      resultDiv.style.display = "block";
      resultDiv.style.whiteSpace = "pre-wrap";
    } catch (e) {
      resultDiv.textContent = `Connection test failed: ${e.message}`;
      resultDiv.className = "error";
      resultDiv.style.display = "block";
    }
    btn.disabled = false;
    btn.textContent = "Test Connection";
  });
}
