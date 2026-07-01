import type { Page } from "playwright";
import type { BrowserSession } from "../browser.ts";
import { log } from "../log.ts";
import { clickFirst, fillFirst } from "./card.ts";
import { assertConfigured, selectProvider } from "./shared.ts";
import type { PaymentProvider } from "./types.ts";

/**
 * SumUp. Sandbox vs live is inferred from the API key itself, and no webhook
 * signature is required (the app re-fetches the checkout to confirm). Payment
 * confirmation flows through the browser return URL.
 *
 * SumUp's hosted payment page card inputs may live inside an iframe, so the
 * card-fill helper searches child frames.
 * Sandbox test card: 4000 0000 0000 0002 (approved), any future expiry, any
 * CVV. Docs: https://developer.sumup.com/online-payments/tools/test-cards
 */
export const sumup: PaymentProvider = {
  name: "sumup",
  setupCountry: "GB",

  configure: async (session: BrowserSession, secrets): Promise<void> => {
    await selectProvider(session, "sumup");
    await session.fill("sumup_api_key", secrets.apiKey);
    await session.fill("sumup_merchant_code", secrets.merchantCode);
    await session.clickButton("Update SumUp Credentials");
    await assertConfigured(session, "sumup");
  },

  payHostedCheckout: async (page: Page): Promise<void> => {
    log("Filling SumUp hosted checkout…");
    await page.waitForLoadState("domcontentloaded");
    await fillFirst(page, "card number", [
      'input[name="card-number"]',
      'input[name="cardNumber"]',
      "#card-number",
    ], "4000000000000002");
    await fillFirst(page, "cardholder name", [
      'input[name="card-holder-name"]',
      'input[name="cardHolder"]',
    ], "E2E Tester", { required: false });
    await fillFirst(page, "expiry", [
      'input[name="expiry-date"]',
      'input[name="expiryDate"]',
      "#expiry-date",
    ], "12/34");
    await fillFirst(page, "cvv", [
      'input[name="cvv"]',
      'input[name="cvc"]',
      "#cvv",
    ], "123");
    await clickFirst(page, "pay button", [
      'button:has-text("Pay")',
      'button[type="submit"]',
    ]);
  },
};
