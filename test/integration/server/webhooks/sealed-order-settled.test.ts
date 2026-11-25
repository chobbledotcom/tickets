/** Once a sealed order's session is settled, the order gives way to a receipt
 * with no personal details. A retryable outcome keeps the whole order, and a
 * replay repairs a receipt write that the first delivery lost.
 *
 * The shop is driven through its pages and the fake Stripe. Only the stored
 * row is read and rewritten directly, because no page shows what it holds. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  openCheckoutBundle,
  rewriteCheckoutBundle,
} from "#db/checkout-bundles.ts";
import { requireValue } from "#shared/required-value.ts";
import {
  type CardShop,
  deliverPayment,
  returnPage,
  rosterOf,
  THANK_YOU_URL,
  useCardShop,
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

/** Its receipt: the lines and the receipt mark, and nothing of the buyer. */
const receiptOf = (shop: CardShop) => ({
  _origin: "localhost",
  _receipt: "1",
  items: JSON.stringify([{ e: shop.listing.id, p: 2000, q: 2 }]),
});

/** The listing stops taking bookings and Stripe turns refunds down, so a
 * paid callback can neither book nor return the money. */
const blockBookingAndRefund = async (shop: CardShop) => {
  await shop.api.put(`/api/admin/listings/${shop.listing.id}`, {
    active: false,
  });
  shop.fake.refuseRefunds();
};

/** One way a checkout's callbacks can go: the work before the callbacks,
 * the callbacks, and what is left. `refunded` lists the amount of each
 * refund. A null `booked` means that the case does not read the roster.
 * `failsLoudly` marks a case whose callback logs an error on purpose. */
type Outcome = {
  readonly before?: (shop: CardShop, checkout: FakeCheckout) => Promise<void>;
  readonly deliver: (
    shop: CardShop,
    checkout: FakeCheckout,
  ) => Promise<Response[]>;
  readonly statuses: readonly number[];
  readonly refunded: readonly number[];
  readonly keeps: "order" | "receipt";
  readonly booked: readonly [string, number][] | null;
  readonly failsLoudly?: true;
};

const BOOKED: [string, number][] = [["Sealed Buyer", 2]];

const once =
  (options?: Parameters<typeof deliverPayment>[2]) =>
  async (shop: CardShop, checkout: FakeCheckout) => [
    await deliverPayment(shop, checkout, options),
  ];

const OUTCOMES: [string, Outcome][] = [
  [
    "a checkout with no callback keeps the whole order",
    {
      booked: null,
      deliver: async () => [],
      keeps: "order",
      refunded: [],
      statuses: [],
    },
  ],
  [
    "a booked session keeps only a receipt with no personal details",
    {
      booked: BOOKED,
      deliver: once(),
      keeps: "receipt",
      refunded: [],
      statuses: [200],
    },
  ],
  [
    "a session that ends refunded keeps only a receipt",
    {
      booked: null,
      deliver: once({ charged: 1999 }),
      keeps: "receipt",
      refunded: [1999],
      statuses: [200],
    },
  ],
  [
    "a refund that Stripe turns down keeps the whole order for the retry",
    {
      before: blockBookingAndRefund,
      booked: [],
      deliver: once(),
      failsLoudly: true,
      keeps: "order",
      refunded: [2000],
      statuses: [503],
    },
  ],
  [
    // One callback holds the session and fails. The other is told to wait.
    "a second callback that arrives while the first is at work leaves the whole order",
    {
      before: blockBookingAndRefund,
      booked: null,
      deliver: (shop, checkout) =>
        Promise.all([
          deliverPayment(shop, checkout),
          deliverPayment(shop, checkout),
        ]),
      failsLoudly: true,
      keeps: "order",
      refunded: [2000],
      statuses: [409, 503],
    },
  ],
  [
    "a replay writes the receipt that the first delivery failed to write",
    {
      before: async (shop, checkout) => {
        await deliverPayment(shop, checkout);
        await rewriteCheckoutBundle(tokenOf(checkout), orderOf(shop));
      },
      booked: BOOKED,
      deliver: once(),
      keeps: "receipt",
      refunded: [],
      statuses: [200],
    },
  ],
];

describeWithEnv("a settled sealed checkout order", { db: true }, () => {
  const { checkedOut } = useCardShop();

  for (const [name, outcome] of OUTCOMES) {
    test(name, async () => {
      const { checkout, opened } = await checkedOut();
      await outcome.before?.(opened, checkout);
      using _env = withEnv(
        outcome.failsLoudly ? { TEST_EXPECT_ERROR: "1" } : {},
      );

      const answers = await outcome.deliver(opened, checkout);

      expect(answers.map(({ status }) => status).toSorted()).toEqual(
        outcome.statuses,
      );
      expect(opened.fake.refunds).toEqual(
        outcome.refunded.map((amount) => ({
          amount,
          paymentIntent: checkout.paymentIntent,
        })),
      );
      const kept = outcome.keeps === "order" ? orderOf : receiptOf;
      expect(await stored(checkout)).toEqual(holding(kept(opened)));
      if (outcome.booked !== null) {
        expect(await rosterOf(opened)).toEqual(outcome.booked);
      }
    });
  }

  test("the receipt keeps the order's own thank-you link, and the return page offers it", async () => {
    const { checkout, opened } = await checkedOut();
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
    const { checkout, opened } = await checkedOut();
    await deliverPayment(opened, checkout);

    const sent = await returnPage(checkout);
    const page = await opened.owner.get(sent.location ?? "");

    expect(sent.status).toBe(302);
    expect(page.html).toContain(`href="${THANK_YOU_URL}"`);
  });
});
