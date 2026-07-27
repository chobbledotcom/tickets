// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { attendeesApi } from "#shared/db/attendees/api.ts";
import { getAttendeesRaw } from "#shared/db/attendees/queries.ts";
import { stripeApi } from "#shared/stripe.ts";
import { expectHtmlResponse } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  signedMeta,
  signMeta,
  singleItem,
  webhookMeta,
} from "#test-utils/factories.ts";
import { settleDeferredPaymentWork } from "#test-utils/maintenance.ts";
import { mockRequest, mockWebhookRequest } from "#test-utils/mocks.ts";
import {
  createAggregatePayment,
  requirePaymentAggregateByProviderSession,
} from "#test-utils/payment-aggregate.ts";
import { setupStripe, stubWebhookVerify } from "#test-utils/settings.ts";
import {
  checkoutSessionEvent,
  expectWebhookProcessed,
} from "#test-utils/webhooks.ts";

// jscpd:ignore-end

describeWithEnv("server webhooks > concurrent processing", { db: true }, () => {
  test("concurrent webhooks create one attendee and finalize one session", async () => {
    await setupStripe();

    const listing = await createTestListing({
      maxAttendees: 50,
      unitPrice: 1000,
    });

    const mockVerify = await stubWebhookVerify(
      checkoutSessionEvent({
        amountTotal: 1000,
        created: 1_700_000_000,
        eventId: "evt_concurrent",
        metadata: signedMeta(
          {
            email: "concurrent@example.com",
            items: singleItem(listing.id, 1, 1000),
            name: "Concurrent Webhook",
          },
          1000,
        ),
        paymentIntent: "pi_webhook_concurrent",
        sessionId: "cs_webhook_concurrent",
      }),
    );
    const createBooking = attendeesApi.createBookingAtomic;
    const bookingStarted = Promise.withResolvers<void>();
    const releaseBooking = Promise.withResolvers<void>();
    const pauseWinner = stub(
      attendeesApi,
      "createBookingAtomic",
      async (...args) => {
        bookingStarted.resolve();
        await releaseBooking.promise;
        return await createBooking(...args);
      },
    );

    try {
      const request = () =>
        handleRequest(
          mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
        );
      const responses = await Promise.all([
        request(),
        (async () => {
          await bookingStarted.promise;
          try {
            return await request();
          } finally {
            releaseBooking.resolve();
          }
        })(),
      ]);

      const [concurrent, winner] = responses.toSorted(
        (left, right) => right.status - left.status,
      );
      if (!winner || !concurrent) throw new Error("Expected two responses");
      expect(winner.status).toBe(200);
      expect(await winner.json()).toEqual({ processed: true, received: true });
      expect(concurrent.status).toBe(409);
      expect(await concurrent.text()).toContain("being processed");

      const attendees = await getAttendeesRaw(listing.id);
      expect(attendees).toHaveLength(1);
      // The winner's booking is finished off by maintenance.
      await settleDeferredPaymentWork();
      const payment = await requirePaymentAggregateByProviderSession(
        "cs_webhook_concurrent",
      );
      expect(payment.attendeeId).toBe(attendees[0]!.id);
      expect(payment.state).toBe("completed");
    } finally {
      releaseBooking.resolve();
      pauseWinner.restore();
      mockVerify.restore();
    }
  });

  test("multi-ticket being processed returns 409", async () => {
    await setupStripe();

    const listing = await createTestListing({
      maxAttendees: 50,
      name: "Multi Concurrent",
      unitPrice: 500,
    });

    await createAggregatePayment({
      charges: [{ amount: 500, reference: "pi_multi_concurrent" }],
      configuredAccount: true,
      paymentId: "payment_multi_concurrent",
      providerSessionId: "cs_multi_concurrent",
      state: "processing",
    });

    const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
      Promise.resolve({
        amount_total: 500,
        id: "cs_multi_concurrent",
        metadata: signMeta(
          webhookMeta({
            email: "concurrent@example.com",
            items: JSON.stringify([{ e: listing.id, p: 500, q: 1 }]),
            name: "Concurrent",
          }),
          500,
        ),
        payment_intent: "pi_multi_concurrent",
        payment_status: "paid",
      } as unknown as Awaited<
        ReturnType<typeof stripeApi.retrieveCheckoutSession>
      >),
    );

    try {
      const response = await handleRequest(
        mockRequest("/payment/success?session_id=cs_multi_concurrent"),
      );
      await expectHtmlResponse(response, 409, "being processed");
    } finally {
      mockRetrieve.restore();
    }
  });

  test("single-ticket being processed returns 409", async () => {
    await setupStripe();

    const listing = await createTestListing({
      maxAttendees: 50,
      unitPrice: 1000,
    });

    await createAggregatePayment({
      charges: [{ amount: 1_000, reference: "pi_single_concurrent" }],
      configuredAccount: true,
      paymentId: "payment_single_concurrent",
      providerSessionId: "cs_single_concurrent",
      state: "processing",
    });

    const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
      Promise.resolve({
        amount_total: 1000,
        id: "cs_single_concurrent",
        metadata: signMeta(
          webhookMeta({
            email: "concurrent@example.com",
            items: singleItem(listing.id, 1, 1000),
            name: "Concurrent",
          }),
          1000,
        ),
        payment_intent: "pi_single_concurrent",
        payment_status: "paid",
      } as unknown as Awaited<
        ReturnType<typeof stripeApi.retrieveCheckoutSession>
      >),
    );

    try {
      const response = await handleRequest(
        mockRequest("/payment/success?session_id=cs_single_concurrent"),
      );
      await expectHtmlResponse(response, 409, "being processed");
    } finally {
      mockRetrieve.restore();
    }
  });

  test("returns success for already-processed multi-ticket session", async () => {
    await setupStripe();

    const listing = await createTestListing({
      maxAttendees: 50,
      name: "Multi Already Done",
      unitPrice: 500,
    });
    // Create attendee directly (not via public form which redirects to Stripe for paid listings)
    const result = await bookAttendee(listing, {
      email: "already@example.com",
      name: "Already Done",
      paymentId: "pi_already_done",
      quantity: 1,
    });
    if (!result.success) throw new Error("Failed to create test attendee");
    const attendee = result.attendees[0]!;

    await createAggregatePayment({
      attendeeId: attendee.id,
      bookingIntent: {
        address: "",
        date: null,
        email: "already@example.com",
        items: [{ e: listing.id, p: 500, q: 1 }],
        modifiers: [],
        name: "Already Done",
        phone: "",
        special_instructions: "",
      },
      charges: [{ amount: 500, reference: "pi_already_done" }],
      configuredAccount: true,
      paymentId: "payment_multi_already_done",
      providerSessionId: "cs_multi_already_done",
      ticketTokens: [attendee.ticket_token],
    });

    await expectWebhookProcessed(
      checkoutSessionEvent({
        amountTotal: 500,
        created: 1_700_000_000,
        eventId: "evt_already_done",
        metadata: signedMeta(
          {
            email: "already@example.com",
            items: JSON.stringify([{ e: listing.id, p: 500, q: 1 }]),
            name: "Already Done",
          },
          500,
        ),
        paymentIntent: "pi_already_done",
        sessionId: "cs_multi_already_done",
      }),
    );
  });
});
