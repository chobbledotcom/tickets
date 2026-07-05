import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { modifiersTable } from "#shared/db/modifiers.ts";
import { resetStripeClient } from "#shared/stripe.ts";
import {
  checkoutSessionEvent,
  createTestListing,
  describeWithEnv,
  expectModifierUsage,
  expectWebhookProcessed,
  getAllActivityLog,
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

    await expectWebhookProcessed(
      checkoutSessionEvent({
        // £10 ticket minus £1 promo discount = £9.00.
        amountTotal: 900,
        eventId: "evt_promo_log",
        metadata: signedMeta(
          {
            email: "promo@example.com",
            items: singleItem(listing.id, 1, 1000),
            modifiers: JSON.stringify([{ i: modifier.id, q: 1 }]),
            name: "Promo Buyer",
          },
          900,
        ),
        paymentIntent: "pi_promo_log",
        sessionId: "cs_promo_log",
      }),
    );
    // EARLYBIRD is a discount: its ledger leg funds the attendee
    // (modifier→attendee), so balanceOf(modifier) — the projected revenue,
    // read directly — is negative, the modifier's true net effect.
    await expectModifierUsage(modifier.id, 100, {
      totalRevenue: -100,
      totalUses: 1,
      usageCount: 1,
    });
    const log = await getAllActivityLog();
    expect(
      log.some((e) => e.message === "Promo code 'EARLYBIRD' used: £1 off"),
    ).toBe(true);
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

    await expectWebhookProcessed(
      checkoutSessionEvent({
        // £10 ticket + £1 promo surcharge = £11.00.
        amountTotal: 1100,
        eventId: "evt_promo_surcharge",
        metadata: signedMeta(
          {
            email: "surcharge@example.com",
            items: singleItem(listing.id, 1, 1000),
            modifiers: JSON.stringify([{ i: modifier.id, q: 1 }]),
            name: "Surcharge Buyer",
          },
          1100,
        ),
        paymentIntent: "pi_promo_surcharge",
        sessionId: "cs_promo_surcharge",
      }),
    );
    await expectModifierUsage(modifier.id, 100, {
      totalRevenue: 100,
      totalUses: 1,
      usageCount: 1,
    });
    const log = await getAllActivityLog();
    expect(
      log.some((e) => e.message === "Promo code 'PREMIUM' used: +£1"),
    ).toBe(true);
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

    await expectWebhookProcessed(
      checkoutSessionEvent({
        // £10 ticket multiplied by 0.8 = £8.00.
        amountTotal: 800,
        eventId: "evt_promo_multiplier",
        metadata: signedMeta(
          {
            email: "multiplier@example.com",
            items: singleItem(listing.id, 1, 1000),
            modifiers: JSON.stringify([{ i: modifier.id, q: 1 }]),
            name: "Multiplier Buyer",
          },
          800,
        ),
        paymentIntent: "pi_promo_multiplier",
        sessionId: "cs_promo_multiplier",
      }),
    );
    const log = await getAllActivityLog();
    expect(
      log.some((e) => e.message === "Promo code 'MULTI20' used: £2 off"),
    ).toBe(true);
  });
});
