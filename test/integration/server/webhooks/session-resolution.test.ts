// jscpd:ignore-start
import { it as test } from "@std/testing/bdd";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { signedMeta, singleItem, webhookMeta } from "#test-utils/factories.ts";
import { setupStripe } from "#test-utils/settings.ts";
import {
  checkoutSessionEvent,
  expectAttendeeWithPricePaid,
  expectWebhookProcessed,
  expectWebhookRejected,
} from "#test-utils/webhooks.ts";

// jscpd:ignore-end

describeWithEnv("server webhooks > session resolution", { db: true }, () => {
  test("webhook fails loudly for an invalid payment status", async () => {
    await setupStripe();

    const listing = await createTestListing({
      maxAttendees: 50,
      unitPrice: 1000,
    });

    await expectWebhookRejected(
      checkoutSessionEvent({
        amountTotal: 1000,
        eventId: "evt_bad_status",
        metadata: webhookMeta({
          email: "badstatus@example.com",
          items: singleItem(listing.id, 1, 1000),
          name: "Bad Status",
        }),
        paymentIntent: "pi_bad_status",
        paymentStatus: "completed",
        sessionId: "cs_bad_status",
      }),
      'Expected ("no_payment_required" | "paid" | "unpaid")',
    );
  });

  test("webhook extracts amount_total as number from listing data", async () => {
    await setupStripe();

    const listing = await createTestListing({
      maxAttendees: 50,
      unitPrice: 2500,
    });

    await expectWebhookProcessed(
      checkoutSessionEvent({
        amountTotal: 2500,
        eventId: "evt_amount_total",
        metadata: signedMeta(
          {
            email: "amount@example.com",
            items: singleItem(listing.id, 1, 2500),
            name: "Amount User",
          },
          2500,
        ),
        paymentIntent: "pi_amount_total",
        sessionId: "cs_amount_total",
      }),
    );

    await expectAttendeeWithPricePaid(listing.id, 2500);
  });
});
