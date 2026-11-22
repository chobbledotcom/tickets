/** Once a sealed order's session is settled, the order gives way to a receipt
 * with no personal details. A retryable outcome keeps the whole order, and a
 * replay repairs a receipt write that the first delivery lost.
 *
 * The shop is driven through its pages and the fake Stripe. Only the stored
 * row is read directly, because no page shows what the row holds. */

import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import {
  openCheckoutBundle,
  rewriteCheckoutBundle,
} from "#db/checkout-bundles.ts";
import {
  type CardShop,
  checkOut,
  deliverPayment,
  openCardShop,
  returnPage,
  rosterOf,
  THANK_YOU_URL,
} from "#test/blackbox/card-shop.ts";
import { createApp, inProcess } from "#test/blackbox/driver.ts";
import type { FakeCheckout } from "#test/blackbox/fake-stripe.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { withEnv } from "#test-utils/env.ts";

const PERSONAL_DETAILS = ["Sealed Buyer", "buyer@example.com"];

const tokenOf = (checkout: FakeCheckout): string => {
  const token = checkout.metadata.bundle;
  if (token === undefined) throw new Error(`${checkout.id} holds no token.`);
  return token;
};

const openedRecord = async (checkout: FakeCheckout) => {
  const opened = await openCheckoutBundle(tokenOf(checkout));
  if (opened.status !== "opened") {
    throw new Error(`The order of ${checkout.id} is ${opened.status}.`);
  }
  return opened.record;
};

/** The row holds the lines, and none of the buyer's personal details. */
const expectReceiptOnly = async (checkout: FakeCheckout) => {
  const record = await openedRecord(checkout);
  expect([record.name, record.email]).toEqual(["", ""]);
  expect(JSON.parse(record.items ?? "")).toMatchObject([{ q: 2 }]);
  const text = JSON.stringify(record);
  for (const personal of PERSONAL_DETAILS) expect(text).not.toContain(personal);
};

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

  test("a booked session keeps only a receipt with no personal details", async () => {
    const opened = await open();
    const checkout = await checkOut(opened);

    expect((await deliverPayment(opened, checkout)).status).toBe(200);

    await expectReceiptOnly(checkout);
  });

  test("a session that ends refunded keeps only a receipt", async () => {
    const opened = await open();
    const checkout = await checkOut(opened);

    expect(
      (await deliverPayment(opened, checkout, { charged: 1999 })).status,
    ).toBe(200);

    expect(opened.fake.refundCount()).toBe(1);
    await expectReceiptOnly(checkout);
  });

  test("a refund that Stripe turns down keeps the whole order for the retry", async () => {
    const opened = await open();
    const checkout = await checkOut(opened);
    await opened.api.put(`/api/admin/listings/${opened.listing.id}`, {
      active: false,
    });
    opened.fake.refuseRefunds();
    using _env = withEnv({ TEST_EXPECT_ERROR: "1" });

    await deliverPayment(opened, checkout);

    expect(opened.fake.refundCount()).toBe(1);
    expect((await openedRecord(checkout)).name).toBe("Sealed Buyer");
  });

  test("the return page after the webhook booked still offers the thank-you link", async () => {
    const opened = await open();
    const checkout = await checkOut(opened);
    await deliverPayment(opened, checkout);

    const sent = await returnPage(checkout);
    const page = await createApp(inProcess).get(sent.location ?? "");

    expect(page.html).toContain(THANK_YOU_URL);
  });

  test("a replay writes the receipt that the first delivery failed to write", async () => {
    const opened = await open();
    const checkout = await checkOut(opened);
    const order = await openedRecord(checkout);
    await deliverPayment(opened, checkout);
    await rewriteCheckoutBundle(tokenOf(checkout), order);

    await deliverPayment(opened, checkout);

    await expectReceiptOnly(checkout);
    expect(await rosterOf(opened)).toEqual([["Sealed Buyer", 2]]);
  });
});
