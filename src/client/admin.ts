/// <reference lib="dom" />
/** Admin page behaviors - bundled by build-edge.ts for strict CSP */

import { buildEmbedSnippets } from "#lib/embed.ts";

/** POST a form-encoded body with a CSRF token, return parsed JSON. */
const csrfPost = async (
  url: string,
  csrfToken: string,
  extraBody = "",
  // deno-lint-ignore no-explicit-any
): Promise<any> => {
  const body = `csrf_token=${encodeURIComponent(csrfToken)}${extraBody}`;
  const res = await fetch(url, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  return res.json();
};

/* Select-on-click: auto-select input contents when clicked */
for (const el of document.querySelectorAll<HTMLInputElement>(
  "[data-select-on-click]",
)) {
  el.addEventListener("click", () => el.select());
}

/* Nav-select: navigate to selected option value on change */
for (const el of document.querySelectorAll<HTMLSelectElement>(
  "[data-nav-select]",
)) {
  el.addEventListener("change", () => {
    location.href = el.value;
  });
}

/* Multi-booking link builder: track checkbox selection order */
const multiUrl = document.querySelector<HTMLInputElement>(
  "[data-multi-booking-url]",
);
if (multiUrl) {
  const multiEmbedScript = document.querySelector<HTMLInputElement>(
    "[data-multi-booking-embed-script]",
  )!;
  const multiEmbedIframe = document.querySelector<HTMLInputElement>(
    "[data-multi-booking-embed-iframe]",
  )!;
  const selectedSlugs: string[] = [];
  const domain = multiUrl.dataset.domain!;
  const urlPlaceholder = multiUrl.placeholder;
  const embedScriptPlaceholder = multiEmbedScript.placeholder;
  const embedIframePlaceholder = multiEmbedIframe.placeholder;
  for (const cb of document.querySelectorAll<HTMLInputElement>(
    "[data-multi-booking-slug]",
  )) {
    cb.addEventListener("change", () => {
      const slug = cb.dataset.multiBookingSlug!;
      if (cb.checked) {
        selectedSlugs.push(slug);
      } else {
        const idx = selectedSlugs.indexOf(slug);
        if (idx !== -1) {
          selectedSlugs.splice(idx, 1);
        }
      }
      if (selectedSlugs.length >= 2) {
        const url = `https://${domain}/ticket/${selectedSlugs.join("+")}`;
        multiUrl.value = url;
        multiUrl.placeholder = "";
        const { script, iframe } = buildEmbedSnippets(url);
        multiEmbedScript.value = script;
        multiEmbedIframe.value = iframe;
        multiEmbedScript.placeholder = "";
        multiEmbedIframe.placeholder = "";
      } else {
        multiUrl.value = "";
        multiUrl.placeholder = urlPlaceholder;
        multiEmbedScript.value = "";
        multiEmbedIframe.value = "";
        multiEmbedScript.placeholder = embedScriptPlaceholder;
        multiEmbedIframe.placeholder = embedIframePlaceholder;
      }
    });
  }
}

/* Find in page: trigger browser's native find dialog via window.find() */
const findLink = document.querySelector<HTMLAnchorElement>(
  "[data-find-in-page]",
);
if (findLink) {
  findLink.addEventListener("click", (e) => {
    e.preventDefault();
    (window as unknown as { find?: () => void }).find?.();
  });
}

/* Fill default template: clicking "Edit default template" fills the textarea */
for (const link of document.querySelectorAll<HTMLAnchorElement>(
  "[data-fill-default]",
)) {
  link.addEventListener("click", (e) => {
    e.preventDefault();
    const ta = document.getElementById(
      link.dataset.fillDefault!,
    ) as HTMLTextAreaElement | null;
    if (ta && !ta.value) {
      ta.value = ta.dataset.defaultTpl ?? "";
      ta.focus();
    }
  });
}

/* Auto-populate closes_at from event date when closes_at is empty */
const dateInput =
  document.querySelector<HTMLInputElement>('input[name="date"]');
const closesAtInput = document.querySelector<HTMLInputElement>(
  'input[name="closes_at"]',
);
if (dateInput && closesAtInput) {
  dateInput.addEventListener("change", () => {
    if (dateInput.value && !closesAtInput.value) {
      closesAtInput.value = dateInput.value;
    }
  });
}

/* Scroll parent page so the iframe is visible on checkout and success pages.
 * parentIframe is created synchronously by iframe-resizer-child (loaded before
 * this deferred script) and buffers calls until the parent handshake completes.
 * scrollToOffset(0, 0) scrolls the parent to the iframe's top-left corner. */
if (document.querySelector("[data-scroll-into-view]")) {
  const { parentIframe } = window as unknown as {
    parentIframe?: { scrollToOffset: (x: number, y: number) => void };
  };
  parentIframe?.scrollToOffset(0, 0);
}

/* Stripe checkout popup: opens Stripe in a new window when embedded in an iframe.
 * No-JS fallback: the Pay Now link has target="_blank" and works as a plain link. */
const checkoutPopup = document.querySelector<HTMLElement>(
  "[data-checkout-popup]",
);
if (checkoutPopup) {
  const checkoutUrl = checkoutPopup.dataset.checkoutPopup!;
  const waitingEl = checkoutPopup.querySelector<HTMLElement>(
    "[data-checkout-waiting]",
  )!;
  const openLink = checkoutPopup.querySelector<HTMLAnchorElement>(
    "[data-open-checkout]",
  )!;
  let popup: Window | null = null;

  const showPayButton = () => {
    waitingEl.hidden = true;
    openLink.parentElement!.hidden = false;
  };

  // Listen for postMessage from the popup success/cancel page
  window.addEventListener("message", (e) => {
    if (e.origin !== location.origin) return;
    if (e.data?.type === "payment-success") {
      // Navigate the iframe to the real success page — single code path
      location.href = "/ticket/reserved";
    } else if (e.data?.type === "payment-cancel") {
      showPayButton();
    }
  });

  // Track popup and detect when it closes without completing
  const pollPopup = () => {
    if (!popup || popup.closed) {
      showPayButton();
      return;
    }
    setTimeout(pollPopup, 500);
  };

  openLink.addEventListener("click", (e) => {
    // Open without noopener so the popup can access window.opener for postMessage
    const w = window.open(checkoutUrl, "_blank");
    if (w) {
      e.preventDefault();
      popup = w;
      openLink.parentElement!.hidden = true;
      waitingEl.hidden = false;
      pollPopup();
    }
    // If popup blocked (w is null), default link action fires — graceful fallback
  });
}

/* Scroll-hide nav: hide sticky main nav on scroll down, show on scroll up or at top */
{
  const nav = document.querySelector<HTMLElement>("#main-nav");
  if (nav) {
    if (location.hash) {
      nav.classList.add("nav-no-transition", "nav-hidden");
      requestAnimationFrame(() => {
        nav.classList.remove("nav-no-transition");
      });
    }
    let lastY = scrollY;
    let ticking = false;
    document.addEventListener(
      "scroll",
      () => {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(() => {
          const y = scrollY;
          nav.classList.toggle("nav-hidden", y > 0 && y > lastY);
          lastY = y;
          ticking = false;
        });
      },
      { passive: true },
    );
  }
}

/* Payment result pages: notify opener iframe via postMessage when in a popup */
const paymentResult = document.querySelector<HTMLElement>(
  "[data-payment-result]",
);
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

/** Wire up a payment provider "Test Connection" button.
 * @param btnId - button element ID
 * @param resultId - result div element ID
 * @param url - POST endpoint to test
 * @param cssClass - CSS class for result formatting
 * @param formatLines - extract display lines from JSON response
 */

const setupTestButton = (
  btnId: string,
  resultId: string,
  url: string,
  cssClass: string,
  // deno-lint-ignore no-explicit-any
  formatLines: (data: any) => string[],
) => {
  const button = document.getElementById(btnId);
  if (!(button instanceof HTMLButtonElement)) return;
  button.addEventListener("click", async () => {
    const resultDiv = document.getElementById(resultId)!;
    button.disabled = true;
    button.textContent = "Testing...";
    resultDiv.classList.add("hidden");
    resultDiv.classList.remove("success", "error");
    try {
      const csrfInput = button
        .closest("form")
        ?.querySelector<HTMLInputElement>('input[name="csrf_token"]');
      const data = await csrfPost(url, csrfInput?.value ?? "");
      resultDiv.textContent = formatLines(data).join("\n");
      resultDiv.classList.remove("hidden", "success", "error");
      resultDiv.classList.add(data.ok ? "success" : "error", cssClass);
    } catch (e) {
      resultDiv.textContent = `Connection test failed: ${e instanceof Error ? e.message : "Unknown error"}`;
      resultDiv.classList.remove("hidden", "success", "error");
      resultDiv.classList.add("error", cssClass);
    }
    button.disabled = false;
    button.textContent = "Test Connection";
  });
};

/** Format a webhook status line from a test result's webhook field */
// deno-lint-ignore no-explicit-any
const formatWebhookLine = (webhook: any, detail?: string): string =>
  webhook.configured
    ? `Webhook: ${detail ?? "configured"}`
    : `Webhook: Not configured${webhook.error ? ` - ${webhook.error}` : ""}`;

/** Format a Square location line */
// deno-lint-ignore no-explicit-any
const formatLocationLine = (loc: any): string =>
  loc.configured
    ? `Location: ${loc.name ?? loc.locationId}${loc.status ? ` (${loc.status})` : ""}`
    : `Location: Not configured${loc.error ? ` - ${loc.error}` : ""}`;

/** Format a credential validity line (e.g. "API Key: Valid (test mode)") */
// deno-lint-ignore no-explicit-any
const formatCredentialLine = (label: string, cred: any): string =>
  cred.valid
    ? `${label}: Valid (${cred.mode} mode)`
    : `${label}: Invalid${cred.error ? ` - ${cred.error}` : ""}`;

/** Format Stripe webhook endpoint lines */
// deno-lint-ignore no-explicit-any
const formatStripeWebhooks = (data: any): string[] => {
  if (data.webhookError) return [`Webhooks: Error - ${data.webhookError}`];
  if (!data.webhooks?.length) return ["Webhooks: None configured"];
  const lines = [`Webhooks: ${data.webhooks.length} endpoint(s)`];
  for (const wh of data.webhooks) {
    const ours =
      data.ownEndpointId && wh.endpointId === data.ownEndpointId
        ? " (tickets)"
        : "";
    lines.push(`  ${wh.status} - ${wh.url}${ours}`);
    lines.push(`  Events: ${wh.enabledEvents.join(", ")}`);
  }
  return lines;
};

/* Stripe connection test button */
setupTestButton(
  "stripe-test-btn",
  "stripe-test-result",
  "/admin/settings/stripe/test",
  "stripe-test-result",
  (data) => [
    formatCredentialLine("API Key", data.apiKey),
    ...formatStripeWebhooks(data),
  ],
);

/* Square connection test button */
setupTestButton(
  "square-test-btn",
  "square-test-result",
  "/admin/settings/square/test",
  "square-test-result",
  (data) => [
    formatCredentialLine("Access Token", data.accessToken),
    formatLocationLine(data.location),
    formatWebhookLine(data.webhook, "Signature key configured"),
  ],
);

/* Remaining chars counter for textareas with maxlength */
for (const ta of document.querySelectorAll<HTMLTextAreaElement>(
  "textarea[maxlength]",
)) {
  const max = Number(ta.getAttribute("maxlength"));
  if (!max) continue;
  const counter = document.createElement("small");
  counter.className = "char-counter";
  const update = () => {
    const remaining = max - ta.value.length;
    counter.textContent = `${remaining} / ${max}`;
    counter.classList.toggle("char-counter-warn", remaining < max * 0.1);
  };
  update();
  ta.addEventListener("input", update);
  ta.parentNode!.insertBefore(counter, ta.nextSibling);
}

/* Disable form on submit: prevent double-submission for normal POST forms.
 * Uses requestAnimationFrame so the browser sends the form before disabling. */
for (const form of document.querySelectorAll<HTMLFormElement>(
  'form[method="POST"]',
)) {
  form.addEventListener("submit", () => {
    requestAnimationFrame(() => {
      for (let i = 0; i < form.elements.length; i++) {
        (form.elements[i] as HTMLInputElement | HTMLButtonElement).disabled =
          true;
      }
    });
  });
}

/* Re-enable forms restored from bfcache (back/forward navigation). */
window.addEventListener("pageshow", (e) => {
  if (!e.persisted) return;
  for (const el of document.querySelectorAll<
    HTMLInputElement | HTMLButtonElement
  >("form[method='POST'] :disabled")) {
    el.disabled = false;
  }
});

/* Question visibility: show questions only when at least one
 * associated event has quantity > 0. Questions without data-event-ids are
 * always visible (single-event pages). */
{
  const questionFields = document.querySelectorAll<HTMLFieldSetElement>(
    "fieldset.custom-question[data-event-ids]",
  );
  if (questionFields.length > 0) {
    const updateVisibility = () => {
      for (const fieldset of questionFields) {
        const eventIds = (fieldset.dataset.eventIds ?? "").split(" ");
        const hasSelected = eventIds.some((id) => {
          const qty = document.querySelector<
            HTMLSelectElement | HTMLInputElement
          >(`[name="quantity_${id}"]`);
          return qty !== null && Number.parseInt(qty.value, 10) > 0;
        });
        fieldset.hidden = !hasSelected;
        for (const radio of fieldset.querySelectorAll<HTMLInputElement>(
          'input[type="radio"]',
        )) {
          radio.required = hasSelected;
        }
      }
    };
    // Listen on any quantity change
    for (const qty of document.querySelectorAll<
      HTMLSelectElement | HTMLInputElement
    >('[name^="quantity_"]')) {
      qty.addEventListener("change", updateVisibility);
    }
    // Run on load to set initial state
    updateVisibility();
  }
}
