// jscpd:ignore-start
import { it as test } from "@std/testing/bdd";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { signedMeta, singleItem } from "#test-utils/factories.ts";
import { setupStripe } from "#test-utils/settings.ts";
import {
  checkoutSessionEvent,
  expectWebhookIgnored,
  expectWebhookPending,
} from "#test-utils/webhooks.ts";

// jscpd:ignore-end

describeWithEnv(
  "server webhooks > acknowledging edge-case sessions",
  { db: true },
  () => {
    // An event we have nothing to act on (any type the provider does not turn
    // into a payment notice) is acknowledged so the provider stops retrying.
    test("acknowledges an event that carries no payment notice", async () => {
      await setupStripe();

      await expectWebhookIgnored(null);
    });

    test("acknowledges webhook with unrecognized session metadata", async () => {
      await setupStripe();

      // Returns 200 to prevent provider retries
      await expectWebhookIgnored(
        checkoutSessionEvent({
          amountTotal: 0,
          eventId: "evt_test",
          metadata: {}, // Missing required fields — not our session
          paymentIntent: "pi_unrecognized",
          sessionId: "cs_test",
        }),
      );
    });

    test("acknowledges unpaid checkout without processing", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        unitPrice: 1000,
      });

      await expectWebhookPending(
        checkoutSessionEvent({
          amountTotal: 1000,
          eventId: "evt_test",
          // Signed, so the checkout is provably ours and its unpaid state is
          // what decides the outcome.
          metadata: signedMeta(
            {
              email: "john@example.com",
              items: singleItem(listing.id, 1, 1000),
              name: "John",
            },
            1000,
          ),
          paymentIntent: "pi_test",
          paymentStatus: "unpaid",
          sessionId: "cs_test",
        }),
      );
    });
  },
);
