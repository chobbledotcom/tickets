import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { spy, stub } from "@std/testing/mock";
import { resetStripeClient, stripeApi } from "#lib/stripe.ts";
import { handleRequest } from "#routes";
import {
  assertPublicHtml,
  awaitTestRequest,
  bookAttendee,
  createTestEvent,
  deactivateTestEvent,
  describeWithEnv,
  expectFlash,
  expectHtmlResponse,
  expectRedirect,
  followRedirect,
  mockRequest,
  setTestEnv,
  setupStripe,
  singleItem,
  submitTicketForm,
  withMocks,
} from "#test-utils";

describeWithEnv("server (payment flow)", { db: true }, () => {
  describe("GET /payment/success", () => {
    test("returns error for missing session_id", async () => {
      const response = await handleRequest(mockRequest("/payment/success"));
      await expectHtmlResponse(response, 400, "Invalid payment callback");
    });

    test("returns error when no provider configured", async () => {
      const response = await handleRequest(
        mockRequest("/payment/success?session_id=cs_invalid"),
      );
      await expectHtmlResponse(
        response,
        400,
        "Payment provider not configured",
      );
    });

    test("returns error when session not found", async () => {
      await setupStripe();
      // When session ID doesn't exist in Stripe, retrieveCheckoutSession returns null
      const response = await handleRequest(
        mockRequest("/payment/success?session_id=cs_invalid"),
      );
      await expectHtmlResponse(response, 400, "Payment session not found");
    });

    test("returns error when payment not verified", async () => {
      const { stub } = await import("@std/testing/mock");
      const { stripeApi } = await import("#lib/stripe.ts");
      await setupStripe();

      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
        unitPrice: 1000,
      });

      await withMocks(
        () =>
          stub(stripeApi, "retrieveCheckoutSession", () =>
            Promise.resolve({
              id: "cs_test",
              metadata: {
                email: "john@example.com",
                items: singleItem(event.id, 1, 1000),
                name: "John",
              },
              payment_intent: "pi_test",
              payment_status: "unpaid",
            } as unknown as Awaited<
              ReturnType<typeof stripeApi.retrieveCheckoutSession>
            >),
          ),
        async () => {
          const response = await handleRequest(
            mockRequest("/payment/success?session_id=cs_test"),
          );
          await expectHtmlResponse(
            response,
            400,
            "Payment verification failed",
          );
        },
        resetStripeClient,
      );
    });

    test("returns error for invalid session metadata", async () => {
      const { stub } = await import("@std/testing/mock");
      const { stripeApi } = await import("#lib/stripe.ts");
      await setupStripe();

      await withMocks(
        () =>
          stub(stripeApi, "retrieveCheckoutSession", () =>
            Promise.resolve({
              id: "cs_test",
              metadata: {}, // Missing required fields
              payment_intent: "pi_test",
              payment_status: "paid",
            } as unknown as Awaited<
              ReturnType<typeof stripeApi.retrieveCheckoutSession>
            >),
          ),
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
      const { stub } = await import("@std/testing/mock");
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
          mockRefund: stub(stripeApi, "refundPayment", () =>
            Promise.resolve({ id: "re_test" } as unknown as Awaited<
              ReturnType<typeof stripeApi.refundPayment>
            >),
          ),
          mockRetrieve: stub(stripeApi, "retrieveCheckoutSession", () =>
            Promise.resolve({
              id: "cs_test",
              metadata: {
                email: "john@example.com",
                items: singleItem(event.id, 1, 1000),
                name: "John",
              },
              payment_intent: "pi_test_123",
              payment_status: "paid",
            } as unknown as Awaited<
              ReturnType<typeof stripeApi.retrieveCheckoutSession>
            >),
          ),
        }),
        async ({ mockRefund }) => {
          const response = await handleRequest(
            mockRequest("/payment/success?session_id=cs_test"),
          );
          await expectHtmlResponse(
            response,
            410,
            "no longer accepting registrations",
          );

          // Verify refund was called
          expect(mockRefund.calls[0]!.args).toEqual(["pi_test_123"]);
        },
        resetStripeClient,
      );
    });

    test("refunds payment when event is sold out at confirmation time", async () => {
      const { stub } = await import("@std/testing/mock");
      const { stripeApi } = await import("#lib/stripe.ts");
      await setupStripe();

      // Create event with only 1 spot
      const event = await createTestEvent({
        maxAttendees: 1,
        thankYouUrl: "https://example.com",
        unitPrice: 1000,
      });

      // Fill the event with another attendee (using atomic to simulate production flow)
      await bookAttendee(event, {
        email: "first@example.com",
        name: "First",
        paymentId: "pi_first",
      });

      await withMocks(
        () => ({
          mockRefund: stub(stripeApi, "refundPayment", () =>
            Promise.resolve({ id: "re_test" } as unknown as Awaited<
              ReturnType<typeof stripeApi.refundPayment>
            >),
          ),
          mockRetrieve: stub(stripeApi, "retrieveCheckoutSession", () =>
            Promise.resolve({
              amount_total: 1000,
              id: "cs_test",
              metadata: {
                email: "second@example.com",
                items: singleItem(event.id, 1, 1000),
                name: "Second",
              },
              payment_intent: "pi_second",
              payment_status: "paid",
            } as unknown as Awaited<
              ReturnType<typeof stripeApi.retrieveCheckoutSession>
            >),
          ),
        }),
        async ({ mockRefund }) => {
          const response = await handleRequest(
            mockRequest("/payment/success?session_id=cs_test"),
          );
          await expectHtmlResponse(
            response,
            409,
            "sold out",
            "automatically refunded",
          );

          // Verify refund was called
          expect(mockRefund.calls[0]!.args).toEqual(["pi_second"]);
        },
        resetStripeClient,
      );
    });
  });

  describe("GET /payment/cancel", () => {
    test("returns error for missing session_id", async () => {
      const response = await handleRequest(mockRequest("/payment/cancel"));
      await expectHtmlResponse(response, 400, "Invalid payment callback");
    });

    test("returns error when session not found", async () => {
      const { stub } = await import("@std/testing/mock");
      const { stripeApi } = await import("#lib/stripe.ts");
      await setupStripe();

      await withMocks(
        () =>
          stub(stripeApi, "retrieveCheckoutSession", () =>
            Promise.resolve(null),
          ),
        async () => {
          const response = await handleRequest(
            mockRequest("/payment/cancel?session_id=cs_invalid"),
          );
          await expectHtmlResponse(response, 400, "Payment session not found");
        },
        resetStripeClient,
      );
    });

    test("returns error for invalid session metadata", async () => {
      const { stub } = await import("@std/testing/mock");
      const { stripeApi } = await import("#lib/stripe.ts");
      await setupStripe();

      await withMocks(
        () =>
          stub(stripeApi, "retrieveCheckoutSession", () =>
            Promise.resolve({
              id: "cs_test_cancel",
              metadata: {}, // Missing required fields
              payment_status: "unpaid",
            } as unknown as Awaited<
              ReturnType<typeof stripeApi.retrieveCheckoutSession>
            >),
          ),
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
      const { stub } = await import("@std/testing/mock");
      const { stripeApi } = await import("#lib/stripe.ts");
      await setupStripe();

      await withMocks(
        () =>
          stub(stripeApi, "retrieveCheckoutSession", () =>
            Promise.resolve({
              id: "cs_test_cancel",
              metadata: {
                email: "john@example.com",
                items: singleItem(99999, 1, 0), // Non-existent event
                name: "John",
              },
              payment_status: "unpaid",
            } as unknown as Awaited<
              ReturnType<typeof stripeApi.retrieveCheckoutSession>
            >),
          ),
        async () => {
          const response = await handleRequest(
            mockRequest("/payment/cancel?session_id=cs_test_cancel"),
          );
          await expectHtmlResponse(response, 404, "Event not found");
        },
        resetStripeClient,
      );
    });

    test("shows cancel page with link back to ticket form", async () => {
      const { stub } = await import("@std/testing/mock");
      const { stripeApi } = await import("#lib/stripe.ts");
      await setupStripe();

      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
        unitPrice: 1000,
      });

      await withMocks(
        () =>
          stub(stripeApi, "retrieveCheckoutSession", () =>
            Promise.resolve({
              id: "cs_test_cancel",
              metadata: {
                email: "john@example.com",
                items: singleItem(event.id, 1, 1000),
                name: "John",
              },
              payment_status: "unpaid",
            } as unknown as Awaited<
              ReturnType<typeof stripeApi.retrieveCheckoutSession>
            >),
          ),
        async () => {
          await assertPublicHtml(
            "/payment/cancel?session_id=cs_test_cancel",
            "Payment Cancelled",
            `/ticket/${event.slug}`,
          );
        },
        resetStripeClient,
      );
    });

    test("shows cancel page for ticket session", async () => {
      const { stub } = await import("@std/testing/mock");
      const { stripeApi } = await import("#lib/stripe.ts");
      await setupStripe();

      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
        unitPrice: 1000,
      });
      const event2 = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
        unitPrice: 2000,
      });

      await withMocks(
        () =>
          stub(stripeApi, "retrieveCheckoutSession", () =>
            Promise.resolve({
              id: "cs_test_cancel_multi",
              metadata: {
                email: "john@example.com",
                items: JSON.stringify([
                  { e: event.id, p: 1000, q: 1 },
                  { e: event2.id, p: 4000, q: 2 },
                ]),
                name: "John",
              },
              payment_status: "unpaid",
            } as unknown as Awaited<
              ReturnType<typeof stripeApi.retrieveCheckoutSession>
            >),
          ),
        async () => {
          await assertPublicHtml(
            "/payment/cancel?session_id=cs_test_cancel_multi",
            "Payment Cancelled",
            `/ticket/${event.slug}`,
          );
        },
        resetStripeClient,
      );
    });

    test("returns 404 for ticket session with invalid items", async () => {
      const { stub } = await import("@std/testing/mock");
      const { stripeApi } = await import("#lib/stripe.ts");
      await setupStripe();

      await withMocks(
        () =>
          stub(stripeApi, "retrieveCheckoutSession", () =>
            Promise.resolve({
              id: "cs_test_cancel_bad_multi",
              metadata: {
                email: "john@example.com",
                items: "[]", // Empty items array
                name: "John",
              },
              payment_status: "unpaid",
            } as unknown as Awaited<
              ReturnType<typeof stripeApi.retrieveCheckoutSession>
            >),
          ),
        async () => {
          const response = await handleRequest(
            mockRequest("/payment/cancel?session_id=cs_test_cancel_bad_multi"),
          );
          await expectHtmlResponse(response, 404, "Event not found");
        },
        resetStripeClient,
      );
    });
  });

  describe("payment routes", () => {
    test("returns 404 for unsupported method on payment routes", async () => {
      const response = await awaitTestRequest("/payment/success", {
        data: {},
        method: "POST",
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
        email: "john@example.com",
        name: "John Doe",
      });

      // Should redirect with error because Stripe session creation fails
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Failed to create payment session"),
        false,
      );
    });

    test("shows specific error when payment provider returns validation error", async () => {
      await setupStripe();

      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com/thanks",
        unitPrice: 1000,
      });

      // Mock createCheckoutSession to return a validation error result
      const { stripePaymentProvider } = await import("#lib/stripe-provider.ts");
      const mockCreate = stub(
        stripePaymentProvider,
        "createCheckoutSession",
        () =>
          Promise.resolve({
            error:
              "The payment processor rejected the phone number as invalid. Please correct it and try again.",
          }),
      );

      try {
        const response = await submitTicketForm(event.slug, {
          email: "john@example.com",
          name: "John Doe",
        });

        expect(response.status).toBe(302);
        expectFlash(
          response,
          expect.stringContaining(
            "payment processor rejected the phone number",
          ),
          false,
        );
      } finally {
        mockCreate.restore();
      }
    });

    test("free ticket still works when payments enabled", async () => {
      await setupStripe("sk_test_fake_key");

      // Create a free event (no price)
      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com/thanks",
        unitPrice: 0, // free
      });

      const response = await submitTicketForm(event.slug, {
        email: "john@example.com",
        name: "John Doe",
      });

      // Should redirect to thank you page
      expectRedirect(response, "https://example.com/thanks");
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
        email: "john@example.com",
        name: "John Doe",
      });

      // Should redirect to thank you page (no payment required)
      expectRedirect(response, "https://example.com/thanks");
    });

    test("redirects to Stripe checkout with stripe-mock", async () => {
      await setupStripe();

      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com/thanks",
        unitPrice: 1000, // 10.00 price
      });

      const response = await submitTicketForm(event.slug, {
        email: "john@example.com",
        name: "John Doe",
      });

      // Should redirect to Stripe checkout URL
      expect(response.status).toBe(302);
      const location = response.headers.get("location");
      expect(location).not.toBeNull();
      // stripe-mock returns a URL starting with https://
      expect(location?.startsWith("https://")).toBe(true);
    });

    test("returns error when event not found in session metadata without refund", async () => {
      const { spy, stub } = await import("@std/testing/mock");
      const { stripeApi } = await import("#lib/stripe.ts");
      await setupStripe();

      await withMocks(
        () => ({
          mockRefund: spy(stripeApi, "refundPayment"),
          mockRetrieve: stub(stripeApi, "retrieveCheckoutSession", () =>
            Promise.resolve({
              id: "cs_test",
              metadata: {
                email: "john@example.com",
                items: singleItem(99999, 1, 0), // Non-existent event
                name: "John",
              },
              payment_intent: "pi_test",
              payment_status: "paid",
            } as unknown as Awaited<
              ReturnType<typeof stripeApi.retrieveCheckoutSession>
            >),
          ),
        }),
        async ({ mockRefund }) => {
          const response = await handleRequest(
            mockRequest("/payment/success?session_id=cs_test"),
          );
          await expectHtmlResponse(response, 404, "Event not found");
          // Event not found should NOT trigger a refund (webhook may be for a different instance)
          expect(mockRefund.calls.length).toBe(0);
        },
        resetStripeClient,
      );
    });

    test("creates attendee and shows success when payment verified", async () => {
      const { stub } = await import("@std/testing/mock");
      const { stripeApi } = await import("#lib/stripe.ts");

      await setupStripe();

      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com/thanks",
        unitPrice: 1000,
      });

      await withMocks(
        () =>
          stub(stripeApi, "retrieveCheckoutSession", () =>
            Promise.resolve({
              amount_total: 1000,
              id: "cs_test_paid",
              metadata: {
                email: "john@example.com",
                items: singleItem(event.id, 1, 1000),
                name: "John",
              },
              payment_intent: "pi_test_123",
              payment_status: "paid",
            } as unknown as Awaited<
              ReturnType<typeof stripeApi.retrieveCheckoutSession>
            >),
          ),
        async () => {
          const redirectResponse = await handleRequest(
            mockRequest("/payment/success?session_id=cs_test_paid"),
          );

          // Should redirect with tokens
          expectRedirect(redirectResponse, /^\/payment\/success\?tokens=.+$/);

          // Follow the redirect
          const response = await followRedirect(
            redirectResponse,
            handleRequest,
          );
          await expectHtmlResponse(
            response,
            200,
            "Thank you for your order",
            "https://example.com/thanks",
            "Click here to view your ticket",
            'target="_blank"',
          );

          // Verify attendee was created with encrypted PII blob
          const { getAttendeesRaw } = await import("#lib/db/attendees.ts");
          const attendees = await getAttendeesRaw(event.id);
          expect(attendees.length).toBe(1);
          expect(attendees[0]?.pii_blob).not.toBe("");

          // Verify tokens are NOT persisted in DB (redirect has them in URL, no need to store)
          const { isSessionProcessed } = await import(
            "#lib/db/processed-payments.ts"
          );
          const record = await isSessionProcessed("cs_test_paid");
          expect(record?.ticket_tokens).toBe("");
        },
      );
    });

    test("handles replay of same session (idempotent)", async () => {
      const { stub } = await import("@std/testing/mock");
      const { stripeApi } = await import("#lib/stripe.ts");

      await setupStripe();

      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com/thanks",
        unitPrice: 1000,
      });

      // Create attendee as if payment was already processed (using atomic to simulate production flow)
      await bookAttendee(event, {
        email: "john@example.com",
        name: "John",
        paymentId: "pi_test_123",
      });

      await withMocks(
        () =>
          stub(stripeApi, "retrieveCheckoutSession", () =>
            Promise.resolve({
              amount_total: 1000,
              id: "cs_test_paid",
              metadata: {
                email: "john@example.com",
                items: singleItem(event.id, 1, 1000),
                name: "John",
              },
              payment_intent: "pi_test_123",
              payment_status: "paid",
            } as unknown as Awaited<
              ReturnType<typeof stripeApi.retrieveCheckoutSession>
            >),
          ),
        async () => {
          const response = await handleRequest(
            mockRequest("/payment/success?session_id=cs_test_paid"),
          );

          // Capacity check will now fail since we already have the attendee
          // This is expected - in the new flow, replaying creates a duplicate attempt
          // which fails the capacity check if event is near full
          // For idempotent behavior, we'd need to check payment_intent uniqueness
          // Response is either a 302 redirect (with tokens) or 200 (direct render for replay)
          expect([200, 302]).toContain(response.status);
        },
      );
    });

    test("handles multiple quantity purchase", async () => {
      const { stub } = await import("@std/testing/mock");
      const { stripeApi } = await import("#lib/stripe.ts");

      await setupStripe();

      const event = await createTestEvent({
        maxAttendees: 50,
        maxQuantity: 5,
        thankYouUrl: "https://example.com/thanks",
        unitPrice: 1000,
      });

      await withMocks(
        () =>
          stub(stripeApi, "retrieveCheckoutSession", () =>
            Promise.resolve({
              amount_total: 3000,
              id: "cs_test_paid",
              metadata: {
                email: "john@example.com",
                items: singleItem(event.id, 3, 3000),
                name: "John",
              },
              payment_intent: "pi_test_123",
              payment_status: "paid",
            } as unknown as Awaited<
              ReturnType<typeof stripeApi.retrieveCheckoutSession>
            >),
          ),
        async () => {
          const redirectResponse = await handleRequest(
            mockRequest("/payment/success?session_id=cs_test_paid"),
          );

          expect(redirectResponse.status).toBe(302);
          const response = await followRedirect(
            redirectResponse,
            handleRequest,
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
      await bookAttendee(event, {
        email: "first@example.com",
        name: "First",
        paymentId: "pi_first",
      });

      // Try to register - should fail before Stripe session is created
      const response = await submitTicketForm(event.slug, {
        email: "second@example.com",
        name: "Second",
      });

      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("not enough spots available"),
        false,
      );
    });

    test("handles encryption error during payment confirmation", async () => {
      const { stub } = await import("@std/testing/mock");
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
          mockAtomic: stub(attendeesApi, "createAttendeeAtomic", () =>
            Promise.resolve({
              reason: "encryption_error",
              success: false,
            }),
          ),
          mockRefund: stub(stripeApi, "refundPayment", () =>
            Promise.resolve({ id: "re_test" } as unknown as Awaited<
              ReturnType<typeof stripeApi.refundPayment>
            >),
          ),
          mockRetrieve: stub(stripeApi, "retrieveCheckoutSession", () =>
            Promise.resolve({
              amount_total: 1000,
              id: "cs_test",
              metadata: {
                email: "john@example.com",
                items: singleItem(event.id, 1, 1000),
                name: "John",
              },
              payment_intent: "pi_test_123",
              payment_status: "paid",
            } as unknown as Awaited<
              ReturnType<typeof stripeApi.retrieveCheckoutSession>
            >),
          ),
        }),
        async ({ mockRefund }) => {
          const response = await handleRequest(
            mockRequest("/payment/success?session_id=cs_test"),
          );

          await expectHtmlResponse(
            response,
            500,
            "Registration failed",
            "refunded",
          );

          // Verify refund was called
          expect(mockRefund.calls[0]!.args).toEqual(["pi_test_123"]);
        },
      );
    });
  });

  describe("GET /payment/success (ticket)", () => {
    afterEach(() => {
      resetStripeClient();
    });

    test("processes ticket payment success", async () => {
      await setupStripe();

      const event1 = await createTestEvent({
        maxAttendees: 50,
        name: "Success Multi 1",
        unitPrice: 500,
      });
      const event2 = await createTestEvent({
        maxAttendees: 50,
        name: "Success Multi 2",
        unitPrice: 1000,
      });

      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          amount_total: 2500,
          id: "cs_multi_success",
          metadata: {
            email: "multi@example.com",

            items: JSON.stringify([
              { e: event1.id, p: 500, q: 1 },
              { e: event2.id, p: 2000, q: 2 },
            ]),
            name: "Multi Payer",
          },
          payment_intent: "pi_multi_success",
          payment_status: "paid",
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
      );

      try {
        const redirectResponse = await handleRequest(
          mockRequest("/payment/success?session_id=cs_multi_success"),
        );
        // With multi-event attendees, one token covers all events
        expectRedirect(redirectResponse, /^\/payment\/success\?tokens=.+$/);

        const response = await followRedirect(redirectResponse, handleRequest);
        await expectHtmlResponse(
          response,
          200,
          "Thank you for your order",
          "Click here to view your ticket",
        );

        // Verify attendees created for both events
        const { getAttendeesRaw } = await import("#lib/db/attendees.ts");
        const attendees1 = await getAttendeesRaw(event1.id);
        const attendees2 = await getAttendeesRaw(event2.id);
        expect(attendees1.length).toBe(1);
        expect(attendees2.length).toBe(1);
        expect(attendees2[0]?.quantity).toBe(2);
      } finally {
        mockRetrieve.restore();
      }
    });

    test("returns error for invalid ticket metadata", async () => {
      await setupStripe();

      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          id: "cs_bad_multi",
          metadata: {
            email: "bad@example.com",

            items: "not-an-array",
            name: "Bad",
          },
          payment_intent: "pi_bad",
          payment_status: "paid",
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
      );

      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_bad_multi"),
        );
        await expectHtmlResponse(response, 400, "Invalid session data");
      } finally {
        mockRetrieve.restore();
      }
    });

    test("skips refund for ticket payment when event not found", async () => {
      await setupStripe();

      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          id: "cs_multi_notfound",
          metadata: {
            email: "missing@example.com",

            items: JSON.stringify([{ e: 99999, p: 500, q: 1 }]),
            name: "Missing Event",
          },
          payment_intent: "pi_multi_notfound",
          payment_status: "paid",
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
      );

      const mockRefund = spy(stripeApi, "refundPayment");

      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_multi_notfound"),
        );
        await expectHtmlResponse(response, 404, "Event not found");
        // Event not found should NOT trigger a refund (webhook may be for a different instance)
        expect(mockRefund.calls.length).toBe(0);
      } finally {
        mockRetrieve.restore();
        mockRefund.restore();
      }
    });

    test("refunds ticket payment when event is inactive", async () => {
      await setupStripe();

      const event = await createTestEvent({
        maxAttendees: 50,
        name: "Multi Inactive Pay",
        unitPrice: 500,
      });
      await deactivateTestEvent(event.id);

      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          id: "cs_multi_inactive",
          metadata: {
            email: "inactive@example.com",

            items: JSON.stringify([{ e: event.id, p: 500, q: 1 }]),
            name: "Inactive Event",
          },
          payment_intent: "pi_multi_inactive",
          payment_status: "paid",
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
      );

      const mockRefund = stub(stripeApi, "refundPayment", () =>
        Promise.resolve({ id: "re_test" } as unknown as Awaited<
          ReturnType<typeof stripeApi.refundPayment>
        >),
      );

      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_multi_inactive"),
        );
        await expectHtmlResponse(
          response,
          410,
          "no longer accepting registrations",
          "refunded",
        );
      } finally {
        mockRetrieve.restore();
        mockRefund.restore();
      }
    });

    test("shows refund failure message when refund fails", async () => {
      await setupStripe();

      const event = await createTestEvent({
        maxAttendees: 1,
        unitPrice: 1000,
      });

      // Fill the event
      await bookAttendee(event, {
        email: "first@example.com",
        name: "First",
        paymentId: "pi_first",
      });

      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          amount_total: 1000,
          id: "cs_refund_fail",
          metadata: {
            email: "refund@example.com",
            items: singleItem(event.id, 1, 1000),
            name: "Refund Fail",
          },
          payment_intent: "pi_refund_fail",
          payment_status: "paid",
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
      );

      // Mock refund to fail
      const mockRefund = stub(stripeApi, "refundPayment", () =>
        Promise.resolve(null),
      );

      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_refund_fail"),
        );
        await expectHtmlResponse(response, 409, "sold out", "contact support");
      } finally {
        mockRetrieve.restore();
        mockRefund.restore();
      }
    });

    test("ticket payment sold out rolls back and refunds", async () => {
      await setupStripe();

      const event1 = await createTestEvent({
        maxAttendees: 50,
        name: "Multi Rollback 1",
        unitPrice: 500,
      });
      const event2 = await createTestEvent({
        maxAttendees: 1,
        name: "Multi Rollback 2",
        unitPrice: 1000,
      });

      // Fill event2
      await bookAttendee(event2, {
        email: "first@example.com",
        name: "First",
        paymentId: "pi_first",
      });

      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          amount_total: 1500,
          id: "cs_multi_rollback",
          metadata: {
            email: "rollback@example.com",

            items: JSON.stringify([
              { e: event1.id, p: 500, q: 1 },
              { e: event2.id, p: 1000, q: 1 },
            ]),
            name: "Rollback User",
          },
          payment_intent: "pi_multi_rollback",
          payment_status: "paid",
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
      );

      const mockRefund = stub(stripeApi, "refundPayment", () =>
        Promise.resolve({ id: "re_test" } as unknown as Awaited<
          ReturnType<typeof stripeApi.refundPayment>
        >),
      );

      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_multi_rollback"),
        );
        await expectHtmlResponse(response, 409, "sold out", "refunded");

        // Verify rollback: event1 should have no attendees since they were rolled back
        const { getAttendeesRaw } = await import("#lib/db/attendees.ts");
        const attendees1 = await getAttendeesRaw(event1.id);
        expect(attendees1.length).toBe(0);
      } finally {
        mockRetrieve.restore();
        mockRefund.restore();
      }
    });

    test("shows thank_you_url for single-ticket success", async () => {
      await setupStripe();

      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com/single-thanks",
        unitPrice: 500,
      });

      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          amount_total: 500,
          id: "cs_single_thankyou",
          metadata: {
            email: "single@example.com",
            items: singleItem(event.id, 1, 500),
            name: "Single",
          },
          payment_intent: "pi_single_thankyou",
          payment_status: "paid",
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
      );

      try {
        const redirectResponse = await handleRequest(
          mockRequest("/payment/success?session_id=cs_single_thankyou"),
        );
        expect(redirectResponse.status).toBe(302);
        const response = await followRedirect(redirectResponse, handleRequest);
        await expectHtmlResponse(
          response,
          200,
          "https://example.com/single-thanks",
          "Click here to view your ticket",
        );
      } finally {
        mockRetrieve.restore();
      }
    });

    test("handles duplicate session replay (already processed)", async () => {
      await setupStripe();

      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com/replay-thanks",
        unitPrice: 1000,
      });

      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          amount_total: 1000,
          id: "cs_dupe_session",
          metadata: {
            email: "dupe@example.com",
            items: singleItem(event.id, 1, 1000),
            name: "Dupe",
          },
          payment_intent: "pi_dupe",
          payment_status: "paid",
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
      );

      try {
        // First request should redirect with tokens
        const response1 = await handleRequest(
          mockRequest("/payment/success?session_id=cs_dupe_session"),
        );
        expect(response1.status).toBe(302);

        // Second request (replay) renders directly — redirect path doesn't store tokens,
        // so replay has no tokens to redirect with
        const response2 = await handleRequest(
          mockRequest("/payment/success?session_id=cs_dupe_session"),
        );
        expect(response2.status).toBe(200);
        const html = await response2.text();
        expect(html).toContain("Thank you for your order");

        // Should still only have one attendee
        const { getAttendeesRaw } = await import("#lib/db/attendees.ts");
        const attendees = await getAttendeesRaw(event.id);
        expect(attendees.length).toBe(1);
      } finally {
        mockRetrieve.restore();
      }
    });

    test("handles single-item cart session replay (shows thank_you_url)", async () => {
      await setupStripe();

      const event = await createTestEvent({
        maxAttendees: 50,
        name: "Cart Single",
        thankYouUrl: "https://example.com/cart-thanks",
        unitPrice: 800,
      });

      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          amount_total: 800,
          id: "cs_cart_single",
          metadata: {
            email: "cartsingle@example.com",

            items: JSON.stringify([{ e: event.id, p: 800, q: 1 }]),
            name: "Cart Single Buyer",
          },
          payment_intent: "pi_cart_single",
          payment_status: "paid",
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
      );

      try {
        // First request: process and redirect with tokens
        const response1 = await handleRequest(
          mockRequest("/payment/success?session_id=cs_cart_single"),
        );
        expect(response1.status).toBe(302);

        // Follow redirect to render success page with tokens
        const tokenResponse = await followRedirect(response1, handleRequest);
        const tokenHtml = await tokenResponse.text();
        // Single-event cart: token path resolves one unique event → shows thank_you_url
        expect(tokenHtml).toContain("redirected");

        // Replay (no tokens stored): renders directly via items.length === 1 branch
        const response2 = await handleRequest(
          mockRequest("/payment/success?session_id=cs_cart_single"),
        );
        expect(response2.status).toBe(200);
        const html = await response2.text();
        expect(html).toContain("Thank you for your order");
        // Single-item cart replay also shows thank_you_url
        expect(html).toContain("redirected");
      } finally {
        mockRetrieve.restore();
      }
    });

    test("handles ticket duplicate session replay (already processed)", async () => {
      await setupStripe();

      const event1 = await createTestEvent({
        maxAttendees: 50,
        name: "Replay Multi 1",
        unitPrice: 500,
      });
      const event2 = await createTestEvent({
        maxAttendees: 50,
        name: "Replay Multi 2",
        unitPrice: 1000,
      });

      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          amount_total: 1500,
          id: "cs_multi_dupe",
          metadata: {
            email: "multireplay@example.com",

            items: JSON.stringify([
              { e: event1.id, p: 500, q: 1 },
              { e: event2.id, p: 1000, q: 1 },
            ]),
            name: "Multi Replay",
          },
          payment_intent: "pi_multi_dupe",
          payment_status: "paid",
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
      );

      try {
        // First request should redirect with tokens
        const response1 = await handleRequest(
          mockRequest("/payment/success?session_id=cs_multi_dupe"),
        );
        expect(response1.status).toBe(302);

        // Second request (replay) renders directly — redirect path doesn't store tokens,
        // so replay has no tokens to redirect with
        const response2 = await handleRequest(
          mockRequest("/payment/success?session_id=cs_multi_dupe"),
        );
        expect(response2.status).toBe(200);
        const html = await response2.text();
        expect(html).toContain("Thank you for your order");
      } finally {
        mockRetrieve.restore();
      }
    });
  });

  describe("payment success token verification", () => {
    test("returns error for tokens param with only delimiters", async () => {
      // %2B decodes to "+", parseTokens produces empty array, no tokens to verify
      const response = await handleRequest(
        mockRequest("/payment/success?tokens=%2B"),
      );
      expect(response.status).toBe(400);
    });

    test("returns error for empty tokens param", async () => {
      // Empty string is falsy → falls through to final error
      const response = await handleRequest(
        mockRequest("/payment/success?tokens="),
      );
      expect(response.status).toBe(400);
    });

    test("returns error for invalid tokens not in database", async () => {
      const response = await handleRequest(
        mockRequest("/payment/success?tokens=nonexistent_token"),
      );
      expect(response.status).toBe(400);
    });

    test("returns error when no session_id or tokens param", async () => {
      const response = await handleRequest(mockRequest("/payment/success"));
      expect(response.status).toBe(400);
    });

    test("renders ticket link from verified tokens", async () => {
      await setupStripe();

      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com/verified-thanks",
        unitPrice: 500,
      });

      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          amount_total: 500,
          id: "cs_token_verify",
          metadata: {
            email: "verify@example.com",
            items: singleItem(event.id, 1, 500),
            name: "Token Verify",
          },
          payment_intent: "pi_token_verify",
          payment_status: "paid",
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
      );

      try {
        // Process payment to get redirect with token
        const redirectResponse = await handleRequest(
          mockRequest("/payment/success?session_id=cs_token_verify"),
        );
        const location = expectRedirect(redirectResponse);

        // Follow redirect to verify tokens and render page
        const response = await followRedirect(redirectResponse, handleRequest);
        expect(response.status).toBe(200);
        const html = await response.text();

        // Should have ticket link with verified token
        expect(html).toContain("Click here to view your ticket");
        expect(html).toContain('target="_blank"');
        expect(html).toContain("/t/");

        // Should have thank_you_url for single-event purchase
        expect(html).toContain("https://example.com/verified-thanks");

        // Token in the link should match the one in the redirect URL
        const tokenFromUrl = decodeURIComponent(location.split("tokens=")[1]!);
        expect(html).toContain(`/t/${tokenFromUrl}`);
      } finally {
        mockRetrieve.restore();
      }
    });

    test("shows email notice on payment success when email configured", async () => {
      const event = await createTestEvent({
        maxAttendees: 50,
        unitPrice: 500,
      });

      // Create attendee directly (simulates post-payment state)
      const result = await bookAttendee(event, {
        email: "buyer@example.com",
        name: "Email Test",
        paymentId: "pi_email_notice",
        pricePaid: 500,
      });
      if (!result.success) throw new Error("Failed to create attendee");

      const restore = setTestEnv({
        HOST_EMAIL_API_KEY: "re_test123",
        HOST_EMAIL_FROM_ADDRESS: "noreply@tickets.com",
        HOST_EMAIL_PROVIDER: "resend",
      });

      try {
        const response = await handleRequest(
          mockRequest(
            `/payment/success?tokens=${encodeURIComponent(
              result.attendees[0]!.ticket_token,
            )}`,
          ),
        );
        const html = await expectHtmlResponse(response, 200, "Junk/Spam");
        expect(html).toContain("noreply@tickets.com");
      } finally {
        restore();
      }
    });
  });
});
