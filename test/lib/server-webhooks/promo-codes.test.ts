import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { modifiersTable } from "#shared/db/modifiers.ts";
import { resetStripeClient } from "#shared/stripe.ts";
import {
  assertJson,
  createTestListing,
  describeWithEnv,
  getAllActivityLog,
  mockWebhookRequest,
  modifierAggregates,
  modifierUsageAmount,
  setupStripe,
  signedMeta,
  singleItem,
} from "#test-utils";

describeWithEnv("server webhooks > promo codes", { db: true }, () => {
  afterEach(() => {
    resetStripeClient();
  });

  test("logs a promo code usage when a code-triggered modifier is applied", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 50,
      unitPrice: 1000,
    });
    const modifier = await modifiersTable.insert({
      calcKind: "fixed",
      calcValue: 1,
      direction: "discount",
      name: "EARLYBIRD",
      trigger: "code",
    });

    const { stripePaymentProvider } = await import(
      "#shared/stripe-provider.ts"
    );
    const mockVerify = stub(
      stripePaymentProvider,
      "verifyWebhookSignature",
      () =>
        Promise.resolve({
          listing: {
            data: {
              object: {
                // £10 ticket minus £1 promo discount = £9.00.
                amount_total: 900,
                id: "cs_promo_log",
                metadata: signedMeta(
                  {
                    email: "promo@example.com",
                    items: singleItem(listing.id, 1, 1000),
                    modifiers: JSON.stringify([{ i: modifier.id, q: 1 }]),
                    name: "Promo Buyer",
                  },
                  900,
                ),
                payment_intent: "pi_promo_log",
                payment_status: "paid",
              },
            },
            id: "evt_promo_log",
            type: "checkout.session.completed",
          },
          valid: true,
        }),
    );

    try {
      await assertJson(
        handleRequest(
          mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
        ),
        200,
        (json) => {
          expect(json.processed).toBe(true);
        },
      );
      expect(await modifierUsageAmount(modifier.id)).toBe(100);
      // EARLYBIRD is a discount: its ledger leg funds the attendee
      // (modifier→attendee), so balanceOf(modifier) — the projected revenue,
      // read directly — is negative, the modifier's true net effect.
      expect(await modifierAggregates(modifier.id)).toEqual({
        totalRevenue: -100,
        totalUses: 1,
        usageCount: 1,
      });
      const log = await getAllActivityLog();
      expect(
        log.some((e) => e.message === "Promo code 'EARLYBIRD' used: £1 off"),
      ).toBe(true);
    } finally {
      mockVerify.restore();
    }
  });

  test("logs a promo code surcharge with a + prefix", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 50,
      unitPrice: 1000,
    });
    const modifier = await modifiersTable.insert({
      calcKind: "fixed",
      calcValue: 1,
      direction: "charge",
      name: "PREMIUM",
      trigger: "code",
    });

    const { stripePaymentProvider } = await import(
      "#shared/stripe-provider.ts"
    );
    const mockVerify = stub(
      stripePaymentProvider,
      "verifyWebhookSignature",
      () =>
        Promise.resolve({
          listing: {
            data: {
              object: {
                // £10 ticket + £1 promo surcharge = £11.00.
                amount_total: 1100,
                id: "cs_promo_surcharge",
                metadata: signedMeta(
                  {
                    email: "surcharge@example.com",
                    items: singleItem(listing.id, 1, 1000),
                    modifiers: JSON.stringify([{ i: modifier.id, q: 1 }]),
                    name: "Surcharge Buyer",
                  },
                  1100,
                ),
                payment_intent: "pi_promo_surcharge",
                payment_status: "paid",
              },
            },
            id: "evt_promo_surcharge",
            type: "checkout.session.completed",
          },
          valid: true,
        }),
    );

    try {
      await assertJson(
        handleRequest(
          mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
        ),
        200,
        (json) => {
          expect(json.processed).toBe(true);
        },
      );
      expect(await modifierUsageAmount(modifier.id)).toBe(100);
      expect(await modifierAggregates(modifier.id)).toEqual({
        totalRevenue: 100,
        totalUses: 1,
        usageCount: 1,
      });
      const log = await getAllActivityLog();
      expect(
        log.some((e) => e.message === "Promo code 'PREMIUM' used: +£1"),
      ).toBe(true);
    } finally {
      mockVerify.restore();
    }
  });

  test("logs a multiplier promo code discount", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 50,
      unitPrice: 1000,
    });
    const modifier = await modifiersTable.insert({
      calcKind: "multiply",
      calcValue: 0.8,
      direction: "discount",
      name: "MULTI20",
      trigger: "code",
    });

    const { stripePaymentProvider } = await import(
      "#shared/stripe-provider.ts"
    );
    const mockVerify = stub(
      stripePaymentProvider,
      "verifyWebhookSignature",
      () =>
        Promise.resolve({
          listing: {
            data: {
              object: {
                // £10 ticket multiplied by 0.8 = £8.00.
                amount_total: 800,
                id: "cs_promo_multiplier",
                metadata: signedMeta(
                  {
                    email: "multiplier@example.com",
                    items: singleItem(listing.id, 1, 1000),
                    modifiers: JSON.stringify([{ i: modifier.id, q: 1 }]),
                    name: "Multiplier Buyer",
                  },
                  800,
                ),
                payment_intent: "pi_promo_multiplier",
                payment_status: "paid",
              },
            },
            id: "evt_promo_multiplier",
            type: "checkout.session.completed",
          },
          valid: true,
        }),
    );

    try {
      await assertJson(
        handleRequest(
          mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
        ),
        200,
        (json) => {
          expect(json.processed).toBe(true);
        },
      );
      const log = await getAllActivityLog();
      expect(
        log.some((e) => e.message === "Promo code 'MULTI20' used: £2 off"),
      ).toBe(true);
    } finally {
      mockVerify.restore();
    }
  });
});
