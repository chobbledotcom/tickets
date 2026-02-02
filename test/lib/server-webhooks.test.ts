import { afterEach, beforeEach, describe, expect, spyOn, test } from "#test-compat";
import { resetStripeClient, stripeApi } from "#lib/stripe.ts";
import { handleRequest } from "#routes";
import { createAttendeeAtomic } from "#lib/db/attendees.ts";
import {
  createTestDbWithSetup,
  createTestEvent,
  deactivateTestEvent,
  mockRequest,
  mockWebhookRequest,
  resetDb,
  resetTestSlugCounter,
  setupStripe,
} from "#test-utils";

describe("server (webhooks)", () => {
  beforeEach(async () => {
    resetTestSlugCounter();
    await createTestDbWithSetup();
  });

  afterEach(() => {
    resetDb();
  });

  describe("POST /payment/webhook", () => {
    afterEach(() => {
      resetStripeClient();
    });

    test("returns 400 when no provider configured", async () => {
      const response = await handleRequest(
        mockWebhookRequest(
          { type: "checkout.session.completed" },
          { "stripe-signature": "sig_test" },
        ),
      );
      expect(response.status).toBe(400);
      const text = await response.text();
      expect(text).toContain("Payment provider not configured");
    });

    test("returns 400 when signature header is missing", async () => {
      await setupStripe();

      const response = await handleRequest(
        mockWebhookRequest(
          { type: "checkout.session.completed" },
        ),
      );
      expect(response.status).toBe(400);
      const text = await response.text();
      expect(text).toContain("Missing signature");
    });

    test("returns 400 when signature verification fails", async () => {
      await setupStripe();

      const { stripePaymentProvider } = await import("#lib/stripe-provider.ts");
      const mockVerify = spyOn(stripePaymentProvider, "verifyWebhookSignature");
      mockVerify.mockResolvedValue({ valid: false, error: "Invalid signature" });

      try {
        const response = await handleRequest(
          mockWebhookRequest(
            {},
            { "stripe-signature": "sig_bad" },
          ),
        );
        expect(response.status).toBe(400);
        const text = await response.text();
        expect(text).toContain("Invalid signature");
      } finally {
        mockVerify.mockRestore();
      }
    });

    test("acknowledges non-checkout events", async () => {
      await setupStripe();

      const { stripePaymentProvider } = await import("#lib/stripe-provider.ts");
      const mockVerify = spyOn(stripePaymentProvider, "verifyWebhookSignature");
      mockVerify.mockResolvedValue({
        valid: true,
        event: {
          id: "evt_test",
          type: "payment_intent.created",
          data: { object: {} },
        },
      });

      try {
        const response = await handleRequest(
          mockWebhookRequest(
            {},
            { "stripe-signature": "sig_valid" },
          ),
        );
        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json.received).toBe(true);
      } finally {
        mockVerify.mockRestore();
      }
    });

    test("returns 400 for invalid session data in webhook", async () => {
      await setupStripe();

      const { stripePaymentProvider } = await import("#lib/stripe-provider.ts");
      const mockVerify = spyOn(stripePaymentProvider, "verifyWebhookSignature");
      mockVerify.mockResolvedValue({
        valid: true,
        event: {
          id: "evt_test",
          type: "checkout.session.completed",
          data: {
            object: {
              id: "cs_test",
              payment_status: "paid",
              metadata: {}, // Missing required fields
            },
          },
        },
      });

      try {
        const response = await handleRequest(
          mockWebhookRequest(
            {},
            { "stripe-signature": "sig_valid" },
          ),
        );
        expect(response.status).toBe(400);
        const text = await response.text();
        expect(text).toContain("Invalid session data");
      } finally {
        mockVerify.mockRestore();
      }
    });

    test("acknowledges unpaid checkout without processing", async () => {
      await setupStripe();

      const event = await createTestEvent({
        maxAttendees: 50,
        unitPrice: 1000,
      });

      const { stripePaymentProvider } = await import("#lib/stripe-provider.ts");
      const mockVerify = spyOn(stripePaymentProvider, "verifyWebhookSignature");
      mockVerify.mockResolvedValue({
        valid: true,
        event: {
          id: "evt_test",
          type: "checkout.session.completed",
          data: {
            object: {
              id: "cs_test",
              payment_status: "unpaid",
              payment_intent: "pi_test",
              metadata: {
                event_id: String(event.id),
                name: "John",
                email: "john@example.com",
                quantity: "1",
              },
            },
          },
        },
      });

      try {
        const response = await handleRequest(
          mockWebhookRequest(
            {},
            { "stripe-signature": "sig_valid" },
          ),
        );
        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json.received).toBe(true);
        expect(json.status).toBe("pending");
      } finally {
        mockVerify.mockRestore();
      }
    });

    test("processes valid single-ticket webhook and creates attendee", async () => {
      await setupStripe();

      const event = await createTestEvent({
        maxAttendees: 50,
        unitPrice: 1000,
      });

      const { stripePaymentProvider } = await import("#lib/stripe-provider.ts");
      const mockVerify = spyOn(stripePaymentProvider, "verifyWebhookSignature");
      mockVerify.mockResolvedValue({
        valid: true,
        event: {
          id: "evt_test",
          type: "checkout.session.completed",
          data: {
            object: {
              id: "cs_webhook_test",
              payment_status: "paid",
              payment_intent: "pi_webhook_test",
              metadata: {
                event_id: String(event.id),
                name: "Webhook User",
                email: "webhook@example.com",
                quantity: "1",
              },
            },
          },
        },
      });

      try {
        const response = await handleRequest(
          mockWebhookRequest(
            {},
            { "stripe-signature": "sig_valid" },
          ),
        );
        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json.received).toBe(true);
        expect(json.processed).toBe(true);

        // Verify attendee was created
        const { getAttendeesRaw } = await import("#lib/db/attendees.ts");
        const attendees = await getAttendeesRaw(event.id);
        expect(attendees.length).toBe(1);
        expect(attendees[0]?.payment_id).not.toBeNull();
      } finally {
        mockVerify.mockRestore();
      }
    });

    test("processes valid multi-ticket webhook and creates attendees", async () => {
      await setupStripe();

      const event1 = await createTestEvent({
        name: "Webhook Multi 1",
        maxAttendees: 50,
        unitPrice: 500,
      });
      const event2 = await createTestEvent({
        name: "Webhook Multi 2",
        maxAttendees: 50,
        unitPrice: 1000,
      });

      const { stripePaymentProvider } = await import("#lib/stripe-provider.ts");
      const mockVerify = spyOn(stripePaymentProvider, "verifyWebhookSignature");
      mockVerify.mockResolvedValue({
        valid: true,
        event: {
          id: "evt_multi",
          type: "checkout.session.completed",
          data: {
            object: {
              id: "cs_multi_webhook",
              payment_status: "paid",
              payment_intent: "pi_multi_webhook",
              metadata: {
                name: "Multi User",
                email: "multi@example.com",
                phone: "123456",
                multi: "1",
                items: JSON.stringify([
                  { e: event1.id, q: 2 },
                  { e: event2.id, q: 1 },
                ]),
              },
            },
          },
        },
      });

      try {
        const response = await handleRequest(
          mockWebhookRequest(
            {},
            { "stripe-signature": "sig_valid" },
          ),
        );
        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json.received).toBe(true);
        expect(json.processed).toBe(true);

        // Verify attendees were created for both events
        const { getAttendeesRaw } = await import("#lib/db/attendees.ts");
        const attendees1 = await getAttendeesRaw(event1.id);
        const attendees2 = await getAttendeesRaw(event2.id);
        expect(attendees1.length).toBe(1);
        expect(attendees1[0]?.quantity).toBe(2);
        expect(attendees2.length).toBe(1);
        expect(attendees2[0]?.quantity).toBe(1);
      } finally {
        mockVerify.mockRestore();
      }
    });

    test("webhook returns error for invalid multi-ticket items", async () => {
      await setupStripe();

      const { stripePaymentProvider } = await import("#lib/stripe-provider.ts");
      const mockVerify = spyOn(stripePaymentProvider, "verifyWebhookSignature");
      mockVerify.mockResolvedValue({
        valid: true,
        event: {
          id: "evt_bad_multi",
          type: "checkout.session.completed",
          data: {
            object: {
              id: "cs_bad_multi",
              payment_status: "paid",
              payment_intent: "pi_bad",
              metadata: {
                name: "Bad Multi",
                email: "bad@example.com",
                multi: "1",
                items: "not-valid-json{",
              },
            },
          },
        },
      });

      try {
        const response = await handleRequest(
          mockWebhookRequest(
            {},
            { "stripe-signature": "sig_valid" },
          ),
        );
        expect(response.status).toBe(400);
        const text = await response.text();
        expect(text).toContain("Invalid multi-ticket session data");
      } finally {
        mockVerify.mockRestore();
      }
    });

    test("webhook handles sold-out event and returns error in JSON", async () => {
      await setupStripe();

      const event = await createTestEvent({
        maxAttendees: 1,
        unitPrice: 1000,
      });

      // Fill the event
      await createAttendeeAtomic(event.id, "First", "first@example.com", "pi_first");

      const { stripePaymentProvider } = await import("#lib/stripe-provider.ts");
      const mockVerify = spyOn(stripePaymentProvider, "verifyWebhookSignature");
      mockVerify.mockResolvedValue({
        valid: true,
        event: {
          id: "evt_soldout",
          type: "checkout.session.completed",
          data: {
            object: {
              id: "cs_soldout",
              payment_status: "paid",
              payment_intent: "pi_soldout",
              metadata: {
                event_id: String(event.id),
                name: "Late Buyer",
                email: "late@example.com",
                quantity: "1",
              },
            },
          },
        },
      });

      const mockRefund = spyOn(stripeApi, "refundPayment");
      mockRefund.mockResolvedValue({ id: "re_test" } as unknown as Awaited<
        ReturnType<typeof stripeApi.refundPayment>
      >);

      try {
        const response = await handleRequest(
          mockWebhookRequest(
            {},
            { "stripe-signature": "sig_valid" },
          ),
        );
        // Webhook returns 200 even for business logic failures to prevent retries
        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json.received).toBe(true);
        expect(json.processed).toBe(false);
        expect(json.error).toContain("sold out");
      } finally {
        mockVerify.mockRestore();
        mockRefund.mockRestore();
      }
    });

    test("webhook rejects POST with wrong content-type", async () => {
      const response = await handleRequest(
        new Request("http://localhost/payment/webhook", {
          method: "POST",
          headers: {
            host: "localhost",
            "content-type": "application/x-www-form-urlencoded",
            "stripe-signature": "sig_test",
          },
          body: "test=123",
        }),
      );
      expect(response.status).toBe(400);
      const text = await response.text();
      expect(text).toContain("Invalid Content-Type");
    });
  });

  describe("routes/webhooks.ts (additional coverage)", () => {
    afterEach(() => {
      resetStripeClient();
    });

    test("extractIntent defaults quantity to 1 when missing", async () => {
      await setupStripe();

      const event = await createTestEvent({
        maxAttendees: 50,
        unitPrice: 1000,
      });

      const mockRetrieve = spyOn(stripeApi, "retrieveCheckoutSession");
      mockRetrieve.mockResolvedValue({
        id: "cs_no_qty",
        payment_status: "paid",
        payment_intent: "pi_no_qty",
        metadata: {
          event_id: String(event.id),
          name: "John",
          email: "john@example.com",
          // quantity intentionally omitted
        },
      } as unknown as Awaited<
        ReturnType<typeof stripeApi.retrieveCheckoutSession>
      >);

      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_no_qty"),
        );
        expect(response.status).toBe(200);

        // Verify attendee was created with quantity 1
        const { getAttendeesRaw } = await import("#lib/db/attendees.ts");
        const attendees = await getAttendeesRaw(event.id);
        expect(attendees.length).toBe(1);
        expect(attendees[0]?.quantity).toBe(1);
      } finally {
        mockRetrieve.mockRestore();
      }
    });

    test("tryRefund returns false when paymentReference is null", async () => {
      await setupStripe();

      const event = await createTestEvent({
        maxAttendees: 50,
        unitPrice: 1000,
      });
      await deactivateTestEvent(event.id);

      const mockRetrieve = spyOn(stripeApi, "retrieveCheckoutSession");
      mockRetrieve.mockResolvedValue({
        id: "cs_null_ref",
        payment_status: "paid",
        payment_intent: null, // No payment reference
        metadata: {
          event_id: String(event.id),
          name: "John",
          email: "john@example.com",
          quantity: "1",
        },
      } as unknown as Awaited<
        ReturnType<typeof stripeApi.retrieveCheckoutSession>
      >);

      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_null_ref"),
        );
        expect(response.status).toBe(400);
        const html = await response.text();
        expect(html).toContain("no longer accepting registrations");
        // Should show "contact support" since refund failed (no payment reference)
        expect(html).toContain("contact support");
      } finally {
        mockRetrieve.mockRestore();
      }
    });

    test("webhook extracts payment_intent as paymentReference", async () => {
      await setupStripe();

      const event = await createTestEvent({
        maxAttendees: 50,
        unitPrice: 1000,
      });

      const { stripePaymentProvider } = await import("#lib/stripe-provider.ts");
      const mockVerify = spyOn(stripePaymentProvider, "verifyWebhookSignature");
      mockVerify.mockResolvedValue({
        valid: true,
        event: {
          id: "evt_pi_extract",
          type: "checkout.session.completed",
          data: {
            object: {
              id: "cs_pi_extract",
              payment_status: "paid",
              payment_intent: "pi_extracted_ref",
              metadata: {
                event_id: String(event.id),
                name: "PI User",
                email: "pi@example.com",
                quantity: "1",
              },
            },
          },
        },
      });

      try {
        const response = await handleRequest(
          mockWebhookRequest(
            {},
            { "stripe-signature": "sig_valid" },
          ),
        );
        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json.processed).toBe(true);

        // Verify attendee has the payment reference
        const { getAttendeesRaw } = await import("#lib/db/attendees.ts");
        const attendees = await getAttendeesRaw(event.id);
        expect(attendees.length).toBe(1);
        expect(attendees[0]?.payment_id).not.toBeNull();
      } finally {
        mockVerify.mockRestore();
      }
    });

    test("webhook with non-array items in multi-ticket returns null", async () => {
      await setupStripe();

      const { stripePaymentProvider } = await import("#lib/stripe-provider.ts");
      const mockVerify = spyOn(stripePaymentProvider, "verifyWebhookSignature");
      mockVerify.mockResolvedValue({
        valid: true,
        event: {
          id: "evt_non_array",
          type: "checkout.session.completed",
          data: {
            object: {
              id: "cs_non_array",
              payment_status: "paid",
              payment_intent: "pi_non_array",
              metadata: {
                name: "Test",
                email: "test@example.com",
                multi: "1",
                items: '{"not":"an-array"}', // Valid JSON but not an array
              },
            },
          },
        },
      });

      try {
        const response = await handleRequest(
          mockWebhookRequest(
            {},
            { "stripe-signature": "sig_valid" },
          ),
        );
        expect(response.status).toBe(400);
        const text = await response.text();
        expect(text).toContain("Invalid multi-ticket session data");
      } finally {
        mockVerify.mockRestore();
      }
    });

    test("webhook with missing items in multi-ticket metadata returns null", async () => {
      await setupStripe();

      const { stripePaymentProvider } = await import("#lib/stripe-provider.ts");
      const mockVerify = spyOn(stripePaymentProvider, "verifyWebhookSignature");
      mockVerify.mockResolvedValue({
        valid: true,
        event: {
          id: "evt_no_items",
          type: "checkout.session.completed",
          data: {
            object: {
              id: "cs_no_items",
              payment_status: "paid",
              payment_intent: "pi_no_items",
              metadata: {
                name: "Test",
                email: "test@example.com",
                multi: "1",
                items: "", // empty string: isMultiSession returns true but extractMultiIntent returns null
              },
            },
          },
        },
      });

      try {
        const response = await handleRequest(
          mockWebhookRequest(
            {},
            { "stripe-signature": "sig_valid" },
          ),
        );
        expect(response.status).toBe(400);
        const text = await response.text();
        expect(text).toContain("Invalid multi-ticket session data");
      } finally {
        mockVerify.mockRestore();
      }
    });

    test("multi-ticket being processed returns 409", async () => {
      await setupStripe();

      const event = await createTestEvent({
        name: "Multi Concurrent",
        maxAttendees: 50,
        unitPrice: 500,
      });

      // Pre-reserve the session to simulate concurrent processing
      const { reserveSession: reserveSessionFn } = await import("#lib/db/processed-payments.ts");
      await reserveSessionFn("cs_multi_concurrent");

      const mockRetrieve = spyOn(stripeApi, "retrieveCheckoutSession");
      mockRetrieve.mockResolvedValue({
        id: "cs_multi_concurrent",
        payment_status: "paid",
        payment_intent: "pi_multi_concurrent",
        metadata: {
          name: "Concurrent",
          email: "concurrent@example.com",
          multi: "1",
          items: JSON.stringify([{ e: event.id, q: 1 }]),
        },
      } as unknown as Awaited<
        ReturnType<typeof stripeApi.retrieveCheckoutSession>
      >);

      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_multi_concurrent"),
        );
        expect(response.status).toBe(409);
        const html = await response.text();
        expect(html).toContain("being processed");
      } finally {
        mockRetrieve.mockRestore();
      }
    });

    test("single-ticket being processed returns 409", async () => {
      await setupStripe();

      const event = await createTestEvent({
        maxAttendees: 50,
        unitPrice: 1000,
      });

      // Pre-reserve the session to simulate concurrent processing
      const { reserveSession: reserveSessionFn } = await import("#lib/db/processed-payments.ts");
      await reserveSessionFn("cs_single_concurrent");

      const mockRetrieve = spyOn(stripeApi, "retrieveCheckoutSession");
      mockRetrieve.mockResolvedValue({
        id: "cs_single_concurrent",
        payment_status: "paid",
        payment_intent: "pi_single_concurrent",
        metadata: {
          event_id: String(event.id),
          name: "Concurrent",
          email: "concurrent@example.com",
          quantity: "1",
        },
      } as unknown as Awaited<
        ReturnType<typeof stripeApi.retrieveCheckoutSession>
      >);

      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_single_concurrent"),
        );
        expect(response.status).toBe(409);
        const html = await response.text();
        expect(html).toContain("being processed");
      } finally {
        mockRetrieve.mockRestore();
      }
    });

    test("multi-ticket pricePaid calculation uses unit_price * quantity", async () => {
      await setupStripe();

      const event = await createTestEvent({
        name: "Multi Price Calc",
        maxAttendees: 50,
        unitPrice: 500,
      });

      const mockRetrieve = spyOn(stripeApi, "retrieveCheckoutSession");
      mockRetrieve.mockResolvedValue({
        id: "cs_multi_price",
        payment_status: "paid",
        payment_intent: "pi_multi_price",
        metadata: {
          name: "Price Test",
          email: "price@example.com",
          multi: "1",
          items: JSON.stringify([{ e: event.id, q: 3 }]),
        },
      } as unknown as Awaited<
        ReturnType<typeof stripeApi.retrieveCheckoutSession>
      >);

      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_multi_price"),
        );
        expect(response.status).toBe(200);

        const { getAttendeesRaw } = await import("#lib/db/attendees.ts");
        const attendees = await getAttendeesRaw(event.id);
        expect(attendees.length).toBe(1);
        expect(attendees[0]?.quantity).toBe(3);
        // price_paid is stored encrypted, verify it was set (not null)
        expect(attendees[0]?.price_paid).not.toBeNull();
      } finally {
        mockRetrieve.mockRestore();
      }
    });

    test("single-ticket pricePaid calculation uses unit_price * quantity", async () => {
      await setupStripe();

      const event = await createTestEvent({
        maxAttendees: 50,
        unitPrice: 1000,
        maxQuantity: 5,
      });

      const mockRetrieve = spyOn(stripeApi, "retrieveCheckoutSession");
      mockRetrieve.mockResolvedValue({
        id: "cs_single_price",
        payment_status: "paid",
        payment_intent: "pi_single_price",
        metadata: {
          event_id: String(event.id),
          name: "Price Single",
          email: "price@example.com",
          quantity: "2",
        },
      } as unknown as Awaited<
        ReturnType<typeof stripeApi.retrieveCheckoutSession>
      >);

      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_single_price"),
        );
        expect(response.status).toBe(200);

        const { getAttendeesRaw } = await import("#lib/db/attendees.ts");
        const attendees = await getAttendeesRaw(event.id);
        expect(attendees.length).toBe(1);
        // price_paid is stored encrypted, verify it was set (not null)
        expect(attendees[0]?.price_paid).not.toBeNull();
      } finally {
        mockRetrieve.mockRestore();
      }
    });

    test("formatPaymentError returns plain error when refunded is undefined", async () => {
      await setupStripe();

      // This tests the case where result.refunded is undefined
      // This happens when validatePaidSession fails (no refund attempt)
      const mockRetrieve = spyOn(stripeApi, "retrieveCheckoutSession");
      mockRetrieve.mockResolvedValue({
        id: "cs_plain_error",
        payment_status: "unpaid",
        payment_intent: "pi_test",
        metadata: {
          event_id: "1",
          name: "John",
          email: "john@example.com",
          quantity: "1",
        },
      } as unknown as Awaited<
        ReturnType<typeof stripeApi.retrieveCheckoutSession>
      >);

      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_plain_error"),
        );
        expect(response.status).toBe(400);
        const html = await response.text();
        expect(html).toContain("Payment verification failed");
        // Should NOT contain refund-related text
        expect(html).not.toContain("refunded");
        expect(html).not.toContain("contact support for a refund");
      } finally {
        mockRetrieve.mockRestore();
      }
    });

    test("webhook cancel page returns error when no provider", async () => {
      // Don't set up any payment provider
      const response = await handleRequest(
        mockRequest("/payment/cancel?session_id=cs_cancel_no_prov"),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("Payment provider not configured");
    });

    test("multi-ticket failure error message for encryption_error", async () => {
      await setupStripe();

      const event = await createTestEvent({
        name: "Multi Enc Err",
        maxAttendees: 50,
        unitPrice: 500,
      });

      const mockRetrieve = spyOn(stripeApi, "retrieveCheckoutSession");
      mockRetrieve.mockResolvedValue({
        id: "cs_multi_enc_err",
        payment_status: "paid",
        payment_intent: "pi_multi_enc_err",
        metadata: {
          name: "Enc Error",
          email: "enc@example.com",
          multi: "1",
          items: JSON.stringify([{ e: event.id, q: 1 }]),
        },
      } as unknown as Awaited<
        ReturnType<typeof stripeApi.retrieveCheckoutSession>
      >);

      const mockRefund = spyOn(stripeApi, "refundPayment");
      mockRefund.mockResolvedValue({ id: "re_test" } as unknown as Awaited<
        ReturnType<typeof stripeApi.refundPayment>
      >);

      // Mock atomic create to return encryption error
      const { attendeesApi } = await import("#lib/db/attendees.ts");
      const mockAtomic = spyOn(attendeesApi, "createAttendeeAtomic");
      mockAtomic.mockResolvedValue({
        success: false,
        reason: "encryption_error",
      });

      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_multi_enc_err"),
        );
        expect(response.status).toBe(400);
        const html = await response.text();
        expect(html).toContain("Registration failed");
        expect(html).toContain("refunded");
      } finally {
        mockRetrieve.mockRestore();
        mockRefund.mockRestore();
        mockAtomic.mockRestore();
      }
    });

    test("multi-ticket no firstAttendee returns refund error", async () => {
      await setupStripe();

      // Mock empty items list (edge case where items parsed but empty after filtering)
      const mockRetrieve = spyOn(stripeApi, "retrieveCheckoutSession");
      mockRetrieve.mockResolvedValue({
        id: "cs_multi_empty_items",
        payment_status: "paid",
        payment_intent: "pi_multi_empty",
        metadata: {
          name: "Empty Items",
          email: "empty@example.com",
          multi: "1",
          items: "[]", // Empty array
        },
      } as unknown as Awaited<
        ReturnType<typeof stripeApi.retrieveCheckoutSession>
      >);

      const mockRefund = spyOn(stripeApi, "refundPayment");
      mockRefund.mockResolvedValue({ id: "re_test" } as unknown as Awaited<
        ReturnType<typeof stripeApi.refundPayment>
      >);

      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_multi_empty_items"),
        );
        // Empty items list returns "Invalid multi-ticket session data"
        expect(response.status).toBe(400);
      } finally {
        mockRetrieve.mockRestore();
        mockRefund.mockRestore();
      }
    });

  });

  describe("webhook multi-ticket already processed", () => {
    afterEach(() => {
      resetStripeClient();
    });

    test("returns success for already-processed multi-ticket session", async () => {
      await setupStripe();

      const event = await createTestEvent({
        name: "Multi Already Done",
        maxAttendees: 50,
        unitPrice: 500,
      });
      // Create attendee directly (not via public form which redirects to Stripe for paid events)
      const result = await createAttendeeAtomic(event.id, "Already Done", "already@example.com", "pi_already_done", 1);
      if (!result.success) throw new Error("Failed to create test attendee");
      const attendee = result.attendee;

      const { reserveSession: reserveSessionFn, finalizeSession: finalizeSessionFn } = await import("#lib/db/processed-payments.ts");
      await reserveSessionFn("cs_multi_already_done");
      await finalizeSessionFn("cs_multi_already_done", attendee.id);

      const { stripePaymentProvider } = await import("#lib/stripe-provider.ts");
      const mockVerify = spyOn(stripePaymentProvider, "verifyWebhookSignature");
      mockVerify.mockResolvedValue({
        valid: true,
        event: {
          id: "evt_already_done",
          type: "checkout.session.completed",
          data: {
            object: {
              id: "cs_multi_already_done",
              payment_status: "paid",
              payment_intent: "pi_already_done",
              metadata: {
                name: "Already Done",
                email: "already@example.com",
                multi: "1",
                items: JSON.stringify([{ e: event.id, q: 1 }]),
              },
            },
          },
        },
      });

      try {
        const response = await handleRequest(
          mockWebhookRequest(
            {},
            { "stripe-signature": "sig_valid" },
          ),
        );
        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json.processed).toBe(true);
      } finally {
        mockVerify.mockRestore();
      }
    });

    test("webhook handles multi-ticket with inactive event and rollback", async () => {
      await setupStripe();

      const event1 = await createTestEvent({
        name: "Multi WH Active",
        maxAttendees: 50,
        unitPrice: 500,
      });
      const event2 = await createTestEvent({
        name: "Multi WH Inactive",
        maxAttendees: 50,
        unitPrice: 500,
      });
      await deactivateTestEvent(event2.id);

      const { stripePaymentProvider } = await import("#lib/stripe-provider.ts");
      const mockVerify = spyOn(stripePaymentProvider, "verifyWebhookSignature");
      mockVerify.mockResolvedValue({
        valid: true,
        event: {
          id: "evt_multi_inactive_wh",
          type: "checkout.session.completed",
          data: {
            object: {
              id: "cs_multi_inactive_wh",
              payment_status: "paid",
              payment_intent: "pi_multi_inactive_wh",
              metadata: {
                name: "Multi Inactive",
                email: "inactive@example.com",
                multi: "1",
                items: JSON.stringify([
                  { e: event1.id, q: 1 },
                  { e: event2.id, q: 1 },
                ]),
              },
            },
          },
        },
      });

      const mockRefund = spyOn(stripeApi, "refundPayment");
      mockRefund.mockResolvedValue({ id: "re_test" } as unknown as Awaited<
        ReturnType<typeof stripeApi.refundPayment>
      >);

      try {
        const response = await handleRequest(
          mockWebhookRequest(
            {},
            { "stripe-signature": "sig_valid" },
          ),
        );
        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json.processed).toBe(false);
        expect(json.error).toContain("no longer accepting");

        const { getAttendeesRaw } = await import("#lib/db/attendees.ts");
        const attendees1 = await getAttendeesRaw(event1.id);
        expect(attendees1.length).toBe(0);
      } finally {
        mockVerify.mockRestore();
        mockRefund.mockRestore();
      }
    });

    test("webhook handles multi-ticket sold out in second event", async () => {
      await setupStripe();

      const event1 = await createTestEvent({
        name: "Multi WH Avail",
        maxAttendees: 50,
        unitPrice: 500,
      });
      const event2 = await createTestEvent({
        name: "Multi WH Full",
        maxAttendees: 1,
        unitPrice: 500,
      });
      await createAttendeeAtomic(event2.id, "First", "first@example.com", "pi_first", 1);

      const { stripePaymentProvider } = await import("#lib/stripe-provider.ts");
      const mockVerify = spyOn(stripePaymentProvider, "verifyWebhookSignature");
      mockVerify.mockResolvedValue({
        valid: true,
        event: {
          id: "evt_multi_soldout_wh",
          type: "checkout.session.completed",
          data: {
            object: {
              id: "cs_multi_soldout_wh",
              payment_status: "paid",
              payment_intent: "pi_multi_soldout_wh",
              metadata: {
                name: "Sold Out Multi",
                email: "soldout@example.com",
                multi: "1",
                items: JSON.stringify([
                  { e: event1.id, q: 1 },
                  { e: event2.id, q: 1 },
                ]),
              },
            },
          },
        },
      });

      const mockRefund = spyOn(stripeApi, "refundPayment");
      mockRefund.mockResolvedValue({ id: "re_test" } as unknown as Awaited<
        ReturnType<typeof stripeApi.refundPayment>
      >);

      try {
        const response = await handleRequest(
          mockWebhookRequest(
            {},
            { "stripe-signature": "sig_valid" },
          ),
        );
        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json.processed).toBe(false);
        expect(json.error).toContain("sold out");

        const { getAttendeesRaw } = await import("#lib/db/attendees.ts");
        const attendees1 = await getAttendeesRaw(event1.id);
        expect(attendees1.length).toBe(0);
      } finally {
        mockVerify.mockRestore();
        mockRefund.mockRestore();
      }
    });

    test("webhook handles non-checkout event type by acknowledging", async () => {
      await setupStripe();

      const { stripePaymentProvider } = await import("#lib/stripe-provider.ts");
      const mockVerify = spyOn(stripePaymentProvider, "verifyWebhookSignature");
      mockVerify.mockResolvedValue({
        valid: true,
        event: {
          id: "evt_other_type",
          type: "payment_intent.succeeded",
          data: {
            object: {
              id: "pi_test",
            },
          },
        },
      });

      try {
        const response = await handleRequest(
          mockWebhookRequest(
            {},
            { "stripe-signature": "sig_valid" },
          ),
        );
        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json.received).toBe(true);
        expect(json.processed).toBeUndefined();
      } finally {
        mockVerify.mockRestore();
      }
    });
  });

  describe("routes/webhooks.ts (multi-ticket webhook)", () => {
    afterEach(() => {
      resetStripeClient();
    });

    test("multi-ticket webhook creates attendees for multiple events", async () => {
      await setupStripe();

      const event1 = await createTestEvent({
        name: "Multi WH OK 1",
        maxAttendees: 50,
        unitPrice: 500,
      });
      const event2 = await createTestEvent({
        name: "Multi WH OK 2",
        maxAttendees: 50,
        unitPrice: 300,
      });

      const { stripePaymentProvider } = await import("#lib/stripe-provider.ts");
      const mockVerify = spyOn(stripePaymentProvider, "verifyWebhookSignature");
      mockVerify.mockResolvedValue({
        valid: true,
        event: {
          id: "evt_multi_ok",
          type: "checkout.session.completed",
          data: {
            object: {
              id: "cs_multi_ok",
              payment_status: "paid",
              payment_intent: "pi_multi_ok",
              metadata: {
                name: "Multi Buyer",
                email: "multi@example.com",
                multi: "1",
                items: JSON.stringify([
                  { e: event1.id, q: 1 },
                  { e: event2.id, q: 2 },
                ]),
              },
            },
          },
        },
      });

      try {
        const response = await handleRequest(
          mockWebhookRequest(
            {},
            { "stripe-signature": "sig_valid" },
          ),
        );
        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json.processed).toBe(true);
      } finally {
        mockVerify.mockRestore();
      }
    });

    test("multi-ticket webhook handles event not found with refund", async () => {
      await setupStripe();

      const { stripePaymentProvider } = await import("#lib/stripe-provider.ts");
      const mockVerify = spyOn(stripePaymentProvider, "verifyWebhookSignature");
      mockVerify.mockResolvedValue({
        valid: true,
        event: {
          id: "evt_multi_notfound",
          type: "checkout.session.completed",
          data: {
            object: {
              id: "cs_multi_notfound",
              payment_status: "paid",
              payment_intent: "pi_multi_notfound",
              metadata: {
                name: "Multi NotFound",
                email: "notfound@example.com",
                multi: "1",
                items: JSON.stringify([
                  { e: 99999, q: 1 },
                ]),
              },
            },
          },
        },
      });

      const mockRefund = spyOn(stripeApi, "refundPayment");
      mockRefund.mockResolvedValue(true);

      try {
        const response = await handleRequest(
          mockWebhookRequest(
            {},
            { "stripe-signature": "sig_valid" },
          ),
        );
        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json.error).toContain("Event not found");
      } finally {
        mockVerify.mockRestore();
        mockRefund.mockRestore();
      }
    });

    test("multi-ticket webhook handles capacity exceeded with rollback", async () => {
      await setupStripe();

      const event1 = await createTestEvent({
        name: "Multi WH Cap 1",
        maxAttendees: 50,
        unitPrice: 500,
      });
      const event2 = await createTestEvent({
        name: "Multi WH Cap 2",
        maxAttendees: 1,
        unitPrice: 300,
      });

      // Fill event2 to capacity
      await createAttendeeAtomic(event2.id, "Existing", "existing@example.com", null, 1);

      const { stripePaymentProvider } = await import("#lib/stripe-provider.ts");
      const mockVerify = spyOn(stripePaymentProvider, "verifyWebhookSignature");
      mockVerify.mockResolvedValue({
        valid: true,
        event: {
          id: "evt_multi_cap",
          type: "checkout.session.completed",
          data: {
            object: {
              id: "cs_multi_cap",
              payment_status: "paid",
              payment_intent: "pi_multi_cap",
              metadata: {
                name: "Multi Cap",
                email: "cap@example.com",
                multi: "1",
                items: JSON.stringify([
                  { e: event1.id, q: 1 },
                  { e: event2.id, q: 1 },
                ]),
              },
            },
          },
        },
      });

      const mockRefund = spyOn(stripeApi, "refundPayment");
      mockRefund.mockResolvedValue(true);

      try {
        const response = await handleRequest(
          mockWebhookRequest(
            {},
            { "stripe-signature": "sig_valid" },
          ),
        );
        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json.error).toContain("sold out");
      } finally {
        mockVerify.mockRestore();
        mockRefund.mockRestore();
      }
    });

    test("webhook with already-processed session where event was deleted", async () => {
      await setupStripe();

      // Create a real event and attendee to satisfy FK constraints for finalization
      const event = await createTestEvent({
        name: "WH Del Evt",
        maxAttendees: 50,
        unitPrice: 500,
      });
      const attResult = await createAttendeeAtomic(event.id, "WH Del", "whdel@example.com", "pi_del", 1);
      if (!attResult.success) throw new Error("Failed to create attendee");

      // Reserve and finalize the session with the real attendee
      const { reserveSession: reserveSessionFn, finalizeSession: finalizeSessionFn } = await import("#lib/db/processed-payments.ts");
      await reserveSessionFn("cs_del_event_wh");
      await finalizeSessionFn("cs_del_event_wh", attResult.attendee.id);

      const { stripePaymentProvider } = await import("#lib/stripe-provider.ts");
      const mockVerify = spyOn(stripePaymentProvider, "verifyWebhookSignature");
      // Use a non-existent event_id in metadata to trigger "Event not found" in alreadyProcessedResult
      mockVerify.mockResolvedValue({
        valid: true,
        event: {
          id: "evt_del_event_wh",
          type: "checkout.session.completed",
          data: {
            object: {
              id: "cs_del_event_wh",
              payment_status: "paid",
              payment_intent: "pi_del_event_wh",
              metadata: {
                name: "Deleted Event",
                email: "deleted@example.com",
                event_id: "99999",
                quantity: "1",
              },
            },
          },
        },
      });

      try {
        const response = await handleRequest(
          mockWebhookRequest(
            {},
            { "stripe-signature": "sig_valid" },
          ),
        );
        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json.error).toContain("Event not found");
      } finally {
        mockVerify.mockRestore();
      }
    });

    test("webhook refund returns false when payment reference is null", async () => {
      await setupStripe();

      const event = await createTestEvent({
        name: "WH Noref",
        maxAttendees: 50,
        unitPrice: 500,
      });
      await deactivateTestEvent(event.id);

      const { stripePaymentProvider } = await import("#lib/stripe-provider.ts");
      const mockVerify = spyOn(stripePaymentProvider, "verifyWebhookSignature");
      mockVerify.mockResolvedValue({
        valid: true,
        event: {
          id: "evt_noref",
          type: "checkout.session.completed",
          data: {
            object: {
              id: "cs_noref",
              payment_status: "paid",
              metadata: {
                name: "No Ref",
                email: "noref@example.com",
                event_id: String(event.id),
                quantity: "1",
              },
            },
          },
        },
      });

      try {
        const response = await handleRequest(
          mockWebhookRequest(
            {},
            { "stripe-signature": "sig_valid" },
          ),
        );
        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json.error).toContain("no longer accepting");
      } finally {
        mockVerify.mockRestore();
      }
    });

  });

  describe("routes/webhooks.ts (uncovered line coverage)", () => {
    afterEach(() => {
      resetStripeClient();
    });

    test("extractIntent defaults eventId to 0 when event_id is missing from metadata", async () => {
      await setupStripe();

      // Use webhook path: event type matches but metadata is incomplete,
      // so extractSessionFromEvent returns null. Fallback retrieves session
      // via provider.retrieveSession which we mock to return event_id undefined.
      // This triggers the ?? "0" fallback in extractIntent (line 52).
      const { stripePaymentProvider } = await import("#lib/stripe-provider.ts");
      const mockVerify = spyOn(stripePaymentProvider, "verifyWebhookSignature");
      mockVerify.mockResolvedValue({
        valid: true,
        event: {
          id: "evt_no_eid",
          type: "checkout.session.completed",
          data: {
            object: {
              id: "cs_no_event_id",
              status: "COMPLETED",
              // No proper metadata -> extractSessionFromEvent returns null
            },
          },
        },
      });

      const mockRetrieveSession = spyOn(stripePaymentProvider, "retrieveSession");
      mockRetrieveSession.mockResolvedValue({
        id: "cs_no_event_id",
        paymentStatus: "paid" as const,
        paymentReference: "pi_no_event_id",
        metadata: {
          name: "No EventId",
          email: "noeventid@example.com",
          quantity: "1",
          // event_id intentionally undefined -> triggers ?? "0"
        },
      });

      const mockRefund = spyOn(stripeApi, "refundPayment");
      mockRefund.mockResolvedValue({ id: "re_test" } as unknown as Awaited<
        ReturnType<typeof stripeApi.refundPayment>
      >);

      try {
        const response = await handleRequest(
          mockWebhookRequest(
            {},
            { "stripe-signature": "sig_valid" },
          ),
        );
        expect(response.status).toBe(200);
        const json = await response.json();
        // eventId defaults to 0 (no event with id 0), so "Event not found" error
        expect(json.error).toContain("Event not found");
      } finally {
        mockVerify.mockRestore();
        mockRetrieveSession.mockRestore();
        mockRefund.mockRestore();
      }
    });

    test("tryRefund logs error when no payment provider is configured", async () => {
      await setupStripe();

      const event = await createTestEvent({
        name: "WH Tryrefund Noprov",
        maxAttendees: 50,
        unitPrice: 500,
      });
      await deactivateTestEvent(event.id);

      // Mock paymentsApi.getConfiguredProvider to return "stripe" on first call
      // (for webhook handler's initial check) then null on second call (for tryRefund).
      // This covers lines 135-141 where tryRefund has a payment reference but no provider.
      const { paymentsApi } = await import("#lib/payments.ts");
      const origGetConfigured = paymentsApi.getConfiguredProvider;
      let callCount = 0;
      const mockGetConfigured = spyOn(paymentsApi, "getConfiguredProvider");
      mockGetConfigured.mockImplementation(() => {
        callCount++;
        // First call: webhook handler needs provider; second call: tryRefund should get null
        return callCount <= 1 ? origGetConfigured() : Promise.resolve(null);
      });

      const { stripePaymentProvider } = await import("#lib/stripe-provider.ts");
      const mockVerify = spyOn(stripePaymentProvider, "verifyWebhookSignature");
      mockVerify.mockResolvedValue({
        valid: true,
        event: {
          id: "evt_tryrefund_noprov",
          type: "checkout.session.completed",
          data: {
            object: {
              id: "cs_tryrefund_noprov",
              payment_status: "paid",
              payment_intent: "pi_tryrefund_noprov",
              metadata: {
                name: "No Provider",
                email: "noprov@example.com",
                event_id: String(event.id),
                quantity: "1",
              },
            },
          },
        },
      });

      try {
        const response = await handleRequest(
          mockWebhookRequest(
            {},
            { "stripe-signature": "sig_valid" },
          ),
        );
        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json.error).toContain("no longer accepting");
      } finally {
        mockVerify.mockRestore();
        mockGetConfigured.mockRestore();
      }
    });

    test("multi-ticket rollback deletes already-created attendees when second event not found", async () => {
      await setupStripe();

      const event1 = await createTestEvent({
        name: "WH Multi Rollback 1",
        maxAttendees: 50,
        unitPrice: 500,
      });
      // event2 does not exist (id 99999), so after creating attendee for event1 it rolls back

      const { stripePaymentProvider } = await import("#lib/stripe-provider.ts");
      const mockVerify = spyOn(stripePaymentProvider, "verifyWebhookSignature");
      mockVerify.mockResolvedValue({
        valid: true,
        event: {
          id: "evt_multi_rollback",
          type: "checkout.session.completed",
          data: {
            object: {
              id: "cs_multi_rollback_cleanup",
              payment_status: "paid",
              payment_intent: "pi_multi_rollback",
              metadata: {
                name: "Rollback Test",
                email: "rollback@example.com",
                multi: "1",
                items: JSON.stringify([
                  { e: event1.id, q: 1 },
                  { e: 99999, q: 1 },
                ]),
              },
            },
          },
        },
      });

      const mockRefund = spyOn(stripeApi, "refundPayment");
      mockRefund.mockResolvedValue({ id: "re_rollback" } as unknown as Awaited<
        ReturnType<typeof stripeApi.refundPayment>
      >);

      try {
        const response = await handleRequest(
          mockWebhookRequest(
            {},
            { "stripe-signature": "sig_valid" },
          ),
        );
        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json.error).toContain("Event not found");

        // Verify the attendee created for event1 was rolled back (deleted)
        const { getAttendeesRaw } = await import("#lib/db/attendees.ts");
        const attendees = await getAttendeesRaw(event1.id);
        expect(attendees.length).toBe(0);
      } finally {
        mockVerify.mockRestore();
        mockRefund.mockRestore();
      }
    });

    test("multi-ticket pricePaid is null when event has no unit_price", async () => {
      await setupStripe();

      // Create event with no unitPrice (free event) to cover line 273 null path
      const event = await createTestEvent({
        name: "WH Multi Free",
        maxAttendees: 50,
      });

      const mockRetrieve = spyOn(stripeApi, "retrieveCheckoutSession");
      mockRetrieve.mockResolvedValue({
        id: "cs_multi_free",
        payment_status: "paid",
        payment_intent: "pi_multi_free",
        metadata: {
          name: "Free Multi",
          email: "freemulti@example.com",
          multi: "1",
          items: JSON.stringify([{ e: event.id, q: 2 }]),
        },
      } as unknown as Awaited<
        ReturnType<typeof stripeApi.retrieveCheckoutSession>
      >);

      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_multi_free"),
        );
        expect(response.status).toBe(200);

        const { getAttendeesRaw } = await import("#lib/db/attendees.ts");
        const attendees = await getAttendeesRaw(event.id);
        expect(attendees.length).toBe(1);
        expect(attendees[0]?.quantity).toBe(2);
        // price_paid should be null for free events
        expect(attendees[0]?.price_paid).toBeNull();
      } finally {
        mockRetrieve.mockRestore();
      }
    });

    test("single-ticket pricePaid is null when event has no unit_price", async () => {
      await setupStripe();

      // Create event with no unitPrice (free event) to cover line 378 null path
      const event = await createTestEvent({
        name: "WH Single Free",
        maxAttendees: 50,
      });

      const mockRetrieve = spyOn(stripeApi, "retrieveCheckoutSession");
      mockRetrieve.mockResolvedValue({
        id: "cs_single_free",
        payment_status: "paid",
        payment_intent: "pi_single_free",
        metadata: {
          event_id: String(event.id),
          name: "Free Single",
          email: "freesingle@example.com",
          quantity: "2",
        },
      } as unknown as Awaited<
        ReturnType<typeof stripeApi.retrieveCheckoutSession>
      >);

      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_single_free"),
        );
        expect(response.status).toBe(200);

        const { getAttendeesRaw } = await import("#lib/db/attendees.ts");
        const attendees = await getAttendeesRaw(event.id);
        expect(attendees.length).toBe(1);
        expect(attendees[0]?.quantity).toBe(2);
        expect(attendees[0]?.price_paid).toBeNull();
      } finally {
        mockRetrieve.mockRestore();
      }
    });

    test("webhook with checkout event type but no extractable session falls back with no sessionId", async () => {
      await setupStripe();

      // Event type matches checkoutCompletedEventType but data lacks metadata
      // so extractSessionFromEvent returns null (covers lines 498-500)
      // and data object has no id/order_id so sessionId is null (covers lines 597-602)
      const { stripePaymentProvider } = await import("#lib/stripe-provider.ts");
      const mockVerify = spyOn(stripePaymentProvider, "verifyWebhookSignature");
      mockVerify.mockResolvedValue({
        valid: true,
        event: {
          id: "evt_no_extract",
          type: "checkout.session.completed",
          data: {
            object: {
              // No id, no order_id, no proper metadata
              some_field: "value",
            },
          },
        },
      });

      try {
        const response = await handleRequest(
          mockWebhookRequest(
            {},
            { "stripe-signature": "sig_valid" },
          ),
        );
        expect(response.status).toBe(400);
        const text = await response.text();
        expect(text).toBe("Invalid session data");
      } finally {
        mockVerify.mockRestore();
      }
    });

    test("webhook with checkout event but non-COMPLETED status returns pending", async () => {
      await setupStripe();

      // Event type matches but metadata is invalid so extractSessionFromEvent returns null
      // data object has id (for sessionId) and status "PENDING" (covers lines 605-607)
      const { stripePaymentProvider } = await import("#lib/stripe-provider.ts");
      const mockVerify = spyOn(stripePaymentProvider, "verifyWebhookSignature");
      mockVerify.mockResolvedValue({
        valid: true,
        event: {
          id: "evt_pending_square",
          type: "checkout.session.completed",
          data: {
            object: {
              id: "pay_pending_123",
              status: "PENDING",
              // No payment_status or metadata -> extractSessionFromEvent returns null
            },
          },
        },
      });

      try {
        const response = await handleRequest(
          mockWebhookRequest(
            {},
            { "stripe-signature": "sig_valid" },
          ),
        );
        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json.received).toBe(true);
        expect(json.status).toBe("pending");
      } finally {
        mockVerify.mockRestore();
      }
    });

    test("webhook fallback uses order_id when present in event data", async () => {
      await setupStripe();

      // Event with order_id instead of id triggers the order_id branch
      // in extractSessionIdFromObject
      const { stripePaymentProvider } = await import("#lib/stripe-provider.ts");
      const mockVerify = spyOn(stripePaymentProvider, "verifyWebhookSignature");
      mockVerify.mockResolvedValue({
        valid: true,
        event: {
          id: "evt_order_id_test",
          type: "checkout.session.completed",
          data: {
            object: {
              order_id: "order_abc123",
              status: "COMPLETED",
              // No metadata -> extractSessionFromEvent returns null
            },
          },
        },
      });

      const mockRetrieveSession = spyOn(stripePaymentProvider, "retrieveSession");
      mockRetrieveSession.mockResolvedValue(null);

      try {
        const response = await handleRequest(
          mockWebhookRequest(
            {},
            { "stripe-signature": "sig_valid" },
          ),
        );
        // retrieveSession returns null -> "Invalid session data"
        expect(response.status).toBe(400);
        const text = await response.text();
        expect(text).toBe("Invalid session data");
      } finally {
        mockVerify.mockRestore();
        mockRetrieveSession.mockRestore();
      }
    });

    test("multi-ticket with no attendees created returns refund error", async () => {
      await setupStripe();

      const event = await createTestEvent({
        name: "WH Multi No Att",
        maxAttendees: 50,
        unitPrice: 500,
      });

      // Mock createAttendeeAtomic to always fail with capacity_exceeded on first try
      // so createdAttendees stays empty and we hit lines 309-310
      const { attendeesApi } = await import("#lib/db/attendees.ts");
      const mockAtomic = spyOn(attendeesApi, "createAttendeeAtomic");
      mockAtomic.mockResolvedValue({
        success: false,
        reason: "capacity_exceeded",
      });

      const mockRetrieve = spyOn(stripeApi, "retrieveCheckoutSession");
      mockRetrieve.mockResolvedValue({
        id: "cs_multi_no_att",
        payment_status: "paid",
        payment_intent: "pi_multi_no_att",
        metadata: {
          name: "No Att",
          email: "noatt@example.com",
          multi: "1",
          items: JSON.stringify([{ e: event.id, q: 1 }]),
        },
      } as unknown as Awaited<
        ReturnType<typeof stripeApi.retrieveCheckoutSession>
      >);

      const mockRefund = spyOn(stripeApi, "refundPayment");
      mockRefund.mockResolvedValue({ id: "re_no_att" } as unknown as Awaited<
        ReturnType<typeof stripeApi.refundPayment>
      >);

      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_multi_no_att"),
        );
        expect(response.status).toBe(400);
        const html = await response.text();
        expect(html).toContain("sold out");
      } finally {
        mockAtomic.mockRestore();
        mockRetrieve.mockRestore();
        mockRefund.mockRestore();
      }
    });
  });

  describe("closes_at in payment processing", () => {
    afterEach(() => {
      resetStripeClient();
    });

    test("refunds and shows error when event registration has closed (single ticket)", async () => {
      await setupStripe();

      const pastDate = new Date(Date.now() - 60000).toISOString().slice(0, 16);
      const event = await createTestEvent({
        maxAttendees: 50,
        unitPrice: 1000,
        closesAt: pastDate,
      });

      const mockRetrieve = spyOn(stripeApi, "retrieveCheckoutSession");
      mockRetrieve.mockResolvedValue({
        id: "cs_closed",
        payment_status: "paid",
        payment_intent: "pi_closed",
        metadata: {
          event_id: String(event.id),
          name: "John",
          email: "john@example.com",
          quantity: "1",
        },
      } as unknown as Awaited<
        ReturnType<typeof stripeApi.retrieveCheckoutSession>
      >);

      const mockRefund = spyOn(stripeApi, "refundPayment");
      mockRefund.mockResolvedValue({ id: "re_test" } as unknown as Awaited<
        ReturnType<typeof stripeApi.refundPayment>
      >);

      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_closed"),
        );
        expect(response.status).toBe(400);
        const html = await response.text();
        expect(html).toContain("registration closed");
        expect(html).toContain("refunded");
      } finally {
        mockRetrieve.mockRestore();
        mockRefund.mockRestore();
      }
    });

    test("webhook refunds when event registration has closed (single ticket)", async () => {
      await setupStripe();

      const pastDate = new Date(Date.now() - 60000).toISOString().slice(0, 16);
      const event = await createTestEvent({
        maxAttendees: 50,
        unitPrice: 1000,
        closesAt: pastDate,
      });

      const { stripePaymentProvider } = await import("#lib/stripe-provider.ts");
      const mockVerify = spyOn(stripePaymentProvider, "verifyWebhookSignature");
      mockVerify.mockResolvedValue({
        valid: true,
        event: {
          id: "evt_closed",
          type: "checkout.session.completed",
          data: {
            object: {
              id: "cs_closed_wh",
              payment_status: "paid",
              payment_intent: "pi_closed_wh",
              metadata: {
                event_id: String(event.id),
                name: "Jane",
                email: "jane@example.com",
                quantity: "1",
              },
            },
          },
        },
      });

      const mockRefund = spyOn(stripeApi, "refundPayment");
      mockRefund.mockResolvedValue({ id: "re_closed" } as unknown as Awaited<
        ReturnType<typeof stripeApi.refundPayment>
      >);

      try {
        const response = await handleRequest(
          mockWebhookRequest({}, { "stripe-signature": "sig_closed" }),
        );
        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json.error).toContain("registration closed");
      } finally {
        mockVerify.mockRestore();
        mockRefund.mockRestore();
      }
    });

    test("webhook refunds when multi-ticket event registration has closed", async () => {
      await setupStripe();

      const pastDate = new Date(Date.now() - 60000).toISOString().slice(0, 16);
      const event1 = await createTestEvent({
        maxAttendees: 50,
        unitPrice: 1000,
      });
      // event2 is closed
      const event2 = await createTestEvent({
        maxAttendees: 50,
        unitPrice: 500,
        closesAt: pastDate,
      });

      const { stripePaymentProvider } = await import("#lib/stripe-provider.ts");
      const mockVerify = spyOn(stripePaymentProvider, "verifyWebhookSignature");
      mockVerify.mockResolvedValue({
        valid: true,
        event: {
          id: "evt_multi_closed",
          type: "checkout.session.completed",
          data: {
            object: {
              id: "cs_multi_closed",
              payment_status: "paid",
              payment_intent: "pi_multi_closed",
              metadata: {
                name: "Jane",
                email: "jane@example.com",
                multi: "1",
                items: JSON.stringify([
                  { e: event1.id, q: 1 },
                  { e: event2.id, q: 1 },
                ]),
              },
            },
          },
        },
      });

      const mockRefund = spyOn(stripeApi, "refundPayment");
      mockRefund.mockResolvedValue({ id: "re_multi_closed" } as unknown as Awaited<
        ReturnType<typeof stripeApi.refundPayment>
      >);

      try {
        const response = await handleRequest(
          mockWebhookRequest({}, { "stripe-signature": "sig_multi_closed" }),
        );
        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json.error).toContain("registration for");
        expect(json.error).toContain("closed");

        // Verify event1 attendee was rolled back
        const { getAttendeesRaw } = await import("#lib/db/attendees.ts");
        const attendees1 = await getAttendeesRaw(event1.id);
        expect(attendees1.length).toBe(0);
      } finally {
        mockVerify.mockRestore();
        mockRefund.mockRestore();
      }
    });
  });

});
