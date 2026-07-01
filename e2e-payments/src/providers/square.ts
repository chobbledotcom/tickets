import type { Page } from "playwright";
import type { BrowserSession } from "../browser.ts";
import { log } from "../log.ts";
import { clickFirst, fillCard } from "./card.ts";
import { assertConfigured, selectProvider } from "./shared.ts";
import type { PaymentProvider } from "./types.ts";

/**
 * Square. Payment confirmation is asserted via the browser return URL
 * (validatePaidSession → processPaymentSession). Square webhooks require a
 * signed subscription created manually in the dashboard against a fixed
 * notification URL, which can't be provisioned for an ephemeral tunnel — so
 * this leg does NOT exercise Square's webhook path (the app rejects unsigned
 * Square webhooks). Scope is the return path only; see README.
 *
 * Square's hosted checkout renders card inputs inside the Web Payments SDK
 * iframe, so the card-fill helper searches child frames too.
 * Sandbox test card: 4111 1111 1111 1111, any future expiry, CVV 111,
 * postal 94103. Docs: https://developer.squareup.com/docs/devtools/sandbox/payments
 */
export const square: PaymentProvider = {
  name: "square",
  // US/USD is Square's default sandbox currency; override with SETUP_COUNTRY if
  // your sandbox location uses a different currency.
  setupCountry: "US",

  configure: async (session: BrowserSession, secrets): Promise<void> => {
    await selectProvider(session, "square");
    await session.fill("square_access_token", secrets.token);
    await session.fill("square_location_id", secrets.locationId);
    if (secrets.sandbox === "true") await session.check("square_sandbox");
    await session.clickButton("Update Square Credentials");
    await assertConfigured(session, "square");
  },

  payHostedCheckout: async (page: Page): Promise<void> => {
    log("Filling Square hosted checkout…");
    await page.waitForLoadState("domcontentloaded");
    // Square's card inputs live inside the Web Payments SDK iframe; the generic
    // filler searches child frames and matches the SDK's cc-* autocomplete
    // tokens. Sandbox card 4111 …, CVV 111, US ZIP 94103.
    await fillCard(page, {
      number: "4111111111111111",
      expiry: "12/34",
      cvc: "111",
      postal: "94103",
    });
    await clickFirst(page, "pay button", [
      'button:has-text("Pay")',
      'button[type="submit"]',
      "#rswp-card-button",
    ]);
  },
};
