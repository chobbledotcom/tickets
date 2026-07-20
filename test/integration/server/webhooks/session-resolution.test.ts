// jscpd:ignore-start
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { signedMeta, singleItem, webhookMeta } from "#test-utils/factories.ts";
import { setupStripe } from "#test-utils/settings.ts";
import {
  checkoutSessionEvent,
  expectAttendeeWithPricePaid,
  expectWebhookIgnored,
  expectWebhookPending,
  expectWebhookProcessed,
  expectWebhookRejected,
} from "#test-utils/webhooks.ts";

// jscpd:ignore-end

describeWithEnv("server webhooks > session resolution", { db: true }, () => {
  test("webhook with checkout listing type but no extractable session acknowledges without processing", async () => {
    await setupStripe();

    // Listing type matches checkoutCompletedEventType but data lacks metadata
    // so extractSessionFromListing returns null (covers lines 498-500)
    // and data object has no id/order_id so sessionId is null (covers lines 597-602)
    // Returns 200 to prevent provider retries
    await expectWebhookIgnored({
      data: {
        object: {
          // No id, no order_id, no proper metadata
          some_field: "value",
        },
      },
      id: "evt_no_extract",
      type: "checkout.session.completed",
    });
  });

  test("webhook returns pending when resolveWebhookSession returns skip", async () => {
    await setupStripe();

    const { stripePaymentProvider } = await import(
      "#shared/stripe-provider.ts"
    );
    const mockResolve = stub(
      stripePaymentProvider,
      "resolveWebhookSession",
      () => Promise.resolve("skip" as const),
    );

    await expectWebhookPending(
      {
        data: { object: {} },
        id: "evt_skip",
        type: "checkout.session.completed",
      },
      () => {
        mockResolve.restore();
      },
    );
  });

  test("webhook acknowledges when resolveWebhookSession returns null", async () => {
    await setupStripe();

    const { stripePaymentProvider } = await import(
      "#shared/stripe-provider.ts"
    );
    const mockResolve = stub(
      stripePaymentProvider,
      "resolveWebhookSession",
      () => Promise.resolve(null),
    );

    // Returns 200 to prevent provider retries
    await expectWebhookIgnored(
      {
        data: { object: {} },
        id: "evt_null",
        type: "checkout.session.completed",
      },
      () => {
        mockResolve.restore();
      },
    );
  });

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
