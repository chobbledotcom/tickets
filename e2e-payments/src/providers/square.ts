import type { Page } from "playwright";
import type { BrowserSession } from "../browser.ts";
import { log } from "../log.ts";
import { clickFirst, fillFirst } from "./card.ts";
import { assertConfigured, selectProvider } from "./shared.ts";
import type { PaymentProvider } from "./types.ts";

/**
 * Square. Payment confirmation flows through the browser return URL
 * (validatePaidSession → processPaymentSession), so the webhook signature key
 * (a manual dashboard step) is not needed for the e2e assertion — we skip it.
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
    await fillFirst(page, "card number", [
      'input[name="cardNumber"]',
      "#cardNumber",
      'input[placeholder*="Card"]',
    ], "4111111111111111");
    await fillFirst(page, "expiry", [
      'input[name="expirationDate"]',
      "#expirationDate",
      'input[placeholder*="MM"]',
    ], "12/34");
    await fillFirst(page, "cvv", ['input[name="cvv"]', "#cvv"], "111");
    await fillFirst(page, "postal", [
      'input[name="postalCode"]',
      "#postalCode",
    ], "94103", { required: false });
    await clickFirst(page, "pay button", [
      'button:has-text("Pay")',
      'button[type="submit"]',
      "#rswp-card-button",
    ]);
  },
};
