/**
 * Promo codes, from the organiser making one to a customer's price coming
 * down. The organiser's half drives the real modifier form; the customer's
 * half fills in the real booking page and presses its own buttons, so a code
 * box that stopped rendering, or a quote button that stopped working, fails
 * the story rather than being worked around.
 */

import { expect } from "@std/expect";
import { formatCurrency } from "#shared/currency.ts";
import { PAYMENT_PROVIDER_RESOURCES } from "#shared/payment-runtime/current.ts";
import { stripePaymentProvider } from "#shared/stripe-provider.ts";
import { openAdminPage } from "#test/specs/support/browser.ts";
import { fillInAndSend } from "#test/specs/support/form-controls.ts";
import { listingNamed } from "#test/specs/support/listings.ts";
import { minorUnits } from "#test/specs/support/money.ts";
import { openBookingPage } from "#test/specs/support/public-booking.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";
import { stubProviderCheckout } from "#test-utils/checkout.ts";
import { settleDeferredPaymentWork } from "#test-utils/maintenance.ts";
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
  (
    journey: (
      world: TicketsWorld,
      browser: TestBrowser,
      code: string,
    ) => Promise<void>,
  ) =>
  async (
    world: TicketsWorld,
    listingName: string,
    code: string,
  ): Promise<void> => {
    await setupStripe();
    return journey(
      world,
      await openBookingPage(listingNamed(world, listingName)),
      code,
    );
  };

/** The customer fills the booking page in with a code and presses the page's
 * own "Show total" button. What came back is kept for the summary steps. */
export const customerAsksPrice = fromBookingPage(
  async (world, browser, code) => {
    await fillInAndSend(
      browser,
      { ...CUSTOMER, promo_code: code },
      "Show total",
    );
    world.things.remember("told", "price summary", browser.currentHtml);
  },
);

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
    const sessionId = "cs_discount_code";
    // The provider is stood in for and the exact checkout it was handed is
    // kept, so the payment can be finished as the app actually signed it.
    const checkoutStub = stubProviderCheckout(stripePaymentProvider, () =>
      Promise.resolve({
        checkoutUrl: "https://spec.test/checkout",
        session: PAYMENT_PROVIDER_RESOURCES.stripe.session(sessionId),
        sessionId,
      }),
    );
    try {
      await fillInAndSend(
        browser,
        { ...CUSTOMER, promo_code: code },
        "Continue",
      );
    } finally {
      checkoutStub.checkout.restore();
    }
    await completePaidCheckout(checkoutStub.requireCaptured(), sessionId);
    // The activity log entry for the code is written after the buyer is sent
    // on their way, so the story waits for that work the way the site does.
    await settleDeferredPaymentWork();
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
