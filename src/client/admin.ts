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

/* Stripe checkout popup: opens Stripe in a new window when embedded in an iframe */
const checkoutPopup = document.querySelector<HTMLElement>("[data-checkout-popup]");
if (checkoutPopup) {
  const checkoutUrl = checkoutPopup.dataset.checkoutPopup!;
  const waitingEl = checkoutPopup.querySelector<HTMLElement>("[data-checkout-waiting]")!;
  const resultEl = checkoutPopup.querySelector<HTMLElement>("[data-checkout-result]")!;
  const openLink = checkoutPopup.querySelector<HTMLAnchorElement>("[data-open-checkout]")!;
  let popup: Window | null = null;

  const showResult = (html: string) => {
    waitingEl.hidden = true;
    resultEl.innerHTML = html;
    resultEl.hidden = false;
  };

  // Listen for postMessage from the popup success/cancel page
  window.addEventListener("message", (e) => {
    if (e.origin !== location.origin) return;
    if (e.data?.type === "payment-success") {
      showResult('<div class="success"><p>Payment successful! Your ticket has been confirmed.</p></div>');
    } else if (e.data?.type === "payment-cancel") {
      showResult(
        `<p>Payment was cancelled.</p><p><a href="${checkoutUrl}" target="_blank" rel="noopener">Try again</a></p>`,
      );
    }
  });

  // Track popup and detect when it closes without completing
  const pollPopup = () => {
    if (!popup || popup.closed) {
      // Only show closed message if no result was already shown
      if (resultEl.hidden) {
        waitingEl.hidden = true;
        openLink.parentElement!.hidden = false;
      }
      return;
    }
    setTimeout(pollPopup, 500);
  };

  openLink.addEventListener("click", (e) => {
    e.preventDefault();
    popup = window.open(checkoutUrl, "_blank", "noopener=no");
    if (popup) {
      openLink.parentElement!.hidden = true;
      waitingEl.hidden = false;
      pollPopup();
    }
    // If popup blocked, the link href+target="_blank" serves as fallback
  });
}

/* Payment result pages: notify opener iframe via postMessage when in a popup */
const paymentResult = document.querySelector<HTMLElement>("[data-payment-result]");
if (paymentResult && window.opener) {
  const result = paymentResult.dataset.paymentResult;
  try {
    window.opener.postMessage(
      { type: result === "success" ? "payment-success" : "payment-cancel" },
      location.origin,
    );
  } catch {
    // opener may be cross-origin or closed
  }
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
