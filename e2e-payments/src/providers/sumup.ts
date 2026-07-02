import type { Page } from "playwright";
import type { BrowserSession } from "../browser.ts";
import { log, warn } from "../log.ts";
import { clickFirst, fillCard, fillFirst, fillFrameInput } from "./card.ts";
import { assertConfigured, selectProvider } from "./shared.ts";
import type { PaymentProvider } from "./types.ts";

/**
 * SumUp. Sandbox vs live is inferred from the API key itself, and no webhook
 * signature is required (the app re-fetches the checkout to confirm). Payment
 * confirmation flows through the browser return URL.
 *
 * SumUp's hosted checkout (checkout.sumup.com) renders its card inputs with
 * Braintree hosted fields: each field is a separate cross-origin iframe titled
 * "Secure Credit Card Frame - <field>", holding a single <input>. We target
 * those iframes by title and fill the lone input inside. If SumUp serves a
 * non-Braintree variant, fall back to the generic same-frame card filler.
 * Sandbox test card: 4000 0000 0000 0002 (approved), any future expiry, any
 * CVV. Docs: https://developer.sumup.com/online-payments/tools/test-cards
 */

// SumUp sandbox Visa that succeeds with frictionless (no 3DS challenge)
// authentication. 4000…0002 is a DECLINE card ("Payment Declined").
// Docs: https://developer.sumup.com/online-payments/testing
const CARD = {
  number: "4200000000000091",
  expiry: "12/34",
  cvc: "123",
  name: "E2E Tester",
} as const;

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

    // Braintree hosted fields: each card field is its own iframe titled
    // "Secure Credit Card Frame - <field>", holding a single <input>.
    const usedBraintree = await fillFrameInput(
      page,
      "card number",
      ["Card Number", "Credit Card Number"],
      "input",
      CARD.number,
      10_000,
    );

    if (usedBraintree) {
      // Once the card-number Braintree iframe is present, expiry and CVV are
      // REQUIRED to submit. If either can't be filled (its iframe title changed,
      // or it loaded late), fail fast here with the specific missing field —
      // otherwise Pay is clicked with an incomplete card and the run dies as a
      // misleading checkout/confirmation timeout that hides the real cause.
      const filledExpiry = await fillFrameInput(
        page,
        "expiry",
        ["Expiration"],
        "input",
        CARD.expiry,
      );
      const filledCvc = await fillFrameInput(page, "cvc", ["CVV", "CVC"], "input", CARD.cvc);
      if (!filledExpiry || !filledCvc) {
        const missing = [
          ...(filledExpiry ? [] : ["expiry"]),
          ...(filledCvc ? [] : ["cvc"]),
        ].join(" and ");
        throw new Error(
          `SumUp: filled the Braintree card number but could not fill the ${missing} ` +
            "hosted field(s) — the iframe title likely changed. Refusing to submit an " +
            "incomplete card.",
        );
      }
      // Cardholder name is required on SumUp's page and renders slightly after
      // the hosted card fields, so poll for it (across the top level and any
      // frame) rather than a one-shot presence check — otherwise Pay is blocked
      // by "Please enter the cardholder name" and the booking never redirects.
      await fillFirst(
        page,
        "cardholder name",
        [
          'input[name="card-holder-name"]',
          'input[name="cardHolder"]',
          'input[autocomplete="cc-name"]',
          'input[id*="cardholder" i]',
          'input[placeholder*="name" i]',
          'input[aria-label*="name" i]',
        ],
        CARD.name,
      );
    } else {
      warn("  Braintree hosted fields not found — trying generic card fill");
      await fillCard(page, {
        number: CARD.number,
        expiry: CARD.expiry,
        cvc: CARD.cvc,
        name: CARD.name,
      });
    }

    await clickFirst(page, "pay button", [
      '[data-testid="widget-pay-button"]',
      'button[data-testid*="pay" i]',
      'button:has-text("Pay")',
      'button[type="submit"]',
    ]);
  },
};
