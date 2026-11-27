/** A card checkout keeps its order sealed in the shop. Stripe holds only a
 * token, the first listing, and a signed proof. The webhook and the buyer's
 * return page open the order and book it once between them. A callback with
 * changed metadata books nothing. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import * as v from "valibot";
import { requireValue } from "#shared/required-value.ts";
import {
  type CardShop,
  cancelPage,
  deliverPayment,
  returnPage,
  rosterOf,
  useCardShop,
} from "#test/blackbox/card-shop.ts";
import { createApp, inProcess } from "#test/blackbox/driver.ts";
import { addListing, type SeededListing } from "#test/blackbox/seed.ts";
import { describeWithEnv } from "#test-utils/db.ts";

const BOOKED = [["Sealed Buyer", 2]];

/** The only metadata keys that Stripe receives. */
const SENT_KEYS = ["_origin", "bundle", "listing", "price_proof"];

const Names = v.object({
  attendees: v.array(v.looseObject({ name: v.string() })),
});

/** The names booked on each listing, in listing order. */
const bookedOn = (shop: CardShop, listings: readonly SeededListing[]) =>
  Promise.all(
    listings.map(async ({ id }) =>
      v
        .parse(
          Names,
          (await shop.api.get(`/api/admin/listings/${id}/attendees`)).body,
        )
        .attendees.map(({ name }) => name),
    ),
  );
const TICKETS_PAGE = /^\/payment\/success\?tokens=[0-9A-F]+$/;

/** What a return visit can do, by name. */
const VISITS: [string, RegExp][] = [
  ["sent to the tickets", /^\/payment\/success\?tokens=[0-9A-F]+ /],
  [
    "told to wait",
    /Payment is being processed\. Please wait a moment and refresh\./,
  ],
  ["shown success", /data-payment-result="success"/],
];

/** The names of what a return visit did, from where it was sent and what it
 * showed. */
const visitDid = (page: { html: string; location: string | null }) =>
  VISITS.filter(([, pattern]) =>
    pattern.test(`${page.location} ${page.html}`),
  ).map(([name]) => name);

/** The webhook answer and the return visit, when both arrive together. The
 * one that reserves the session books. The other answers from that booking,
 * or waits for it. */
const TOGETHER = [
  [200, ["sent to the tickets"]],
  [200, ["told to wait"]],
  [409, ["sent to the tickets"]],
];

describeWithEnv("a sealed card checkout", { db: true }, () => {
  const { checkedOut, open } = useCardShop();

  test("tells Stripe only a token, the first listing, and the proof", async () => {
    const { checkout, opened } = await checkedOut();

    expect(Object.keys(checkout.metadata).toSorted()).toEqual(SENT_KEYS);
    expect(checkout.metadata.listing).toBe(String(opened.listing.id));
    const sent = JSON.stringify(checkout.metadata);
    expect(sent).not.toContain("Sealed Buyer");
    expect(sent).not.toContain("buyer@example.com");
  });

  test("books an order of forty listings, because Stripe holds only the token", async () => {
    const opened = await open();
    const stalls: SeededListing[] = [];
    for (const number of Array.from({ length: 39 }, (_, index) => index + 1)) {
      stalls.push(
        await addListing(opened.api, {
          max_attendees: 10,
          name: `Stall ${number}`,
          unit_price: 100,
        }),
      );
    }
    const listings = [opened.listing, ...stalls];
    const sent = await createApp(inProcess).submit(
      `/ticket/${listings.map(({ slug }) => slug).join("+")}`,
      {
        email: "buyer@example.com",
        name: "Sealed Buyer",
        ...Object.fromEntries(listings.map(({ id }) => [`quantity${id}`, "1"])),
      },
    );
    const checkout = requireValue(
      opened.fake.checkouts.at(-1),
      "The app opened no checkout",
    );

    expect(sent.location).toBe(`https://checkout.stripe.test/${checkout.id}`);
    expect(Object.keys(checkout.metadata).toSorted()).toEqual(SENT_KEYS);
    expect((await deliverPayment(opened, checkout)).status).toBe(200);
    expect(await bookedOn(opened, listings)).toEqual(
      listings.map(() => ["Sealed Buyer"]),
    );
  });

  test("books the order that the token opens, and a replay books nothing more", async () => {
    const { checkout, opened } = await checkedOut();

    expect((await deliverPayment(opened, checkout)).status).toBe(200);
    expect((await deliverPayment(opened, checkout)).status).toBe(200);

    expect(await rosterOf(opened)).toEqual(BOOKED);
    expect(opened.fake.refunds).toEqual([]);
  });

  test("a callback whose listing or token was changed books nothing, and the true callback still books", async () => {
    const { checkout, opened } = await checkedOut();

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
    const { checkout, opened } = await checkedOut();

    const answer = await deliverPayment(opened, checkout, { charged: 1999 });

    expect(answer.status).toBe(200);
    expect(opened.fake.refunds).toEqual([
      { amount: 1999, paymentIntent: checkout.paymentIntent },
    ]);
    expect(await rosterOf(opened)).toEqual([["Sealed Buyer", 0]]);
  });

  test("the buyer who comes back from Stripe after the webhook is sent to the tickets", async () => {
    const { checkout, opened } = await checkedOut();
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
    const { checkout, opened } = await checkedOut();
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

  test("the webhook and the buyer who arrive together make one booking, and the second answers from it", async () => {
    const { checkout, opened } = await checkedOut();
    opened.fake.pay(checkout);

    const [answer, visit] = await Promise.all([
      deliverPayment(opened, checkout),
      returnPage(checkout),
    ]);
    const later = await returnPage(checkout);

    expect(TOGETHER).toContainEqual([answer.status, visitDid(visit)]);
    expect([["sent to the tickets"], ["shown success"]]).toContainEqual(
      visitDid(later),
    );
    expect(await rosterOf(opened)).toEqual(BOOKED);
    expect(opened.fake.refunds).toEqual([]);
  });

  test("the buyer who gives up at Stripe is offered the booking page again", async () => {
    const { checkout, opened } = await checkedOut();

    const page = await cancelPage(checkout);

    expect(page.status).toBe(200);
    expect(page.html).toContain('data-payment-result="cancel"');
    expect(page.html).toContain(`href="/ticket/${opened.listing.slug}"`);
    expect(await rosterOf(opened)).toEqual([]);
  });
});
