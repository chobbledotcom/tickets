import type { Page } from "playwright";
import type { BrowserSession } from "../browser.ts";
import { log, warn } from "../log.ts";
import { clickFirst, fillFirst } from "./card.ts";
import { assertConfigured, selectProvider } from "./shared.ts";
import type { PaymentProvider } from "./types.ts";

/**
 * Stripe. Configuring the key registers a webhook endpoint against the site's
 * public HTTPS URL, so this provider REQUIRES the cloudflared tunnel.
 *
 * Hosted Stripe Checkout (checkout.stripe.com) exposes its inputs at the top
 * level (not iframed), addressable via the WHATWG cc-* autocomplete tokens the
 * generic card filler tries first. The billing country shown on Checkout is
 * driven by the Stripe account, so the postal field expects a matching format —
 * a US sandbox account rejects a UK postcode ("your ZIP is incomplete"). Set up
 * the site as US/USD and enter a US ZIP so the two agree.
 * Sandbox test card: 4242 4242 4242 4242, any future expiry, any CVC.
 * Docs: https://docs.stripe.com/testing
 */
export const stripe: PaymentProvider = {
  name: "stripe",
  setupCountry: "US",

  configure: async (session: BrowserSession, secrets): Promise<void> => {
    await selectProvider(session, "stripe");
    await session.fill("stripe_secret_key", secrets.secretKey);
    await session.clickButton("Update Stripe Key");
    await assertConfigured(session, "stripe");
  },

  payHostedCheckout: async (page: Page): Promise<void> => {
    log("Filling Stripe Checkout hosted page…");
    await page.waitForLoadState("domcontentloaded");
    // Target Stripe Checkout's own field ids (#cardNumber/#cardExpiry/#cardCvc/
    // #billingPostalCode). Do NOT use the generic cc-* autocomplete selectors:
    // Stripe seeds hidden top-level autofill "decoy" inputs carrying those
    // tokens, and filling a decoy leaves the real field empty → Checkout reports
    // "Required". Email is prefilled from the booking. US ZIP (42424) to match
    // the account's billing country — a UK postcode gets its letters stripped to
    // a too-short ZIP ("SW1A 1AA" → "11", "incomplete").
    await fillFirst(
      page,
      "card number",
      ["#cardNumber", 'input[name="cardNumber"]'],
      "4242424242424242",
    );
    await fillFirst(
      page,
      "expiry",
      ["#cardExpiry", 'input[name="cardExpiry"]'],
      "12 / 34",
    );
    await fillFirst(page, "cvc", ["#cardCvc", 'input[name="cardCvc"]'], "123");
    await fillFirst(
      page,
      "name on card",
      ["#billingName", 'input[name="billingName"]'],
      "E2E Tester",
      { required: false },
    );
    await fillFirst(
      page,
      "postal code",
      ["#billingPostalCode", 'input[name="billingPostalCode"]'],
      "42424",
      { required: false },
    );
    await clickFirst(page, "pay button", [
      'button[data-testid="hosted-payment-submit-button"]',
      ".SubmitButton",
      'button:has-text("Pay")',
    ]);
  },

  // Each run registers a webhook endpoint for its ephemeral *.trycloudflare.com
  // URL, and the throwaway DB forgets the id — so without cleanup they pile up
  // and Stripe eventually rejects new ones (accounts cap webhook endpoints).
  // Delete every endpoint pointing at a trycloudflare tunnel, which also sweeps
  // up any orphans left by earlier runs.
  cleanup: async (secrets): Promise<void> => {
    const headers = { Authorization: `Bearer ${secrets.secretKey}` };
    try {
      const res = await fetch(
        "https://api.stripe.com/v1/webhook_endpoints?limit=100",
        { headers },
      );
      if (!res.ok) {
        warn(`  Stripe webhook cleanup: list failed (HTTP ${res.status})`);
        return;
      }
      const body = (await res.json()) as {
        data?: { id: string; url?: string }[];
      };
      const stale = (body.data ?? []).filter((e) =>
        e.url?.includes("trycloudflare.com"),
      );
      for (const endpoint of stale) {
        await fetch(
          `https://api.stripe.com/v1/webhook_endpoints/${endpoint.id}`,
          { method: "DELETE", headers },
        ).catch(() => {});
        log(`  deleted stale Stripe webhook endpoint ${endpoint.id}`);
      }
      if (stale.length === 0) log("  no stale Stripe webhook endpoints to clean");
    } catch (err) {
      warn(`  Stripe webhook cleanup skipped: ${String(err)}`);
    }
  },
};
