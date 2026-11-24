/** Once a sealed order's session is settled, the order gives way to a receipt
 * with no personal details. A retryable outcome keeps the whole order, and a
 * replay repairs a receipt write that the first delivery lost.
 *
 * The shop is driven through its pages and the fake Stripe. Only the stored
 * row is read and rewritten directly, because no page shows what it holds. */

import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import {
  openCheckoutBundle,
  rewriteCheckoutBundle,
} from "#db/checkout-bundles.ts";
import { requireValue } from "#shared/required-value.ts";
import {
  type CardShop,
  checkOut,
  deliverPayment,
  openCardShop,
  returnPage,
  rosterOf,
  THANK_YOU_URL,
} from "#test/blackbox/card-shop.ts";
import type { FakeCheckout } from "#test/blackbox/fake-stripe.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { withEnv } from "#test-utils/env.ts";

const OWN_THANKS = "https://example.com/the-order-says-thanks";

const tokenOf = (checkout: FakeCheckout): string =>
  requireValue(checkout.metadata.bundle, `${checkout.id} holds no token`);

/** What the token of a checkout opens now. */
const stored = (checkout: FakeCheckout) =>
  openCheckoutBundle(tokenOf(checkout));

/** A stored row that opens to this record. */
const holding = (record: Record<string, string>) => ({
  record,
  status: "opened",
});

/** The whole order of the shop's standard checkout: two places at 1000. */
const orderOf = (shop: CardShop) => ({
  _origin: "localhost",
  email: "buyer@example.com",
  items: JSON.stringify([{ e: shop.listing.id, p: 2000, q: 2 }]),
  name: "Sealed Buyer",
  tax_policy: JSON.stringify({ mode: "none" }),
});

/** Its receipt: the lines, and nothing of the buyer. */
const receiptOf = (shop: CardShop) => ({
  _origin: "localhost",
  items: JSON.stringify([{ e: shop.listing.id, p: 2000, q: 2 }]),
});

describeWithEnv("a settled sealed checkout order", { db: true }, () => {
  let shop: CardShop | undefined;
  const open = async () => {
    shop = await openCardShop();
    return shop;
  };
  afterEach(async () => {
    await shop?.fake.close();
    shop = undefined;
  });

  /** The listing stops taking bookings and Stripe turns refunds down, so a
   * paid callback can neither book nor return the money. */
  const blockBookingAndRefund = async (opened: CardShop) => {
    await opened.api.put(`/api/admin/listings/${opened.listing.id}`, {
      active: false,
    });
    opened.fake.refuseRefunds();
  };

  test("a checkout keeps the whole order until its session is settled", async () => {
    const opened = await open();
    const checkout = await checkOut(opened);

    expect(await stored(checkout)).toEqual(holding(orderOf(opened)));
  });

  test("a booked session keeps only a receipt with no personal details", async () => {
    const opened = await open();
    const checkout = await checkOut(opened);

    expect((await deliverPayment(opened, checkout)).status).toBe(200);

    expect(await stored(checkout)).toEqual(holding(receiptOf(opened)));
    expect(await rosterOf(opened)).toEqual([["Sealed Buyer", 2]]);
  });

  test("a session that ends refunded keeps only a receipt", async () => {
    const opened = await open();
    const checkout = await checkOut(opened);

    expect(
      (await deliverPayment(opened, checkout, { charged: 1999 })).status,
    ).toBe(200);

    expect(opened.fake.refunds).toEqual([
      { amount: 1999, paymentIntent: checkout.paymentIntent },
    ]);
    expect(await stored(checkout)).toEqual(holding(receiptOf(opened)));
  });

  test("a refund that Stripe turns down keeps the whole order for the retry", async () => {
    const opened = await open();
    const checkout = await checkOut(opened);
    await blockBookingAndRefund(opened);
    using _env = withEnv({ TEST_EXPECT_ERROR: "1" });

    const answer = await deliverPayment(opened, checkout);

    expect(answer.status).toBe(503);
    expect(opened.fake.refunds).toEqual([
      { amount: 2000, paymentIntent: checkout.paymentIntent },
    ]);
    expect(await stored(checkout)).toEqual(holding(orderOf(opened)));
    expect(await rosterOf(opened)).toEqual([]);
  });

  test("a second callback that arrives while the first is at work leaves the whole order", async () => {
    const opened = await open();
    const checkout = await checkOut(opened);
    await blockBookingAndRefund(opened);
    using _env = withEnv({ TEST_EXPECT_ERROR: "1" });

    const answers = await Promise.all([
      deliverPayment(opened, checkout),
      deliverPayment(opened, checkout),
    ]);

    // One callback holds the session and fails. The other is told to wait.
    expect(answers.map((answer) => answer.status).toSorted()).toEqual([
      409, 503,
    ]);
    expect(opened.fake.refunds).toHaveLength(1);
    expect(await stored(checkout)).toEqual(holding(orderOf(opened)));
  });

  test("the receipt keeps the order's own thank-you link, and the return page offers it", async () => {
    const opened = await open();
    const checkout = await checkOut(opened);
    await rewriteCheckoutBundle(tokenOf(checkout), {
      ...orderOf(opened),
      thank_you_url: OWN_THANKS,
    });
    await deliverPayment(opened, checkout);

    const page = await returnPage(checkout);

    expect(await stored(checkout)).toEqual(
      holding({
        ...receiptOf(opened),
        thank_you_url: OWN_THANKS,
      }),
    );
    expect(page.status).toBe(200);
    expect(page.html).toContain(`href="${OWN_THANKS}"`);
    expect(page.html).not.toContain(THANK_YOU_URL);
  });

  test("the return page after the webhook booked still offers the listing's thank-you link", async () => {
    const opened = await open();
    const checkout = await checkOut(opened);
    await deliverPayment(opened, checkout);

    const sent = await returnPage(checkout);
    const page = await opened.owner.get(sent.location ?? "");

    expect(sent.status).toBe(302);
    expect(page.html).toContain(`href="${THANK_YOU_URL}"`);
  });

  test("a replay writes the receipt that the first delivery failed to write", async () => {
    const opened = await open();
    const checkout = await checkOut(opened);
    await deliverPayment(opened, checkout);
    await rewriteCheckoutBundle(tokenOf(checkout), orderOf(opened));

    await deliverPayment(opened, checkout);

    expect(await stored(checkout)).toEqual(holding(receiptOf(opened)));
    expect(await rosterOf(opened)).toEqual([["Sealed Buyer", 2]]);
  });
});
