/** A card checkout keeps its order sealed in the shop. Stripe holds only a
 * token, the first listing, and a signed proof. The webhook opens the order
 * and books it. A callback with changed metadata books nothing. */

import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import {
  type CardShop,
  checkOut,
  deliverPayment,
  openCardShop,
  returnPage,
  rosterOf,
} from "#test/blackbox/card-shop.ts";
import { describeWithEnv } from "#test-utils/db.ts";

describeWithEnv("a sealed card checkout", { db: true }, () => {
  let shop: CardShop | undefined;
  const open = async () => {
    shop = await openCardShop();
    return shop;
  };
  afterEach(async () => {
    await shop?.fake.close();
    shop = undefined;
  });

  test("tells Stripe only a token, the first listing, and the proof", async () => {
    const opened = await open();
    const checkout = await checkOut(opened);

    expect(Object.keys(checkout.metadata).toSorted()).toEqual([
      "_origin",
      "bundle",
      "listing",
      "price_proof",
    ]);
    expect(checkout.metadata.listing).toBe(String(opened.listing.id));
    const sent = JSON.stringify(checkout.metadata);
    expect(sent).not.toContain("Sealed Buyer");
    expect(sent).not.toContain("buyer@example.com");
  });

  test("books the order that the token opens, and a replay books nothing more", async () => {
    const opened = await open();
    const checkout = await checkOut(opened);

    expect((await deliverPayment(opened, checkout)).status).toBe(200);
    expect((await deliverPayment(opened, checkout)).status).toBe(200);

    expect(await rosterOf(opened)).toEqual([["Sealed Buyer", 2]]);
    expect(opened.fake.refundCount()).toBe(0);
  });

  test("ignores a callback whose listing or token was changed", async () => {
    const opened = await open();
    const checkout = await checkOut(opened);

    for (const change of [
      { listing: String(opened.listing.id + 1) },
      { bundle: "a-token-the-shop-never-sealed" },
    ]) {
      const answer = await deliverPayment(opened, checkout, {
        metadata: { ...checkout.metadata, ...change },
      });
      expect(answer.status).toBe(200);
      expect(await answer.json()).toEqual({ received: true });
    }

    expect(await rosterOf(opened)).toEqual([]);
    expect(opened.fake.refundCount()).toBe(0);
  });

  test("a charge that differs from the signed total is booked as a refunded placeholder", async () => {
    const opened = await open();
    const checkout = await checkOut(opened);

    const answer = await deliverPayment(opened, checkout, { charged: 1999 });

    expect(answer.status).toBe(200);
    expect(opened.fake.refundCount()).toBe(1);
    expect(await rosterOf(opened)).toEqual([["Sealed Buyer", 0]]);
  });

  test("the buyer who comes back from Stripe after the webhook sees success", async () => {
    const opened = await open();
    const checkout = await checkOut(opened);
    await deliverPayment(opened, checkout);

    const page = await returnPage(checkout);

    expect([200, 302]).toContain(page.status);
    expect(page.html).not.toContain("Payment Error");
  });
});
