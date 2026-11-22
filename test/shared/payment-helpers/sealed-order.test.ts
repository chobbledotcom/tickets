/** What a card provider stores for a checkout: a token, a listing, and a
 * proof. The order itself rests sealed in our database, so no provider cap can
 * refuse it. SumUp stages its own row, so its record is whole. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { hmacHash } from "#crypto/hashing.ts";
import { sealCheckoutBundle } from "#db/checkout-bundles.ts";
import { readSessionOrder } from "#routes/api/payment-processing/metadata.ts";
import type { BookingItem } from "#shared/booking-intent.ts";
import { priceCheckout } from "#shared/checkout-pricing.ts";
import { assembleCheckoutMetadata } from "#shared/payment-helpers.ts";
import { parsePriceProof, verifyPrice } from "#shared/payment-signature.ts";
import type { CheckoutIntent } from "#shared/payments.ts";
import { extractSessionMetadata } from "#shared/session-metadata.ts";
import { checkoutIntent, checkoutItem } from "#test-utils/checkout-items.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { wireMetadata } from "#test-utils/payment-session.ts";

const CARD_PROVIDERS = ["stripe", "square"] as const;

const withProof = async (
  intent: CheckoutIntent,
  provider: "stripe" | "square" | "sumup",
) => {
  const total = priceCheckout(intent).total;
  const wire = await assembleCheckoutMetadata(provider, intent, total);
  return { metadata: extractSessionMetadata(wireMetadata(wire)), total, wire };
};

describeWithEnv("sealed checkout order", { db: true }, () => {
  for (const provider of CARD_PROVIDERS) {
    test(`${provider} stores only a token, the first listing, and a proof`, async () => {
      const { wire } = await withProof(
        checkoutIntent({
          items: [
            checkoutItem({ listingId: 7 }),
            checkoutItem({ listingId: 9 }),
          ],
          phone: "07700900000",
        }),
        provider,
      );

      expect(Object.keys(wire).toSorted()).toEqual([
        "_origin",
        "bundle",
        "listing",
        "price_proof",
      ]);
      expect(wire.listing).toBe("7");
      expect(JSON.stringify(wire)).not.toContain("07700900000");
      expect(JSON.stringify(wire)).not.toContain("buyer@example.com");
    });

    test(`${provider} proof covers the token and the listing`, async () => {
      const { metadata, total } = await withProof(checkoutIntent(), provider);
      const proof = parsePriceProof(metadata.price_proof)!;

      expect(proof.total).toBe(total);
      expect(await verifyPrice(metadata, proof.total, proof.sig)).toBe(true);
      for (const changed of [{ bundle: "other-token" }, { listing: "8" }]) {
        expect(
          await verifyPrice(
            { ...metadata, ...changed },
            proof.total,
            proof.sig,
          ),
        ).toBe(false);
      }
    });

    test(`${provider} gives each checkout its own token`, async () => {
      const first = await withProof(checkoutIntent(), provider);
      const second = await withProof(checkoutIntent(), provider);

      expect(first.metadata.bundle).not.toBe(second.metadata.bundle);
    });

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

  test("sumup keeps the whole record, proof included, in its own staged row", async () => {
    const { metadata, total } = await withProof(
      checkoutIntent({ phone: "07700900000" }),
      "sumup",
    );
    const proof = parsePriceProof(metadata.price_proof)!;

    expect(metadata.bundle).toBe("");
    expect(metadata.phone).toBe("07700900000");
    expect(proof.total).toBe(total);
    expect(await verifyPrice(metadata, proof.total, proof.sig)).toBe(true);
  });

  test("hashes the renewal token before it rests anywhere", async () => {
    const { metadata } = await withProof(
      checkoutIntent({ siteToken: "plain-token-xyz" }),
      "sumup",
    );

    expect(metadata.site_token_index).toBe(await hmacHash("plain-token-xyz"));
    expect(JSON.stringify(metadata)).not.toContain("plain-token-xyz");
  });

  test("omits the renewal index when there is no renewal token", async () => {
    const { metadata } = await withProof(checkoutIntent(), "sumup");

    expect(metadata.site_token_index).toBe("");
  });
});
