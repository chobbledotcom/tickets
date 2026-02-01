import { afterEach, beforeEach, describe, expect, spyOn, test } from "#test-compat";
import { resetStripeClient, stripeApi } from "#lib/stripe.ts";
import { handleRequest } from "#routes";
import { createAttendeeAtomic } from "#lib/db/attendees.ts";
import {
  awaitTestRequest,
  createTestDbWithSetup,
  createTestEvent,
  deactivateTestEvent,
  mockRequest,
  resetDb,
  resetTestSlugCounter,
  expectRedirect,
  setupStripe,
  submitTicketForm,
  withMocks,
} from "#test-utils";

describe("server (payment flow)", () => {
  beforeEach(async () => {
    resetTestSlugCounter();
    await createTestDbWithSetup();
  });

  afterEach(() => {
    resetDb();
  });

  describe("GET /payment/success", () => {
    test("returns error for missing session_id", async () => {
      const response = await handleRequest(mockRequest("/payment/success"));
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("Invalid payment callback");
    });

    test("returns error when no provider configured", async () => {
      const response = await handleRequest(
        mockRequest("/payment/success?session_id=cs_invalid"),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("Payment provider not configured");
    });

    test("returns error when session not found", async () => {
      await setupStripe();
      // When session ID doesn't exist in Stripe, retrieveCheckoutSession returns null
      const response = await handleRequest(
        mockRequest("/payment/success?session_id=cs_invalid"),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("Payment session not found");
    });

    test("returns error when payment not verified", async () => {
      const { spyOn } = await import("#test-compat");
      const { stripeApi } = await import("#lib/stripe.ts");
      await setupStripe();

      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
        unitPrice: 1000,
      });

      await withMocks(
        () => spyOn(stripeApi, "retrieveCheckoutSession").mockResolvedValue({
          id: "cs_test",
          payment_status: "unpaid",
          payment_intent: "pi_test",
          metadata: {
            event_id: String(event.id),
            name: "John",
            email: "john@example.com",
            quantity: "1",
          },
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
        async () => {
          const response = await handleRequest(
            mockRequest("/payment/success?session_id=cs_test"),
          );
          expect(response.status).toBe(400);
          const html = await response.text();
          expect(html).toContain("Payment verification failed");
        },
        resetStripeClient,
      );
    });

    test("returns error for invalid session metadata", async () => {
      const { spyOn } = await import("#test-compat");
      const { stripeApi } = await import("#lib/stripe.ts");
      await setupStripe();

      await withMocks(
        () => spyOn(stripeApi, "retrieveCheckoutSession").mockResolvedValue({
          id: "cs_test",
          payment_status: "paid",
          payment_intent: "pi_test",
          metadata: {}, // Missing required fields
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
        async () => {
          const response = await handleRequest(
            mockRequest("/payment/success?session_id=cs_test"),
          );
          expect(response.status).toBe(400);
          const html = await response.text();
          // Provider returns null for invalid metadata, so routes report "not found"
          expect(html).toContain("Payment session not found");
        },
        resetStripeClient,
      );
    });

    test("rejects payment for inactive event and refunds", async () => {
      const { spyOn } = await import("#test-compat");
      const { stripeApi } = await import("#lib/stripe.ts");
      await setupStripe();

      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
        unitPrice: 1000,
      });

      // Deactivate the event
      await deactivateTestEvent(event.id);

      await withMocks(
        () => ({
          mockRetrieve: spyOn(stripeApi, "retrieveCheckoutSession").mockResolvedValue({
            id: "cs_test",
            payment_status: "paid",
            payment_intent: "pi_test_123",
            metadata: {
              event_id: String(event.id),
              name: "John",
              email: "john@example.com",
              quantity: "1",
            },
          } as unknown as Awaited<
            ReturnType<typeof stripeApi.retrieveCheckoutSession>
          >),
          mockRefund: spyOn(stripeApi, "refundPayment").mockResolvedValue(
            { id: "re_test" } as unknown as Awaited<
              ReturnType<typeof stripeApi.refundPayment>
            >,
          ),
        }),
        async ({ mockRefund }) => {
          const response = await handleRequest(
            mockRequest("/payment/success?session_id=cs_test"),
          );
          expect(response.status).toBe(400);
          const html = await response.text();
          expect(html).toContain("no longer accepting registrations");

          // Verify refund was called
          expect(mockRefund).toHaveBeenCalledWith("pi_test_123");
        },
        resetStripeClient,
      );
    });

    test("refunds payment when event is sold out at confirmation time", async () => {
      const { spyOn } = await import("#test-compat");
      const { stripeApi } = await import("#lib/stripe.ts");
      await setupStripe();

      // Create event with only 1 spot
      const event = await createTestEvent({
        maxAttendees: 1,
        thankYouUrl: "https://example.com",
        unitPrice: 1000,
      });

      // Fill the event with another attendee (using atomic to simulate production flow)
      await createAttendeeAtomic(event.id, "First", "first@example.com", "pi_first");

      await withMocks(
        () => ({
          mockRetrieve: spyOn(stripeApi, "retrieveCheckoutSession").mockResolvedValue({
            id: "cs_test",
            payment_status: "paid",
            payment_intent: "pi_second",
            metadata: {
              event_id: String(event.id),
              name: "Second",
              email: "second@example.com",
              quantity: "1",
            },
          } as unknown as Awaited<
            ReturnType<typeof stripeApi.retrieveCheckoutSession>
          >),
          mockRefund: spyOn(stripeApi, "refundPayment").mockResolvedValue(
            { id: "re_test" } as unknown as Awaited<
              ReturnType<typeof stripeApi.refundPayment>
            >,
          ),
        }),
        async ({ mockRefund }) => {
          const response = await handleRequest(
            mockRequest("/payment/success?session_id=cs_test"),
          );
          expect(response.status).toBe(400);
          const html = await response.text();
          expect(html).toContain("sold out");
          expect(html).toContain("automatically refunded");

          // Verify refund was called
          expect(mockRefund).toHaveBeenCalledWith("pi_second");
        },
        resetStripeClient,
      );
    });
  });

  describe("GET /payment/cancel", () => {
    test("returns error for missing session_id", async () => {
      const response = await handleRequest(mockRequest("/payment/cancel"));
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("Invalid payment callback");
    });

    test("returns error when session not found", async () => {
      const { spyOn } = await import("#test-compat");
      const { stripeApi } = await import("#lib/stripe.ts");
      await setupStripe();

      await withMocks(
        () => spyOn(stripeApi, "retrieveCheckoutSession").mockResolvedValue(null),
        async () => {
          const response = await handleRequest(
            mockRequest("/payment/cancel?session_id=cs_invalid"),
          );
          expect(response.status).toBe(400);
          const html = await response.text();
          expect(html).toContain("Payment session not found");
        },
        resetStripeClient,
      );
    });

    test("returns error for invalid session metadata", async () => {
      const { spyOn } = await import("#test-compat");
      const { stripeApi } = await import("#lib/stripe.ts");
      await setupStripe();

      await withMocks(
        () => spyOn(stripeApi, "retrieveCheckoutSession").mockResolvedValue({
          id: "cs_test_cancel",
          payment_status: "unpaid",
          metadata: {}, // Missing required fields
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
        async () => {
          const response = await handleRequest(
            mockRequest("/payment/cancel?session_id=cs_test_cancel"),
          );
          expect(response.status).toBe(400);
          const html = await response.text();
          // Provider returns null for invalid metadata, so routes report "not found"
          expect(html).toContain("Payment session not found");
        },
        resetStripeClient,
      );
    });

    test("returns error when event not found", async () => {
      const { spyOn } = await import("#test-compat");
      const { stripeApi } = await import("#lib/stripe.ts");
      await setupStripe();

      await withMocks(
        () => spyOn(stripeApi, "retrieveCheckoutSession").mockResolvedValue({
          id: "cs_test_cancel",
          payment_status: "unpaid",
          metadata: {
            event_id: "99999", // Non-existent event
            name: "John",
            email: "john@example.com",
            quantity: "1",
          },
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
        async () => {
          const response = await handleRequest(
            mockRequest("/payment/cancel?session_id=cs_test_cancel"),
          );
          expect(response.status).toBe(404);
          const html = await response.text();
          expect(html).toContain("Event not found");
        },
        resetStripeClient,
      );
    });

    test("shows cancel page with link back to ticket form", async () => {
      const { spyOn } = await import("#test-compat");
      const { stripeApi } = await import("#lib/stripe.ts");
      await setupStripe();

      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
        unitPrice: 1000,
      });

      await withMocks(
        () => spyOn(stripeApi, "retrieveCheckoutSession").mockResolvedValue({
          id: "cs_test_cancel",
          payment_status: "unpaid",
          metadata: {
            event_id: String(event.id),
            name: "John",
            email: "john@example.com",
            quantity: "1",
          },
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
        async () => {
          const response = await handleRequest(
            mockRequest("/payment/cancel?session_id=cs_test_cancel"),
          );
          expect(response.status).toBe(200);
          const html = await response.text();
          expect(html).toContain("Payment Cancelled");
          expect(html).toContain(`/ticket/${event.slug}`);
        },
        resetStripeClient,
      );
    });
  });

  describe("payment routes", () => {
    test("returns 404 for unsupported method on payment routes", async () => {
      const response = await awaitTestRequest("/payment/success", {
        method: "POST",
        data: {},
      });
      expect(response.status).toBe(404);
    });
  });

  describe("ticket purchase with payments enabled", () => {
    // These tests require stripe-mock running on localhost:12111
    // STRIPE_MOCK_HOST/PORT are set in test/setup.ts
    // Stripe keys are now set via environment variables

    afterEach(() => {
      resetStripeClient();
    });

    test("handles payment flow error when Stripe fails", async () => {
      // Set a fake Stripe key to enable payments (in database)
      await setupStripe("sk_test_fake_key");

      // Create a paid event
      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com/thanks",
        unitPrice: 1000, // 10.00 price
      });

      // Try to reserve a ticket - should fail because Stripe key is invalid
      const response = await submitTicketForm(event.slug, {
        name: "John Doe",
        email: "john@example.com",
      });

      // Should return error page because Stripe session creation fails
      expect(response.status).toBe(500);
      const html = await response.text();
      expect(html).toContain("Failed to create payment session");
    });

    test("free ticket still works when payments enabled", async () => {
      await setupStripe("sk_test_fake_key");

      // Create a free event (no price)
      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com/thanks",
        unitPrice: null, // free
      });

      const response = await submitTicketForm(event.slug, {
        name: "John Doe",
        email: "john@example.com",
      });

      // Should redirect to thank you page
      expectRedirect("https://example.com/thanks")(response);
    });

    test("zero price ticket is treated as free", async () => {
      await setupStripe("sk_test_fake_key");

      // Create event with 0 price
      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com/thanks",
        unitPrice: 0, // zero price
      });

      const response = await submitTicketForm(event.slug, {
        name: "John Doe",
        email: "john@example.com",
      });

      // Should redirect to thank you page (no payment required)
      expectRedirect("https://example.com/thanks")(response);
    });

    test("redirects to Stripe checkout with stripe-mock", async () => {
      await setupStripe();

      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com/thanks",
        unitPrice: 1000, // 10.00 price
      });

      const response = await submitTicketForm(event.slug, {
        name: "John Doe",
        email: "john@example.com",
      });

      // Should redirect to Stripe checkout URL
      expect(response.status).toBe(302);
      const location = response.headers.get("location");
      expect(location).not.toBeNull();
      // stripe-mock returns a URL starting with https://
      expect(location?.startsWith("https://")).toBe(true);
    });

    test("returns error when event not found in session metadata", async () => {
      const { spyOn } = await import("#test-compat");
      const { stripeApi } = await import("#lib/stripe.ts");
      await setupStripe();

      await withMocks(
        () => ({
          mockRetrieve: spyOn(stripeApi, "retrieveCheckoutSession").mockResolvedValue({
            id: "cs_test",
            payment_status: "paid",
            payment_intent: "pi_test",
            metadata: {
              event_id: "99999", // Non-existent event
              name: "John",
              email: "john@example.com",
              quantity: "1",
            },
          } as unknown as Awaited<
            ReturnType<typeof stripeApi.retrieveCheckoutSession>
          >),
          mockRefund: spyOn(stripeApi, "refundPayment").mockResolvedValue(
            { id: "re_test" } as unknown as Awaited<
              ReturnType<typeof stripeApi.refundPayment>
            >,
          ),
        }),
        async () => {
          const response = await handleRequest(
            mockRequest("/payment/success?session_id=cs_test"),
          );
          expect(response.status).toBe(404);
          const html = await response.text();
          expect(html).toContain("Event not found");
        },
        resetStripeClient,
      );
    });

    test("creates attendee and shows success when payment verified", async () => {
      const { spyOn } = await import("#test-compat");
      const { stripeApi } = await import("#lib/stripe.ts");

      await setupStripe();

      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com/thanks",
        unitPrice: 1000,
      });

      await withMocks(
        () => spyOn(stripeApi, "retrieveCheckoutSession").mockResolvedValue({
          id: "cs_test_paid",
          payment_status: "paid",
          payment_intent: "pi_test_123",
          metadata: {
            event_id: String(event.id),
            name: "John",
            email: "john@example.com",
            quantity: "1",
          },
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
        async () => {
          const response = await handleRequest(
            mockRequest("/payment/success?session_id=cs_test_paid"),
          );

          expect(response.status).toBe(200);
          const html = await response.text();
          expect(html).toContain("Payment Successful");
          expect(html).toContain("https://example.com/thanks");

          // Verify attendee was created with payment ID (encrypted at rest)
          const { getAttendeesRaw } = await import("#lib/db/attendees.ts");
          const attendees = await getAttendeesRaw(event.id);
          expect(attendees.length).toBe(1);
          expect(attendees[0]?.payment_id).not.toBeNull();
        },
      );
    });

    test("handles replay of same session (idempotent)", async () => {
      const { spyOn } = await import("#test-compat");
      const { stripeApi } = await import("#lib/stripe.ts");

      await setupStripe();

      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com/thanks",
        unitPrice: 1000,
      });

      // Create attendee as if payment was already processed (using atomic to simulate production flow)
      await createAttendeeAtomic(event.id, "John", "john@example.com", "pi_test_123");

      await withMocks(
        () => spyOn(stripeApi, "retrieveCheckoutSession").mockResolvedValue({
          id: "cs_test_paid",
          payment_status: "paid",
          payment_intent: "pi_test_123",
          metadata: {
            event_id: String(event.id),
            name: "John",
            email: "john@example.com",
            quantity: "1",
          },
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
        async () => {
          const response = await handleRequest(
            mockRequest("/payment/success?session_id=cs_test_paid"),
          );

          // Capacity check will now fail since we already have the attendee
          // This is expected - in the new flow, replaying creates a duplicate attempt
          // which fails the capacity check if event is near full
          // For idempotent behavior, we'd need to check payment_intent uniqueness
          expect(response.status).toBe(200);
        },
      );
    });

    test("handles multiple quantity purchase", async () => {
      const { spyOn } = await import("#test-compat");
      const { stripeApi } = await import("#lib/stripe.ts");

      await setupStripe();

      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com/thanks",
        unitPrice: 1000,
        maxQuantity: 5,
      });

      await withMocks(
        () => spyOn(stripeApi, "retrieveCheckoutSession").mockResolvedValue({
          id: "cs_test_paid",
          payment_status: "paid",
          payment_intent: "pi_test_123",
          metadata: {
            event_id: String(event.id),
            name: "John",
            email: "john@example.com",
            quantity: "3",
          },
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
        async () => {
          const response = await handleRequest(
            mockRequest("/payment/success?session_id=cs_test_paid"),
          );

          expect(response.status).toBe(200);

          // Verify attendee was created with correct quantity
          const { getAttendeesRaw } = await import("#lib/db/attendees.ts");
          const attendees = await getAttendeesRaw(event.id);
          expect(attendees.length).toBe(1);
          expect(attendees[0]?.quantity).toBe(3);
        },
      );
    });

    test("rejects paid event registration when sold out before payment", async () => {
      await setupStripe();

      // Create paid event with only 1 spot
      const event = await createTestEvent({
        maxAttendees: 1,
        thankYouUrl: "https://example.com/thanks",
        unitPrice: 1000,
      });

      // Fill the event (using atomic to simulate production flow)
      await createAttendeeAtomic(event.id, "First", "first@example.com", "pi_first");

      // Try to register - should fail before Stripe session is created
      const response = await submitTicketForm(event.slug, {
        name: "Second",
        email: "second@example.com",
      });

      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("not enough spots available");
    });

    test("handles encryption error during payment confirmation", async () => {
      const { spyOn } = await import("#test-compat");
      const { stripeApi } = await import("#lib/stripe.ts");
      const { attendeesApi } = await import("#lib/db/attendees.ts");

      await setupStripe();

      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com/thanks",
        unitPrice: 1000,
      });

      await withMocks(
        () => ({
          mockRetrieve: spyOn(stripeApi, "retrieveCheckoutSession").mockResolvedValue({
            id: "cs_test",
            payment_status: "paid",
            payment_intent: "pi_test_123",
            metadata: {
              event_id: String(event.id),
              name: "John",
              email: "john@example.com",
              quantity: "1",
            },
          } as unknown as Awaited<
            ReturnType<typeof stripeApi.retrieveCheckoutSession>
          >),
          mockRefund: spyOn(stripeApi, "refundPayment").mockResolvedValue(
            { id: "re_test" } as unknown as Awaited<
              ReturnType<typeof stripeApi.refundPayment>
            >,
          ),
          mockAtomic: spyOn(attendeesApi, "createAttendeeAtomic").mockResolvedValue({
            success: false,
            reason: "encryption_error",
          }),
        }),
        async ({ mockRefund }) => {
          const response = await handleRequest(
            mockRequest("/payment/success?session_id=cs_test"),
          );

          expect(response.status).toBe(400);
          const html = await response.text();
          expect(html).toContain("Registration failed");
          expect(html).toContain("refunded");

          // Verify refund was called
          expect(mockRefund).toHaveBeenCalledWith("pi_test_123");
        },
      );
    });
  });

  describe("GET /payment/success (multi-ticket)", () => {
    afterEach(() => {
      resetStripeClient();
    });

    test("processes multi-ticket payment success", async () => {
      await setupStripe();

      const event1 = await createTestEvent({
        name: "Success Multi 1",
        maxAttendees: 50,
        unitPrice: 500,
      });
      const event2 = await createTestEvent({
        name: "Success Multi 2",
        maxAttendees: 50,
        unitPrice: 1000,
      });

      const mockRetrieve = spyOn(stripeApi, "retrieveCheckoutSession");
      mockRetrieve.mockResolvedValue({
        id: "cs_multi_success",
        payment_status: "paid",
        payment_intent: "pi_multi_success",
        metadata: {
          name: "Multi Payer",
          email: "multi@example.com",
          multi: "1",
          items: JSON.stringify([
            { e: event1.id, q: 1 },
            { e: event2.id, q: 2 },
          ]),
        },
      } as unknown as Awaited<
        ReturnType<typeof stripeApi.retrieveCheckoutSession>
      >);

      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_multi_success"),
        );
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain("Payment Successful");

        // Verify attendees created for both events
        const { getAttendeesRaw } = await import("#lib/db/attendees.ts");
        const attendees1 = await getAttendeesRaw(event1.id);
        const attendees2 = await getAttendeesRaw(event2.id);
        expect(attendees1.length).toBe(1);
        expect(attendees2.length).toBe(1);
        expect(attendees2[0]?.quantity).toBe(2);
      } finally {
        mockRetrieve.mockRestore();
      }
    });

    test("returns error for invalid multi-ticket metadata", async () => {
      await setupStripe();

      const mockRetrieve = spyOn(stripeApi, "retrieveCheckoutSession");
      mockRetrieve.mockResolvedValue({
        id: "cs_bad_multi",
        payment_status: "paid",
        payment_intent: "pi_bad",
        metadata: {
          name: "Bad",
          email: "bad@example.com",
          multi: "1",
          items: "not-an-array",
        },
      } as unknown as Awaited<
        ReturnType<typeof stripeApi.retrieveCheckoutSession>
      >);

      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_bad_multi"),
        );
        expect(response.status).toBe(400);
        const html = await response.text();
        expect(html).toContain("Invalid multi-ticket session data");
      } finally {
        mockRetrieve.mockRestore();
      }
    });

    test("refunds multi-ticket payment when event not found", async () => {
      await setupStripe();

      const mockRetrieve = spyOn(stripeApi, "retrieveCheckoutSession");
      mockRetrieve.mockResolvedValue({
        id: "cs_multi_notfound",
        payment_status: "paid",
        payment_intent: "pi_multi_notfound",
        metadata: {
          name: "Missing Event",
          email: "missing@example.com",
          multi: "1",
          items: JSON.stringify([{ e: 99999, q: 1 }]),
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
          mockRequest("/payment/success?session_id=cs_multi_notfound"),
        );
        expect(response.status).toBe(404);
        const html = await response.text();
        expect(html).toContain("Event not found");
        expect(mockRefund).toHaveBeenCalledWith("pi_multi_notfound");
      } finally {
        mockRetrieve.mockRestore();
        mockRefund.mockRestore();
      }
    });

    test("refunds multi-ticket payment when event is inactive", async () => {
      await setupStripe();

      const event = await createTestEvent({
        name: "Multi Inactive Pay",
        maxAttendees: 50,
        unitPrice: 500,
      });
      await deactivateTestEvent(event.id);

      const mockRetrieve = spyOn(stripeApi, "retrieveCheckoutSession");
      mockRetrieve.mockResolvedValue({
        id: "cs_multi_inactive",
        payment_status: "paid",
        payment_intent: "pi_multi_inactive",
        metadata: {
          name: "Inactive Event",
          email: "inactive@example.com",
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

      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_multi_inactive"),
        );
        expect(response.status).toBe(400);
        const html = await response.text();
        expect(html).toContain("no longer accepting registrations");
        expect(html).toContain("refunded");
      } finally {
        mockRetrieve.mockRestore();
        mockRefund.mockRestore();
      }
    });

    test("shows refund failure message when refund fails", async () => {
      await setupStripe();

      const event = await createTestEvent({
        maxAttendees: 1,
        unitPrice: 1000,
      });

      // Fill the event
      await createAttendeeAtomic(event.id, "First", "first@example.com", "pi_first");

      const mockRetrieve = spyOn(stripeApi, "retrieveCheckoutSession");
      mockRetrieve.mockResolvedValue({
        id: "cs_refund_fail",
        payment_status: "paid",
        payment_intent: "pi_refund_fail",
        metadata: {
          event_id: String(event.id),
          name: "Refund Fail",
          email: "refund@example.com",
          quantity: "1",
        },
      } as unknown as Awaited<
        ReturnType<typeof stripeApi.retrieveCheckoutSession>
      >);

      // Mock refund to fail
      const mockRefund = spyOn(stripeApi, "refundPayment");
      mockRefund.mockResolvedValue(null);

      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_refund_fail"),
        );
        expect(response.status).toBe(400);
        const html = await response.text();
        expect(html).toContain("sold out");
        expect(html).toContain("contact support");
      } finally {
        mockRetrieve.mockRestore();
        mockRefund.mockRestore();
      }
    });

    test("multi-ticket payment sold out rolls back and refunds", async () => {
      await setupStripe();

      const event1 = await createTestEvent({
        name: "Multi Rollback 1",
        maxAttendees: 50,
        unitPrice: 500,
      });
      const event2 = await createTestEvent({
        name: "Multi Rollback 2",
        maxAttendees: 1,
        unitPrice: 1000,
      });

      // Fill event2
      await createAttendeeAtomic(event2.id, "First", "first@example.com", "pi_first");

      const mockRetrieve = spyOn(stripeApi, "retrieveCheckoutSession");
      mockRetrieve.mockResolvedValue({
        id: "cs_multi_rollback",
        payment_status: "paid",
        payment_intent: "pi_multi_rollback",
        metadata: {
          name: "Rollback User",
          email: "rollback@example.com",
          multi: "1",
          items: JSON.stringify([
            { e: event1.id, q: 1 },
            { e: event2.id, q: 1 },
          ]),
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
          mockRequest("/payment/success?session_id=cs_multi_rollback"),
        );
        expect(response.status).toBe(400);
        const html = await response.text();
        expect(html).toContain("sold out");
        expect(html).toContain("refunded");

        // Verify rollback: event1 should have no attendees since they were rolled back
        const { getAttendeesRaw } = await import("#lib/db/attendees.ts");
        const attendees1 = await getAttendeesRaw(event1.id);
        expect(attendees1.length).toBe(0);
      } finally {
        mockRetrieve.mockRestore();
        mockRefund.mockRestore();
      }
    });

    test("shows thank_you_url for single-ticket success", async () => {
      await setupStripe();

      const event = await createTestEvent({
        maxAttendees: 50,
        unitPrice: 500,
        thankYouUrl: "https://example.com/single-thanks",
      });

      const mockRetrieve = spyOn(stripeApi, "retrieveCheckoutSession");
      mockRetrieve.mockResolvedValue({
        id: "cs_single_thankyou",
        payment_status: "paid",
        payment_intent: "pi_single_thankyou",
        metadata: {
          event_id: String(event.id),
          name: "Single",
          email: "single@example.com",
          quantity: "1",
        },
      } as unknown as Awaited<
        ReturnType<typeof stripeApi.retrieveCheckoutSession>
      >);

      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_single_thankyou"),
        );
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain("https://example.com/single-thanks");
      } finally {
        mockRetrieve.mockRestore();
      }
    });

    test("handles duplicate session replay (already processed)", async () => {
      await setupStripe();

      const event = await createTestEvent({
        maxAttendees: 50,
        unitPrice: 1000,
      });

      const mockRetrieve = spyOn(stripeApi, "retrieveCheckoutSession");
      mockRetrieve.mockResolvedValue({
        id: "cs_dupe_session",
        payment_status: "paid",
        payment_intent: "pi_dupe",
        metadata: {
          event_id: String(event.id),
          name: "Dupe",
          email: "dupe@example.com",
          quantity: "1",
        },
      } as unknown as Awaited<
        ReturnType<typeof stripeApi.retrieveCheckoutSession>
      >);

      try {
        // First request should succeed
        const response1 = await handleRequest(
          mockRequest("/payment/success?session_id=cs_dupe_session"),
        );
        expect(response1.status).toBe(200);

        // Second request (replay) should also succeed (idempotent)
        const response2 = await handleRequest(
          mockRequest("/payment/success?session_id=cs_dupe_session"),
        );
        expect(response2.status).toBe(200);

        // Should still only have one attendee
        const { getAttendeesRaw } = await import("#lib/db/attendees.ts");
        const attendees = await getAttendeesRaw(event.id);
        expect(attendees.length).toBe(1);
      } finally {
        mockRetrieve.mockRestore();
      }
    });
  });

});
