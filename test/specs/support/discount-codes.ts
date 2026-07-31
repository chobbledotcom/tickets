/**
 * Promo codes, from the organiser making one to a customer's price coming
 * down. The organiser's half drives the real modifier form; the customer's
 * half fills in the real booking page and presses its own buttons, so a code
 * box that stopped rendering, or a quote button that stopped working, fails
 * the story rather than being worked around.
 */

import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { formatCurrency } from "#shared/currency.ts";
import { stripePaymentProvider } from "#shared/stripe-provider.ts";
import { openAdminPage } from "#test/specs/support/browser.ts";
import { fillInAndSend } from "#test/specs/support/form-controls.ts";
import { listingNamed } from "#test/specs/support/listings.ts";
import { minorUnits } from "#test/specs/support/money.ts";
import { openBookingPage } from "#test/specs/support/public-booking.ts";
import {
  keepsAnswerAs,
  requiredWorldValue,
  type TicketsWorld,
} from "#test/specs/support/world.ts";
import { completePaidCheckout } from "#test-utils/order-journey.ts";
import { setupStripe } from "#test-utils/settings.ts";
import type { TestBrowser } from "#test-utils/test-browser.ts";

/** The organiser makes a percentage-off promo code through the real form,
 * named after the code so the summary shows the words the story uses. */
export const organiserCreatesCode = async (
  world: TicketsWorld,
  code: string,
  percentOff: number,
): Promise<void> => {
  const browser = await openAdminPage(world, "/admin/modifiers/new");
  await fillInAndSend(
    browser,
    {
      calc_kind: "percent",
      calc_value: String(percentOff),
      code,
      direction: "discount",
      name: code,
      trigger: "code",
    },
    "Create Modifier",
  );
  world.ownerTold = browser.pageText;
  // Creation lands back on the list; the new code's own link carries its id.
  const rows = browser.currentHtml.matchAll(
    /<a[^>]*href="\/admin\/modifiers\/(\d+)[^"]*"[^>]*>([\s\S]*?)<\/a>/g,
  );
  // Matched whole, so an older "SAVE100" can never stand in for "SAVE10".
  const id = [...rows].find(
    (row) => row[2]!.replace(/<[^>]*>/g, "").trim() === code,
  )?.[1];
  if (!id) throw new Error(`The modifier list offers no link to ${code}`);
  world.things.remember("record", code, Number(id));
};

/** Whether a listing's booking page asks for a promo code at all. */
export const codeBoxOffered = async (
  world: TicketsWorld,
  listingName: string,
): Promise<boolean> => {
  const browser = await openBookingPage(listingNamed(world, listingName));
  return /\sname="promo_code"/.test(browser.currentHtml);
};

const CUSTOMER = { email: "quoter@example.com", name: "Quote Asker" };

/** One customer journey from a listing's booking page: the payment provider
 * stands ready, the page is opened, and the rest is what the journey does
 * with the code the customer holds. */
const fromBookingPage =
  <Answer>(
    journey: (
      world: TicketsWorld,
      browser: TestBrowser,
      code: string,
    ) => Promise<Answer>,
  ) =>
  async (
    world: TicketsWorld,
    listingName: string,
    code: string,
  ): Promise<Answer> => {
    await setupStripe();
    return journey(
      world,
      await openBookingPage(listingNamed(world, listingName)),
      code,
    );
  };

/** Fill the booking page in with a code and press its own "Show total"
 * button. What comes back is the site's whole answer, kept as sent — a word
 * beside the table is as much a disclosure as a word inside it. */
const askForTotal = async (
  browser: TestBrowser,
  code: string,
): Promise<string> => {
  await fillInAndSend(browser, { ...CUSTOMER, promo_code: code }, "Show total");
  // A quote with no table is the site refusing to total the order, so the
  // story stops here rather than reading a refusal as a summary.
  requiredWorldValue(
    browser.currentHtml.match(/<table class="order-summary">/)?.[0],
    "the price summary",
  );
  return browser.currentHtml;
};

/** What the site answers when a place's price is asked for with a code — or,
 * with the code left empty, without one. */
export const quoteFor = fromBookingPage((_world, browser, code) =>
  askForTotal(browser, code),
);

/** The customer asks what a place costs with the code they hold, and keeps
 * the answer for the story to read. */
export const customerAsksPrice = keepsAnswerAs("price summary", quoteFor);

/** The summary the customer was last shown. */
export const priceSummary = (world: TicketsWorld): string =>
  world.things.require("told", "price summary");

/** The one figure on the summary's total row. */
export const summaryTotal = (world: TicketsWorld): string => {
  const total = priceSummary(world).match(
    /order-summary-total[\s\S]*?<\/tr>/,
  )?.[0];
  if (!total) throw new Error("The summary shows no total row");
  return total;
};

/** The customer books with a code and pays. The booking page's own form
 * builds the checkout, and the payment completes through the provider — so
 * the code the customer typed is the one the books record. */
export const customerPaysWithCode = fromBookingPage(
  async (_world, browser, code) => {
    const captured: { intent: unknown } = { intent: null };
    const sessionId = "cs_discount_code";
    const checkoutStub = stub(
      stripePaymentProvider,
      "createCheckoutSession",
      (intent) => {
        captured.intent = intent;
        return Promise.resolve({
          checkoutUrl: "https://spec.test/checkout",
          sessionId,
        });
      },
    );
    try {
      await fillInAndSend(
        browser,
        { ...CUSTOMER, promo_code: code },
        "Continue",
      );
    } finally {
      checkoutStub.restore();
    }
    if (captured.intent === null) {
      throw new Error("Pressing Continue never reached the payment provider");
    }
    await completePaidCheckout(
      captured.intent as Parameters<typeof completePaidCheckout>[0],
      sessionId,
    );
  },
);

/** The exact money words the story's own numbers come to, e.g. "£9.00". */
export const asMoney = (pounds: string): string =>
  formatCurrency(minorUnits(pounds));

/** The summary line a discount writes: the code's name and what it took off. */
export const expectDiscountLine = (
  world: TicketsWorld,
  code: string,
  poundsOff: string,
): void => {
  const summary = priceSummary(world);
  expect(summary).toContain(code);
  expect(summary).toContain(formatCurrency(-minorUnits(poundsOff)));
};
