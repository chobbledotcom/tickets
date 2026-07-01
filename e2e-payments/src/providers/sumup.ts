import type { FrameLocator, Page } from "playwright";
import type { BrowserSession } from "../browser.ts";
import { log, warn } from "../log.ts";
import { clickFirst, fillCard } from "./card.ts";
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

const CARD = {
  number: "4000000000000002",
  expiry: "12/34",
  cvc: "123",
  name: "E2E Tester",
} as const;

/** Fill the single input inside a Braintree hosted-field iframe, if present. */
const fillBraintreeField = async (
  frame: FrameLocator,
  label: string,
  value: string,
  timeoutMs: number,
): Promise<boolean> => {
  const input = frame.locator("input").first();
  try {
    await input.fill(value, { timeout: timeoutMs });
    log(`  filled ${label} (Braintree hosted field)`);
    return true;
  } catch {
    return false;
  }
};

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

    // Braintree hosted fields: iframes titled "Secure Credit Card Frame - …".
    const numberFrame = page.frameLocator(
      'iframe[title*="Card Number" i], iframe[title*="Credit Card Number" i]',
    );
    const usedBraintree = await fillBraintreeField(
      numberFrame,
      "card number",
      CARD.number,
      10_000,
    );

    if (usedBraintree) {
      await fillBraintreeField(
        page.frameLocator('iframe[title*="Expiration" i]'),
        "expiry",
        CARD.expiry,
        8_000,
      );
      await fillBraintreeField(
        page.frameLocator('iframe[title*="CVV" i], iframe[title*="CVC" i]'),
        "cvc",
        CARD.cvc,
        8_000,
      );
      // Cardholder name is a top-level input on the SumUp page (not a hosted
      // field); best-effort, some flows omit it.
      const name = page
        .locator(
          'input[name="card-holder-name"], input[name="cardHolder"], input[autocomplete="cc-name"]',
        )
        .first();
      if (await name.count()) {
        await name.fill(CARD.name, { timeout: 5_000 }).catch(() => {});
      }
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
