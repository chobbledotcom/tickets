import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { processPaymentSession } from "#routes/api/payment-processing/index.ts";
import { modifiersTable } from "#shared/db/modifiers.ts";
import { getAllActivityLog } from "#test-utils/activity-log.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { expectModifierUsage } from "#test-utils/modifiers.ts";
import { bookingIntent, trustedPayment } from "./helpers.ts";

describeWithEnv("payment processing modifiers", { db: true }, () => {
  test("records and logs a code discount after the booking commits", async () => {
    const listing = await createTestListing({
      maxAttendees: 5,
      unitPrice: 1000,
    });
    const modifier = await modifiersTable.insert({
      calcKind: "fixed",
      calcValue: 1,
      direction: "discount",
      name: "DIRECT",
      trigger: "code",
    });
    const id = "cs_direct_code";
    const intent = bookingIntent([{ e: listing.id, p: 1000, q: 1 }], {
      modifiers: [{ i: modifier.id, q: 1 }],
    });

    expect(
      await processPaymentSession(id, trustedPayment(id, intent, 900)),
    ).toMatchObject({ listingId: listing.id, success: true });
    await expectModifierUsage(modifier.id, 100, {
      totalRevenue: -100,
      totalUses: 1,
      usageCount: 1,
    });
    expect((await getAllActivityLog()).map((entry) => entry.message)).toContain(
      "Promo code 'DIRECT' used: \u00a31 off",
    );
  });
});
