/**
 * Contract for the paid-order driver's signed metadata. The money stories rely
 * on an order carrying its extra charges all the way through the real payment
 * return, so if the driver silently dropped them a story could "pass" while
 * proving nothing about charges.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { modifierAccount } from "#shared/accounting/accounts.ts";
import { accountBalance } from "#shared/accounting/queries.ts";
import { getAttendeesRaw } from "#shared/db/attendees/queries.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { insertModifier } from "#test-utils/modifiers.ts";
import { runStripeSuccess } from "#test-utils/money/drivers.ts";
import { setupStripe } from "#test-utils/settings.ts";

describeWithEnv("money drivers", { db: true }, () => {
  test("an order's extra charge reaches the site and earns its own money", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 5,
      name: "Driver Talk",
      unitPrice: 5000,
    });
    const modifier = await insertModifier({
      calcKind: "percent",
      calcValue: 10,
      name: "Driver charge",
    });

    // £50 place plus a 10% charge — the signed total must match what the site
    // re-derives, or the payment is refunded instead of booked.
    await runStripeSuccess({
      email: "driver@example.com",
      items: JSON.stringify([{ e: listing.id, p: 5000, q: 1 }]),
      modifiers: [{ i: modifier.id, q: 1 }],
      name: "Driver Buyer",
      paymentIntent: "pi_driver",
      sessionId: "cs_driver",
      total: 5500,
    });

    // The booking exists and the charge earned its 10%, which only happens if
    // the driver carried the modifier through in the signed metadata.
    expect((await getAttendeesRaw(listing.id)).length).toBe(1);
    expect(await accountBalance(modifierAccount(modifier.id))).toBe(500);
  });
});
