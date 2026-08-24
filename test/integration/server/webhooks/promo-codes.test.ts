// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { modifiersTable } from "#db/modifiers.ts";
import { getAllActivityLog } from "#test-utils/activity-log.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { signedMeta, singleItem } from "#test-utils/factories.ts";
import { expectModifierUsage } from "#test-utils/modifiers.ts";
import { setupStripe } from "#test-utils/settings.ts";
import {
  checkoutSessionEvent,
  expectWebhookProcessed,
} from "#test-utils/webhooks.ts";

// jscpd:ignore-end

/** A £1 fixed code-triggered modifier — every promo-code test below books the
 *  same £10 listing against one of these, varying only the direction/name. */
const createFixedPromoModifier = (
  direction: "charge" | "discount",
  name: string,
) =>
  modifiersTable.insert({
    calcKind: "fixed",
    calcValue: 1,
    direction,
    name,
    trigger: "code",
  });

describeWithEnv("server webhooks > promo codes", { db: true }, () => {
  test("logs a promo code usage when a code-triggered modifier is applied", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 50,
      unitPrice: 1000,
    });
    const modifier = await createFixedPromoModifier("discount", "EARLYBIRD");

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
    const modifier = await createFixedPromoModifier("charge", "PREMIUM");

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
