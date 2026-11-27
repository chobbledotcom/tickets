/** Reading a sealed order back: the token in the provider's metadata opens
 * the whole order, whatever its size. A token with no row is a lost order,
 * and a row that holds no booking is unreadable. The record that the
 * provider stores is checked in
 * test/shared/payment-helpers/sealed-order.test.ts. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { sealCheckoutBundle } from "#db/checkout-bundles.ts";
import { readSessionOrder } from "#routes/api/payment-processing/metadata.ts";
import type { BookingItem } from "#shared/booking-intent.ts";
import { checkoutIntent, checkoutItem } from "#test-utils/checkout-items.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { CARD_PROVIDERS, withProof } from "#test-utils/sealed-checkout.ts";

describeWithEnv("reading a sealed checkout order", { db: true }, () => {
  for (const provider of CARD_PROVIDERS) {
    test(`${provider} opens the whole order from its token`, async () => {
      const intent = checkoutIntent({
        address: "12 Some Street",
        date: "2026-08-01",
        dayCount: 3,
        phone: "07700900000",
        reservationAmount: "10%",
        special_instructions: "Leave at the front desk",
      });
      const { metadata } = await withProof(intent, provider);

      const order = await readSessionOrder({ metadata });

      expect(order).toMatchObject({
        intent: {
          address: "12 Some Street",
          date: "2026-08-01",
          dayCount: 3,
          email: "buyer@example.com",
          name: "Buyer",
          phone: "07700900000",
          reservationAmount: "10%",
          special_instructions: "Leave at the front desk",
        },
        status: "read",
      });
    });

    test(`${provider} carries an order no provider cap would take`, async () => {
      const listingIds = Array.from({ length: 80 }, (_, index) => index + 1);
      const intent = checkoutIntent({
        items: listingIds.map((listingId) => checkoutItem({ listingId })),
        listingAnswerIds: Object.fromEntries(
          listingIds.map((id) => [String(id), [id, id + 1000, id + 2000]]),
        ),
        thankYouUrl: `https://example.com/${"thanks/".repeat(200)}`,
      });
      const { metadata } = await withProof(intent, provider);

      const order = await readSessionOrder({ metadata });

      expect(order.status).toBe("read");
      if (order.status !== "read") return;
      expect(order.intent.items).toHaveLength(80);
      expect(order.intent.thankYouUrl).toBe(intent.thankYouUrl);
      expect(Object.keys(order.intent.listingAnswerIds!)).toHaveLength(80);
    });

    test(`${provider} keeps each package line's edge tag`, async () => {
      const intent = checkoutIntent({
        allocations: [{ childId: 91, parentId: 11, qty: 2 }],
        items: [
          checkoutItem({
            listingId: 11,
            packageGroupId: 42,
            quantity: 2,
            unitPrice: 1234,
          }),
          checkoutItem({ listingId: 91, quantity: 2, unitPrice: 0 }),
        ],
      });
      const { metadata } = await withProof(intent, provider);

      const order = await readSessionOrder({ metadata });

      expect(order.status).toBe("read");
      if (order.status !== "read") return;
      const lines: BookingItem[] = order.intent.items;
      expect(lines.find((line) => line.e === 11)).toEqual({
        e: 11,
        k: "p",
        p: 2468,
        q: 2,
        r: 42,
      });
      expect(lines.find((line) => line.e === 91)).toEqual({
        e: 91,
        p: 0,
        q: 2,
      });
    });
  }

  test("a missing token reads as a lost order, never as no booking", async () => {
    const { metadata } = await withProof(checkoutIntent(), "stripe");

    expect(
      await readSessionOrder({
        metadata: { ...metadata, bundle: "never-sealed" },
      }),
    ).toEqual({
      status: "bundle_missing",
    });
  });

  test("a sealed record that holds no buyer or lines reads as no booking", async () => {
    const bundle = await sealCheckoutBundle({ email: "only@example.com" });
    const { metadata } = await withProof(checkoutIntent(), "stripe");

    expect(
      await readSessionOrder({ metadata: { ...metadata, bundle } }),
    ).toEqual({ status: "unreadable" });
  });
});
