/** A card checkout keeps its order sealed in the shop. Stripe holds only a
 * token, the first listing, and a signed proof. The webhook and the buyer's
 * return page open the order and book it once between them. A callback with
 * changed metadata books nothing. */

import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import {
  type CardShop,
  cancelPage,
  checkOut,
  deliverPayment,
  openCardShop,
  returnPage,
  rosterOf,
} from "#test/blackbox/card-shop.ts";
import { createApp, inProcess } from "#test/blackbox/driver.ts";
import { describeWithEnv } from "#test-utils/db.ts";

const BOOKED = [["Sealed Buyer", 2]];
const TICKETS_PAGE = /^\/payment\/success\?tokens=[0-9A-F]+$/;

/** A return visit that was sent to the tickets, or told to wait for the
 * booking that the other request makes. */
const SENT_OR_WAITING =
  /^\/payment\/success\?tokens=[0-9A-F]+ |Payment is being processed\. Please wait a moment and refresh\./;

/** A later return visit, once the booking is made: the tickets, or the
 * success page that a repeated visit shows. */
const SENT_OR_SUCCESS =
  /^\/payment\/success\?tokens=[0-9A-F]+ |data-payment-result="success"/;

/** A return visit as one text: where it was sent, then what it showed. */
const seenOn = (page: { html: string; location: string | null }): string =>
  `${page.location} ${page.html}`;

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

    expect(await rosterOf(opened)).toEqual(BOOKED);
    expect(opened.fake.refunds).toEqual([]);
  });

  test("a callback whose listing or token was changed books nothing, and the true callback still books", async () => {
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

    await deliverPayment(opened, checkout);

    expect(await rosterOf(opened)).toEqual(BOOKED);
    expect(opened.fake.refunds).toEqual([]);
  });

  test("a charge that differs from the signed total is refunded in full, and booked with no places", async () => {
    const opened = await open();
    const checkout = await checkOut(opened);

    const answer = await deliverPayment(opened, checkout, { charged: 1999 });

    expect(answer.status).toBe(200);
    expect(opened.fake.refunds).toEqual([
      { amount: 1999, paymentIntent: checkout.paymentIntent },
    ]);
    expect(await rosterOf(opened)).toEqual([["Sealed Buyer", 0]]);
  });

  test("the buyer who comes back from Stripe after the webhook is sent to the tickets", async () => {
    const opened = await open();
    const checkout = await checkOut(opened);
    await deliverPayment(opened, checkout);

    const sent = await returnPage(checkout);

    expect(sent.status).toBe(302);
    expect(sent.location).toMatch(TICKETS_PAGE);
    const page = await createApp(inProcess).get(sent.location ?? "");
    expect(page.status).toBe(200);
    expect(page.html).toContain('data-payment-result="success"');
    expect(await rosterOf(opened)).toEqual(BOOKED);
  });

  test("the buyer who comes back before the webhook is booked once, and neither the late webhook nor a second visit books more", async () => {
    const opened = await open();
    const checkout = await checkOut(opened);
    opened.fake.pay(checkout);

    const sent = await returnPage(checkout);
    expect(sent.location).toMatch(TICKETS_PAGE);
    expect(await rosterOf(opened)).toEqual(BOOKED);

    expect((await deliverPayment(opened, checkout)).status).toBe(200);
    const again = await returnPage(checkout);

    expect(again.status).toBe(200);
    expect(again.html).toContain('data-payment-result="success"');
    expect(await rosterOf(opened)).toEqual(BOOKED);
    expect(opened.fake.refunds).toEqual([]);
  });

  test("the webhook and the buyer who arrive at the same time make one booking between them", async () => {
    const opened = await open();
    const checkout = await checkOut(opened);
    opened.fake.pay(checkout);

    const [answer, visit] = await Promise.all([
      deliverPayment(opened, checkout),
      returnPage(checkout),
    ]);

    // One of the two books. The other answers from that booking, or waits.
    expect([200, 409]).toContain(answer.status);
    expect(seenOn(visit)).toMatch(SENT_OR_WAITING);
    expect(seenOn(await returnPage(checkout))).toMatch(SENT_OR_SUCCESS);
    expect(await rosterOf(opened)).toEqual(BOOKED);
    expect(opened.fake.refunds).toEqual([]);
  });

  test("the buyer who gives up at Stripe is offered the booking page again", async () => {
    const opened = await open();
    const checkout = await checkOut(opened);

    const page = await cancelPage(checkout);

    expect(page.status).toBe(200);
    expect(page.html).toContain('data-payment-result="cancel"');
    expect(page.html).toContain(`href="/ticket/${opened.listing.slug}"`);
    expect(await rosterOf(opened)).toEqual([]);
  });
});
