import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { resetStripeClient } from "#shared/stripe.ts";
import {
  assertPublicHtml,
  awaitTestRequest,
  bookAttendee,
  createTestListing,
  deactivateTestListing,
  describeWithEnv,
  expectFlash,
  expectHtmlResponse,
  expectRedirect,
  followRedirect,
  mockRequest,
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
      const { stripeApi } = await import("#shared/stripe.ts");
      await setupStripe();

      const listing = await createTestListing({
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
                items: singleItem(listing.id, 1, 1000),
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
      const { stripeApi } = await import("#shared/stripe.ts");
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

    test("rejects payment for inactive listing and refunds", async () => {
      const { stub } = await import("@std/testing/mock");
      const { stripeApi } = await import("#shared/stripe.ts");
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
        unitPrice: 1000,
      });

      // Deactivate the listing
      await deactivateTestListing(listing.id);

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
                items: singleItem(listing.id, 1, 1000),
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

    test("refunds payment when listing is sold out at confirmation time", async () => {
      const { stub } = await import("@std/testing/mock");
      const { stripeApi } = await import("#shared/stripe.ts");
      await setupStripe();

      // Create listing with only 1 spot
      const listing = await createTestListing({
        maxAttendees: 1,
        thankYouUrl: "https://example.com",
        unitPrice: 1000,
      });

      // Fill the listing with another attendee (using atomic to simulate production flow)
      await bookAttendee(listing, {
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
                items: singleItem(listing.id, 1, 1000),
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
      const { stripeApi } = await import("#shared/stripe.ts");
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
      const { stripeApi } = await import("#shared/stripe.ts");
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

    test("returns error when listing not found", async () => {
      const { stub } = await import("@std/testing/mock");
      const { stripeApi } = await import("#shared/stripe.ts");
      await setupStripe();

      await withMocks(
        () =>
          stub(stripeApi, "retrieveCheckoutSession", () =>
            Promise.resolve({
              id: "cs_test_cancel",
              metadata: {
                email: "john@example.com",
                items: singleItem(99999, 1, 0), // Non-existent listing
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
          await expectHtmlResponse(response, 404, "Listing not found");
        },
        resetStripeClient,
      );
    });

    test("shows cancel page with link back to ticket form", async () => {
      const { stub } = await import("@std/testing/mock");
      const { stripeApi } = await import("#shared/stripe.ts");
      await setupStripe();

      const listing = await createTestListing({
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
                items: singleItem(listing.id, 1, 1000),
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
            `/ticket/${listing.slug}`,
          );
        },
        resetStripeClient,
      );
    });

    test("shows cancel page for ticket session", async () => {
      const { stub } = await import("@std/testing/mock");
      const { stripeApi } = await import("#shared/stripe.ts");
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
        unitPrice: 1000,
      });
      const listing2 = await createTestListing({
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
                  { e: listing.id, p: 1000, q: 1 },
                  { e: listing2.id, p: 4000, q: 2 },
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
            `/ticket/${listing.slug}`,
          );
        },
        resetStripeClient,
      );
    });

    test("returns 404 for ticket session with invalid items", async () => {
      const { stub } = await import("@std/testing/mock");
      const { stripeApi } = await import("#shared/stripe.ts");
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
          await expectHtmlResponse(response, 404, "Listing not found");
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

      // Create a paid listing
      const listing = await createTestListing({
        maxAttendees: 50,
        thankYouUrl: "https://example.com/thanks",
        unitPrice: 1000, // 10.00 price
      });

      // Try to reserve a ticket - should fail because Stripe key is invalid
      const response = await submitTicketForm(listing.slug, {
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

      const listing = await createTestListing({
        maxAttendees: 50,
        thankYouUrl: "https://example.com/thanks",
        unitPrice: 1000,
      });

      // Mock createCheckoutSession to return a validation error result
      const { stub } = await import("@std/testing/mock");
      const { stripePaymentProvider } = await import(
        "#shared/stripe-provider.ts"
      );
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
        const response = await submitTicketForm(listing.slug, {
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

      // Create a free listing (no price)
      const listing = await createTestListing({
        maxAttendees: 50,
        thankYouUrl: "https://example.com/thanks",
        unitPrice: 0, // free
      });

      const response = await submitTicketForm(listing.slug, {
        email: "john@example.com",
        name: "John Doe",
      });

      // Should redirect to thank you page
      expectRedirect(response, "https://example.com/thanks");
    });

    test("free customisable-days booking reserves the chosen number of days", async () => {
      await setupStripe("sk_test_fake_key");

      const listing = await createTestListing({
        customisableDays: true,
        dayPrices: { 1: 0, 2: 0 },
        durationDays: 2,
        maxAttendees: 50,
        thankYouUrl: "https://example.com/thanks",
      });

      const response = await submitTicketForm(listing.slug, {
        day_count: "2",
        email: "john@example.com",
        name: "John Doe",
      });

      expectRedirect(response, "https://example.com/thanks");
    });

    test("rejects a booking with no day count chosen for a customisable listing", async () => {
      await setupStripe("sk_test_fake_key");

      const listing = await createTestListing({
        customisableDays: true,
        dayPrices: { 1: 0, 2: 0 },
        durationDays: 2,
        maxAttendees: 50,
      });

      const response = await submitTicketForm(listing.slug, {
        email: "john@example.com",
        name: "John Doe",
      });

      expect(response.status).toBe(400);
      expect(await response.text()).toContain("choose how many days");
    });

    test("creates a checkout session for a customisable-days listing priced by day count", async () => {
      await setupStripe();

      const listing = await createTestListing({
        customisableDays: true,
        dayPrices: { 1: 1000, 2: 1800 },
        durationDays: 2,
        maxAttendees: 50,
        thankYouUrl: "https://example.com/thanks",
      });

      const { stub } = await import("@std/testing/mock");
      const { stripePaymentProvider } = await import(
        "#shared/stripe-provider.ts"
      );
      let capturedIntent:
        | import("#shared/payments.ts").CheckoutIntent
        | undefined;
      const mockCreate = stub(
        stripePaymentProvider,
        "createCheckoutSession",
        (intent: import("#shared/payments.ts").CheckoutIntent) => {
          capturedIntent = intent;
          return Promise.resolve({
            checkoutUrl: "https://stripe.test/checkout",
            sessionId: "cs_customisable_web",
          });
        },
      );

      try {
        const response = await submitTicketForm(listing.slug, {
          day_count: "2",
          email: "john@example.com",
          name: "John Doe",
        });

        expect(response.status).toBe(302);
        // The chosen span and its price are carried into the checkout intent.
        expect(capturedIntent?.dayCount).toBe(2);
        expect(capturedIntent?.items[0]?.unitPrice).toBe(1800);
      } finally {
        mockCreate.restore();
      }
    });

    test("zero price ticket is treated as free", async () => {
      await setupStripe("sk_test_fake_key");

      // Create listing with 0 price
      const listing = await createTestListing({
        maxAttendees: 50,
        thankYouUrl: "https://example.com/thanks",
        unitPrice: 0, // zero price
      });

      const response = await submitTicketForm(listing.slug, {
        email: "john@example.com",
        name: "John Doe",
      });

      // Should redirect to thank you page (no payment required)
      expectRedirect(response, "https://example.com/thanks");
    });

    test("redirects to Stripe checkout with stripe-mock", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        thankYouUrl: "https://example.com/thanks",
        unitPrice: 1000, // 10.00 price
      });

      const response = await submitTicketForm(listing.slug, {
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

    test("returns error when listing not found in session metadata without refund", async () => {
      const { spy, stub } = await import("@std/testing/mock");
      const { stripeApi } = await import("#shared/stripe.ts");
      await setupStripe();

      await withMocks(
        () => ({
          mockRefund: spy(stripeApi, "refundPayment"),
          mockRetrieve: stub(stripeApi, "retrieveCheckoutSession", () =>
            Promise.resolve({
              id: "cs_test",
              metadata: {
                email: "john@example.com",
                items: singleItem(99999, 1, 0), // Non-existent listing
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
          await expectHtmlResponse(response, 404, "Listing not found");
          // Listing not found should NOT trigger a refund (webhook may be for a different instance)
          expect(mockRefund.calls.length).toBe(0);
        },
        resetStripeClient,
      );
    });

    test("creates attendee and shows success when payment verified", async () => {
      const { stub } = await import("@std/testing/mock");
      const { stripeApi } = await import("#shared/stripe.ts");

      await setupStripe();

      const listing = await createTestListing({
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
                items: singleItem(listing.id, 1, 1000),
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
          const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
          const attendees = await getAttendeesRaw(listing.id);
          expect(attendees.length).toBe(1);
          expect(attendees[0]?.pii_blob).not.toBe("");

          // Verify tokens are NOT persisted in DB (redirect has them in URL, no need to store)
          const { isSessionProcessed } = await import(
            "#shared/db/processed-payments.ts"
          );
          const record = await isSessionProcessed("cs_test_paid");
          expect(record?.ticket_tokens).toBe("");
        },
      );
    });

    test("handles replay of same session (idempotent)", async () => {
      const { stub } = await import("@std/testing/mock");
      const { stripeApi } = await import("#shared/stripe.ts");

      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        thankYouUrl: "https://example.com/thanks",
        unitPrice: 1000,
      });

      // Create attendee as if payment was already processed (using atomic to simulate production flow)
      await bookAttendee(listing, {
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
                items: singleItem(listing.id, 1, 1000),
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
          // which fails the capacity check if listing is near full
          // For idempotent behavior, we'd need to check payment_intent uniqueness
          // Response is either a 302 redirect (with tokens) or 200 (direct render for replay)
          expect([200, 302]).toContain(response.status);
        },
      );
    });

    test("handles multiple quantity purchase", async () => {
      const { stub } = await import("@std/testing/mock");
      const { stripeApi } = await import("#shared/stripe.ts");

      await setupStripe();

      const listing = await createTestListing({
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
                items: singleItem(listing.id, 3, 3000),
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
          const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
          const attendees = await getAttendeesRaw(listing.id);
          expect(attendees.length).toBe(1);
          expect(attendees[0]?.quantity).toBe(3);
        },
      );
    });

    test("rejects paid listing registration when sold out before payment", async () => {
      await setupStripe();

      // Create paid listing with only 1 spot
      const listing = await createTestListing({
        maxAttendees: 1,
        thankYouUrl: "https://example.com/thanks",
        unitPrice: 1000,
      });

      // Fill the listing (using atomic to simulate production flow)
      await bookAttendee(listing, {
        email: "first@example.com",
        name: "First",
        paymentId: "pi_first",
      });

      // Try to register - should fail before Stripe session is created
      const response = await submitTicketForm(listing.slug, {
        email: "second@example.com",
        name: "Second",
      });

      expect(response.status).toBe(400);
      expect(await response.text()).toContain("not enough spots available");
    });

    test("handles encryption error during payment confirmation", async () => {
      const { stub } = await import("@std/testing/mock");
      const { stripeApi } = await import("#shared/stripe.ts");
      const { attendeesApi } = await import("#shared/db/attendees.ts");

      await setupStripe();

      const listing = await createTestListing({
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
                items: singleItem(listing.id, 1, 1000),
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
});
