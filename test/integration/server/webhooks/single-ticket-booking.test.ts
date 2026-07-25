// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { signedMeta, singleItem } from "#test-utils/factories.ts";
import { setupStripe } from "#test-utils/settings.ts";
import {
  checkoutSessionEvent,
  expectWebhookProcessed,
} from "#test-utils/webhooks.ts";

// jscpd:ignore-end

describeWithEnv("server webhooks > single-ticket booking", { db: true }, () => {
  test("dates booking ledger legs from the checkout time, not now", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 50,
      unitPrice: 1000,
    });

    // Stripe stamps `created` (Unix seconds) when the checkout is made. Even a
    // webhook that arrives a day late must book the revenue on the day the
    // customer paid, so every leg takes its occurredAt from `created`.
    const created = Math.floor(Date.parse("2026-06-19T08:00:00.000Z") / 1000);
    await expectWebhookProcessed(
      checkoutSessionEvent({
        amountTotal: 1000,
        created,
        eventId: "evt_ledger_time",
        metadata: signedMeta(
          {
            email: "ledgertime@example.com",
            items: singleItem(listing.id, 1, 1000),
            name: "Ledger Time",
          },
          1000,
        ),
        paymentIntent: "pi_ledger_time",
        sessionId: "cs_ledger_time",
      }),
    );

    const { getAttendeesRaw } = await import("#shared/db/attendees/queries.ts");
    const { attendeeAccount } = await import("#shared/accounting/accounts.ts");
    const { transfersByAccount } = await import(
      "#shared/accounting/queries.ts"
    );
    const attendees = await getAttendeesRaw(listing.id);
    const legs = await transfersByAccount(attendeeAccount(attendees[0]!.id));
    const expected = new Date(created * 1000).toISOString();
    expect(legs.length).toBeGreaterThan(0);
    for (const leg of legs) {
      expect(leg.occurredAt).toBe(expected);
    }
  });
});
