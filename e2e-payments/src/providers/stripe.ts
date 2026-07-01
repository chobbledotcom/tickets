import type { Page } from "playwright";
import type { BrowserSession } from "../browser.ts";
import { log, warn } from "../log.ts";
import { clickFirst, fillCard } from "./card.ts";
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
    // Stripe's hosted Checkout (checkout.stripe.com) exposes the card fields via
    // the WHATWG cc-* autocomplete tokens the generic filler tries first — it is
    // NOT the split "Secure card number input frame" iframes of embedded Stripe
    // Elements, so no frameLocator is needed here. Email is prefilled from the
    // booking; US ZIP to match the account's billing country (see note above).
    await fillCard(page, {
      number: "4242424242424242",
      expiry: "12 / 34",
      cvc: "123",
      name: "E2E Tester",
      postal: "42424",
    });
    // Let Stripe validate the freshly-typed fields before submitting, otherwise
    // Pay can fire while the card is still "incomplete" and silently no-op.
    await page.waitForTimeout(1_000);
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
