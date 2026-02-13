/// <reference lib="dom" />
/** Admin page behaviors - bundled by build-edge.ts for strict CSP */

import { buildEmbedCode } from "#lib/embed.ts";
import { mergeEventFields } from "#lib/event-fields.ts";

/* Select-on-click: auto-select input contents when clicked */
for (const el of document.querySelectorAll<HTMLInputElement>("[data-select-on-click]")) {
  el.addEventListener("click", () => el.select());
}

/* Nav-select: navigate to selected option value on change */
for (const el of document.querySelectorAll<HTMLSelectElement>("[data-nav-select]")) {
  el.addEventListener("change", () => {
    location.href = el.value;
  });
}

/* Multi-booking link builder: track checkbox selection order */
const multiUrl = document.querySelector<HTMLInputElement>("[data-multi-booking-url]");
if (multiUrl) {
  const multiEmbed = document.querySelector<HTMLInputElement>("[data-multi-booking-embed]")!;
  const selectedSlugs: string[] = [];
  const selectedFields: string[] = [];
  const domain = multiUrl.dataset.domain!;
  const urlPlaceholder = multiUrl.placeholder;
  const embedPlaceholder = multiEmbed.placeholder;
  for (const cb of document.querySelectorAll<HTMLInputElement>("[data-multi-booking-slug]")) {
    cb.addEventListener("change", () => {
      const slug = cb.dataset.multiBookingSlug!;
      const fields = cb.dataset.fields ?? "";
      if (cb.checked) {
        selectedSlugs.push(slug);
        selectedFields.push(fields);
      } else {
        const idx = selectedSlugs.indexOf(slug);
        if (idx !== -1) {
          selectedSlugs.splice(idx, 1);
          selectedFields.splice(idx, 1);
        }
      }
      if (selectedSlugs.length >= 2) {
        const url = `https://${domain}/ticket/${selectedSlugs.join("+")}`;
        multiUrl.value = url;
        multiUrl.placeholder = "";
        multiEmbed.value = buildEmbedCode(url, mergeEventFields(selectedFields));
        multiEmbed.placeholder = "";
      } else {
        multiUrl.value = "";
        multiUrl.placeholder = urlPlaceholder;
        multiEmbed.value = "";
        multiEmbed.placeholder = embedPlaceholder;
      }
    });
  }
}

/* Auto-populate closes_at from event date when closes_at is empty */
const dateInput = document.querySelector<HTMLInputElement>('input[name="date"]');
const closesAtInput = document.querySelector<HTMLInputElement>('input[name="closes_at"]');
if (dateInput && closesAtInput) {
  dateInput.addEventListener("change", () => {
    if (dateInput.value && !closesAtInput.value) {
      closesAtInput.value = dateInput.value;
    }
  });
}

/* Stripe connection test button */
const btn = document.getElementById("stripe-test-btn") as HTMLButtonElement | null;
if (btn) {
  btn.addEventListener("click", async () => {
    const resultDiv = document.getElementById("stripe-test-result")!;
    btn.disabled = true;
    btn.textContent = "Testing...";
    resultDiv.style.display = "none";
    resultDiv.className = "";
    try {
      const csrfToken = (btn
        .closest("form")!
        .querySelector('input[name="csrf_token"]') as HTMLInputElement).value;
      const res = await fetch("/admin/settings/stripe/test", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `csrf_token=${encodeURIComponent(csrfToken)}`,
      });
      const data = await res.json();
      const lines: string[] = [];
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
      resultDiv.textContent = `Connection test failed: ${(e as Error).message}`;
      resultDiv.className = "error";
      resultDiv.style.display = "block";
    }
    btn.disabled = false;
    btn.textContent = "Test Connection";
  });
}
