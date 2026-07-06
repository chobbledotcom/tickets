import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { spy, stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { hmacHash } from "#shared/crypto/hashing.ts";
import { getDb } from "#shared/db/client.ts";
import { modifiersTable } from "#shared/db/modifiers.ts";
import { normalizeCode } from "#shared/price-modifier.ts";
import { resetStripeClient, stripeApi } from "#shared/stripe.ts";
import { stripePaymentProvider } from "#shared/stripe-provider.ts";
import {
  assertPublicHtml,
  awaitTestRequest,
  bookAttendee,
  createTestGroup,
  createTestListing,
  deactivateTestListing,
  describeWithEnv,
  expectAttendeeCounts,
  expectFlash,
  expectHtmlResponse,
  expectRedirect,
  expectSoldOutPlaceholderRefunded,
  followRedirect,
  makeParent,
  mockRequest,
  setupStripe,
  signMeta,
  singleItem,
  stubRefundPayment,
  stubRetrieveCheckoutSession,
  submitTicketForm,
  withMocks,
} from "#test-utils";
import { captureCheckoutIntent } from "#test-utils/checkout-intent.ts";
import { arrangeSoldOutListing } from "#test-utils/payment-scenarios.ts";

/** setupStripe, then a standard 50-capacity £10 listing whose thank-you URL is
 *  the bare `https://example.com`. The arrange step most /payment tests share
 *  before they stub the checkout session. Pass overrides to vary a field. */
const arrangePaidListing = async (
  overrides: Parameters<typeof createTestListing>[0] = {},
) => {
  await setupStripe();
  return createTestListing({
    maxAttendees: 50,
    thankYouUrl: "https://example.com",
    unitPrice: 1000,
    ...overrides,
  });
};

/** setupStripe (optionally with a specific key), make a 50-capacity listing at
 *  the given price, and submit John Doe's ticket form for it — the "try to buy
 *  a ticket" arrange+act the payment-enabled flow tests share. */
const submitJohnToNewListing = async (
  opts: { stripeKey?: string; unitPrice?: number } = {},
) => {
  await setupStripe(opts.stripeKey);
  const listing = await createTestListing({
    maxAttendees: 50,
    thankYouUrl: "https://example.com/thanks",
    unitPrice: opts.unitPrice ?? 1000,
  });
  const response = await submitTicketForm(listing.slug, {
    email: "john@example.com",
    name: "John Doe",
  });
  return { listing, response };
};

/** Stub retrieveCheckoutSession to an UNPAID session carrying the given raw
 *  (unsigned) metadata — the shape every /payment/cancel test reads to build
 *  its retry link. No amount or payment intent, because a cancelled checkout
 *  never charged. */
const stubUnpaidSession = (
  sessionId: string,
  metadata: Record<string, string>,
) =>
  stubRetrieveCheckoutSession({
    amountTotal: 0,
    metadata,
    paymentIntent: null,
    paymentStatus: "unpaid",
    sessionId,
  });

/** setupStripe, then a package group with one £10 member listing inside it —
 *  the arrange the cancel-page package tests share before stubbing the
 *  cancelled session. */
const createCancelPackage = async (name: string, slug: string) => {
  await setupStripe();
  const group = await createTestGroup({ isPackage: true, name, slug });
  const member = await createTestListing({
    groupId: group.id,
    maxAttendees: 50,
    unitPrice: 1000,
  });
  return { group, member };
};

/** A £10 paid listing (thank-you URL `…/thanks`) plus a factory that stubs its
 *  signed, paid checkout session for John Doe — the shared arrange for the
 *  single-ticket success and idempotent-replay tests, which drive the very same
 *  session and differ only in what they set up and assert around it. */
const arrangeJohnPaidSession = async () => {
  const listing = await arrangePaidListing({
    thankYouUrl: "https://example.com/thanks",
  });
  const stubSession = () =>
    stubRetrieveCheckoutSession({
      amountTotal: 1000,
      email: "john@example.com",
      items: singleItem(listing.id, 1, 1000),
      name: "John",
      paymentIntent: "pi_test_123",
      sessionId: "cs_test_paid",
    });
  return { listing, stubSession };
};

/** Re-hit a handled-failure session and assert it replays the SAME stored
 *  terminal outcome: HTTP 200 with the saved-your-details message, never the
 *  transient "being processed" lock, and no second refund. Returns the page
 *  HTML so a caller can make its own extra checks. */
const expectHandledFailureReplay = async (
  sessionId: string,
  mockRefund: { calls: unknown[] },
): Promise<string> => {
  const second = await handleRequest(
    mockRequest(`/payment/success?session_id=${sessionId}`),
  );
  expect(second.status).toBe(200);
  const html = await second.text();
  expect(html).toContain("saved your details");
  expect(html).not.toContain("being processed");
  expect(mockRefund.calls.length).toBe(1);
  return html;
};

describeWithEnv("server (payment flow)", { db: true, triggers: true }, () => {
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
      const listing = await arrangePaidListing();

      await withMocks(
        () =>
          stubRetrieveCheckoutSession({
            amountTotal: 1000,
            metadata: {
              email: "john@example.com",
              items: singleItem(listing.id, 1, 1000),
              name: "John",
            },
            paymentIntent: "pi_test",
            paymentStatus: "unpaid",
            sessionId: "cs_test",
          }),
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
      await setupStripe();

      await withMocks(
        () =>
          stubRetrieveCheckoutSession({
            amountTotal: 1000,
            metadata: {}, // Missing required fields
            paymentIntent: "pi_test",
            sessionId: "cs_test",
          }),
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
      const listing = await arrangePaidListing();

      // Deactivate the listing
      await deactivateTestListing(listing.id);

      await withMocks(
        () => ({
          mockRefund: stubRefundPayment(),
          mockRetrieve: stubRetrieveCheckoutSession({
            amountTotal: 1000,
            email: "john@example.com",
            items: singleItem(listing.id, 1, 1000),
            name: "John",
            paymentIntent: "pi_test_123",
            sessionId: "cs_test",
          }),
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
      const listing = await arrangeSoldOutListing();

      await withMocks(
        () => ({
          mockRefund: stubRefundPayment(),
          mockRetrieve: stubRetrieveCheckoutSession({
            amountTotal: 1000,
            email: "second@example.com",
            items: singleItem(listing.id, 1, 1000),
            name: "Second",
            paymentIntent: "pi_second",
            sessionId: "cs_test",
          }),
        }),
        async ({ mockRefund }) => {
          const response = await handleRequest(
            mockRequest("/payment/success?session_id=cs_test"),
          );
          // Signed by us → the late buyer is not dropped: the booking is kept as
          // a quantity-0 placeholder and refunded, and the customer sees the
          // generic saved-details message (HTTP 200, a fully-handled outcome).
          await expectHtmlResponse(
            response,
            200,
            "saved your details",
            "automatically refunded",
          );

          // Verify refund was called once against the right payment
          expect(mockRefund.calls[0]!.args).toEqual(["pi_second"]);

          // The placeholder is kept alongside the original (sold-out) attendee,
          // refunded once with a note, and the session filed as a failure.
          await expectSoldOutPlaceholderRefunded(
            listing.id,
            "cs_test",
            mockRefund,
          );
        },
        resetStripeClient,
      );
    });
  });

  // A handled post-payment failure reserves the session, then refunds/returns.
  // The reservation must record the terminal outcome so an immediate retry
  // (redirect refresh or webhook re-delivery) replays the SAME result instead
  // of re-refunding or getting stuck behind the "being processed" lock.
  describe("GET /payment/success — idempotent replay of handled failures", () => {
    /** Stub retrieveCheckoutSession to a fixed paid, signed session + a refund
     * spy. Signs at amountTotal (as production checkout does) so the session
     * classifies as trusted — an unsigned session would be ignored. */
    const stubPaidSession = (
      sessionId: string,
      metadata: Record<string, string>,
      amountTotal: number,
    ) => ({
      mockRefund: stubRefundPayment("re_replay"),
      mockRetrieve: stubRetrieveCheckoutSession({
        amountTotal,
        metadata: signMeta(metadata, amountTotal),
        paymentIntent: `pi_${sessionId}`,
        sessionId,
      }),
    });

    test("closed-listing-after-payment refunds once and replays on retry", async () => {
      const listing = await arrangePaidListing();
      await deactivateTestListing(listing.id);

      await withMocks(
        () =>
          stubPaidSession(
            "cs_replay_closed",
            {
              email: "john@example.com",
              items: singleItem(listing.id, 1, 1000),
              name: "John",
            },
            1000,
          ),
        async ({ mockRefund }) => {
          const first = await handleRequest(
            mockRequest("/payment/success?session_id=cs_replay_closed"),
          );
          await expectHtmlResponse(
            first,
            410,
            "no longer accepting registrations",
            "refunded",
          );

          const second = await handleRequest(
            mockRequest("/payment/success?session_id=cs_replay_closed"),
          );
          expect(second.status).toBe(410);
          const html = await second.text();
          expect(html).toContain("no longer accepting registrations");
          expect(html).toContain("refunded");
          // The retry never shows the transient lock message...
          expect(html).not.toContain("being processed");
          // ...and never issues a second refund.
          expect(mockRefund.calls.length).toBe(1);
        },
        resetStripeClient,
      );
    });

    test("sold-out-after-payment refunds once and replays on retry", async () => {
      const listing = await arrangeSoldOutListing();

      await withMocks(
        () =>
          stubPaidSession(
            "cs_replay_soldout",
            {
              email: "second@example.com",
              items: singleItem(listing.id, 1, 1000),
              name: "Second",
            },
            1000,
          ),
        async ({ mockRefund }) => {
          const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
          const { getNoteRows } = await import("#shared/db/system-notes.ts");
          const { isSessionProcessed } = await import(
            "#shared/db/processed-payments.ts"
          );
          const placeholders = async () =>
            (await getAttendeesRaw(listing.id)).filter((a) => a.quantity === 0);

          // First delivery: the late buyer is not dropped — a quantity-0
          // placeholder is stored, refunded once, with a note, and a
          // fully-handled outcome renders with HTTP 200.
          const first = await handleRequest(
            mockRequest("/payment/success?session_id=cs_replay_soldout"),
          );
          await expectHtmlResponse(
            first,
            200,
            "saved your details",
            "refunded",
          );
          const afterFirst = await placeholders();
          expect(afterFirst.length).toBe(1);
          expect((await getNoteRows([afterFirst[0]!.id])).length).toBe(1);
          expect(mockRefund.calls.length).toBe(1);

          // The session is recorded as a terminal failure.
          const record = await isSessionProcessed("cs_replay_soldout");
          expect(record?.attendee_id).toBeNull();
          expect(record?.failure_data).not.toBe("");

          // Retry replays the SAME terminal outcome (the old drop path's 410/409
          // is now 200 for the store path): same message, no second placeholder,
          // no second refund, and never the transient lock message.
          await expectHandledFailureReplay("cs_replay_soldout", mockRefund);
          expect((await placeholders()).length).toBe(1);
        },
        resetStripeClient,
      );
    });

    test("price-mismatch-after-payment is stored, refunded once, and replays on retry", async () => {
      const listing = await arrangePaidListing();

      // Stale checkout: metadata price (500) no longer matches the listing's
      // current 1000, so the booking is kept and refunded once. A fully-handled
      // outcome renders with HTTP 200, and a retry replays it (no re-refund).
      await withMocks(
        () =>
          stubPaidSession(
            "cs_replay_price",
            {
              email: "john@example.com",
              items: singleItem(listing.id, 1, 500),
              name: "John",
            },
            500,
          ),
        async ({ mockRefund }) => {
          const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
          const { getNoteRows } = await import("#shared/db/system-notes.ts");
          const { isSessionProcessed } = await import(
            "#shared/db/processed-payments.ts"
          );

          // First delivery: the booking is kept as a quantity-0 placeholder and
          // refunded once. The specific reason now lives in the system note, so
          // the customer sees the generic saved-details message (HTTP 200).
          const first = await handleRequest(
            mockRequest("/payment/success?session_id=cs_replay_price"),
          );
          await expectHtmlResponse(first, 200, "saved your details");

          const attendees = await getAttendeesRaw(listing.id);
          expect(attendees.length).toBe(1);
          expect(attendees[0]?.quantity).toBe(0);
          expect((await getNoteRows([attendees[0]!.id])).length).toBe(1);
          expect(mockRefund.calls.length).toBe(1);

          // The session is recorded as a terminal failure.
          const record = await isSessionProcessed("cs_replay_price");
          expect(record?.attendee_id).toBeNull();
          expect(record?.failure_data).not.toBe("");

          // Retry replays the same terminal outcome: same message, no second
          // placeholder, no second refund, never the transient lock message.
          await expectHandledFailureReplay("cs_replay_price", mockRefund);
          expect((await getAttendeesRaw(listing.id)).length).toBe(1);
        },
        resetStripeClient,
      );
    });

    test("a failed refund releases the reservation so the next retry re-attempts it", async () => {
      const { isSessionProcessed } = await import(
        "#shared/db/processed-payments.ts"
      );
      const listing = await arrangePaidListing();
      await deactivateTestListing(listing.id);

      await withMocks(
        () => ({
          // The provider's refund call fails (e.g. transiently down) and the
          // payment is not already refunded, so the refund genuinely failed.
          mockRefund: stub(stripePaymentProvider, "refundPayment", () =>
            Promise.resolve(false),
          ),
          mockRefunded: stub(stripePaymentProvider, "isPaymentRefunded", () =>
            Promise.resolve(false),
          ),
          mockRetrieve: stubRetrieveCheckoutSession({
            amountTotal: 1000,
            email: "john@example.com",
            items: singleItem(listing.id, 1, 1000),
            name: "John",
            paymentIntent: "pi_refund_failed",
            sessionId: "cs_refund_failed",
          }),
        }),
        async ({ mockRefund }) => {
          const response = await handleRequest(
            mockRequest("/payment/success?session_id=cs_refund_failed"),
          );
          expect(mockRefund.calls.length).toBe(1);
          expect(await response.text()).toContain("contact support");
          // The failure is NOT frozen as terminal AND the reservation is not
          // left held: the row is released (deleted) so the next delivery
          // re-claims and re-attempts the refund immediately, rather than
          // colliding with the lock until the row goes stale.
          expect(await isSessionProcessed("cs_refund_failed")).toBeNull();

          // The next retry re-attempts the refund (proof the lock was released).
          await handleRequest(
            mockRequest("/payment/success?session_id=cs_refund_failed"),
          );
          expect(mockRefund.calls.length).toBe(2);
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
      await setupStripe();

      await withMocks(
        () => stubUnpaidSession("cs_test_cancel", {}), // Missing required fields
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
      await setupStripe();

      await withMocks(
        () =>
          stubUnpaidSession("cs_test_cancel", {
            email: "john@example.com",
            items: singleItem(99999, 1, 0), // Non-existent listing
            name: "John",
          }),
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
      const listing = await arrangePaidListing();

      await withMocks(
        () =>
          stubUnpaidSession("cs_test_cancel", {
            email: "john@example.com",
            items: singleItem(listing.id, 1, 1000),
            name: "John",
          }),
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

    test("a cancelled checkout for a now-non-standalone child suppresses the retry link", async () => {
      await setupStripe();

      // The child had its own page when checkout began; it is a plain
      // (non-standalone) child now, so /ticket/<child> 404s and the cancel page
      // must offer a way home instead of a dead retry link.
      const { child } = await makeParent({
        children: [{ maxAttendees: 50, unitPrice: 1000 }],
      });

      await withMocks(
        () =>
          stubUnpaidSession("cs_cancel_child", {
            email: "john@example.com",
            items: singleItem(child.id, 1, 1000),
            name: "John",
          }),
        async () => {
          const html = await assertPublicHtml(
            "/payment/cancel?session_id=cs_cancel_child",
            "Payment Cancelled",
            "Return home",
          );
          expect(html).not.toContain(`/ticket/${child.slug}`);
        },
        resetStripeClient,
      );
    });

    test("a cancelled package checkout links back to the package page", async () => {
      const { group, member } = await createCancelPackage(
        "Cancel Pkg",
        "cancel-pkg",
      );

      await withMocks(
        () =>
          stubUnpaidSession("cs_pkg_cancel", {
            email: "john@example.com",
            items: singleItem(member.id, 1, 1000),
            name: "John",
            package_group_id: String(group.id),
          }),
        async () => {
          // The retry link is the bundle's page, not the member's standalone page.
          await assertPublicHtml(
            "/payment/cancel?session_id=cs_pkg_cancel",
            "Payment Cancelled",
            `/ticket/${group.slug}`,
          );
        },
        resetStripeClient,
      );
    });

    test("a cancelled package checkout falls back to the member page when the bundle is no longer bookable", async () => {
      const { group, member } = await createCancelPackage(
        "Dead Bundle",
        "dead-bundle",
      );
      // A package is all-or-nothing; deactivating a second member leaves the
      // bundle incomplete, so /ticket/<group> now 404s. The retry link must fall
      // back to the still-standalone member page rather than the dead bundle.
      const gone = await createTestListing({
        groupId: group.id,
        maxAttendees: 50,
        unitPrice: 1000,
      });
      await getDb().execute({
        args: [gone.id],
        sql: "UPDATE listings SET active = 0 WHERE id = ?",
      });

      await withMocks(
        () =>
          stubUnpaidSession("cs_pkg_cancel_dead", {
            email: "john@example.com",
            items: singleItem(member.id, 1, 1000),
            name: "John",
            package_group_id: String(group.id),
          }),
        async () => {
          const html = await assertPublicHtml(
            "/payment/cancel?session_id=cs_pkg_cancel_dead",
            "Payment Cancelled",
            `/ticket/${member.slug}`,
          );
          expect(html).not.toContain(`/ticket/${group.slug}`);
        },
        resetStripeClient,
      );
    });

    test("a cancelled package checkout falls back to the member page when the group is gone", async () => {
      await setupStripe();

      const member = await createTestListing({
        maxAttendees: 50,
        unitPrice: 1000,
      });

      await withMocks(
        () =>
          stubUnpaidSession("cs_pkg_cancel_gone", {
            email: "john@example.com",
            items: singleItem(member.id, 1, 1000),
            name: "John",
            package_group_id: "99999",
          }),
        async () => {
          await assertPublicHtml(
            "/payment/cancel?session_id=cs_pkg_cancel_gone",
            "Payment Cancelled",
            `/ticket/${member.slug}`,
          );
        },
        resetStripeClient,
      );
    });

    test("shows cancel page for ticket session", async () => {
      const listing = await arrangePaidListing();
      const listing2 = await createTestListing({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
        unitPrice: 2000,
      });

      await withMocks(
        () =>
          stubUnpaidSession("cs_test_cancel_multi", {
            email: "john@example.com",
            items: JSON.stringify([
              { e: listing.id, p: 1000, q: 1 },
              { e: listing2.id, p: 4000, q: 2 },
            ]),
            name: "John",
          }),
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
      await setupStripe();

      await withMocks(
        () =>
          stubUnpaidSession("cs_test_cancel_bad_multi", {
            email: "john@example.com",
            items: "[]", // Empty items array
            name: "John",
          }),
        async () => {
          const response = await handleRequest(
            mockRequest("/payment/cancel?session_id=cs_test_cancel_bad_multi"),
          );
          await expectHtmlResponse(response, 404, "Listing not found");
        },
        resetStripeClient,
      );
    });

    test("returns 404 for ticket session with unparseable items", async () => {
      await setupStripe();

      await withMocks(
        () =>
          stubUnpaidSession("cs_test_cancel_unparseable", {
            email: "john@example.com",
            items: "not-json", // Unparseable JSON → parseBookingItems null
            name: "John",
          }),
        async () => {
          const response = await handleRequest(
            mockRequest(
              "/payment/cancel?session_id=cs_test_cancel_unparseable",
            ),
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
      // A fake Stripe key enables payments but fails session creation.
      const { response } = await submitJohnToNewListing({
        stripeKey: "sk_test_fake_key",
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
      // A free listing needs no payment even with payments enabled.
      const { response } = await submitJohnToNewListing({
        stripeKey: "sk_test_fake_key",
        unitPrice: 0,
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

      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("choose how many days"),
        false,
      );
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

      const checkout = captureCheckoutIntent("cs_customisable_web");

      try {
        const response = await submitTicketForm(listing.slug, {
          day_count: "2",
          email: "john@example.com",
          name: "John Doe",
        });

        expect(response.status).toBe(302);
        // The chosen span and its price are carried into the checkout intent.
        expect(checkout.intent?.dayCount).toBe(2);
        expect(checkout.intent?.items[0]?.unitPrice).toBe(1800);
      } finally {
        checkout.restore();
      }
    });

    test("carries a selected add-on and entered promo code into the checkout intent", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        thankYouUrl: "https://example.com/thanks",
        unitPrice: 1000,
      });

      // An opt-in add-on and a promo-code discount, both whole-order. A second
      // add-on is offered but left unselected (its quantity field stays 0).
      const addOn = await modifiersTable.insert({
        calcKind: "fixed",
        calcValue: 5,
        direction: "charge",
        name: "T-shirt",
      });
      const skippedAddOn = await modifiersTable.insert({
        calcKind: "fixed",
        calcValue: 3,
        direction: "charge",
        name: "Tote bag",
      });
      const promo = await modifiersTable.insert({
        calcKind: "percent",
        calcValue: 10,
        direction: "discount",
        name: "SAVE10",
      });
      await getDb().execute({
        args: ["optional", addOn.id],
        sql: "UPDATE modifiers SET trigger = ? WHERE id = ?",
      });
      await getDb().execute({
        args: ["optional", skippedAddOn.id],
        sql: "UPDATE modifiers SET trigger = ? WHERE id = ?",
      });
      await getDb().execute({
        args: ["code", await hmacHash(normalizeCode("SAVE10")), promo.id],
        sql: "UPDATE modifiers SET trigger = ?, code_index = ? WHERE id = ?",
      });

      const checkout = captureCheckoutIntent("cs_modifiers_web");

      try {
        const response = await submitTicketForm(listing.slug, {
          // The second add-on's field is omitted entirely (left unselected).
          [`addon_${addOn.id}`]: "2",
          email: "john@example.com",
          name: "John Doe",
          promo_code: "save10",
        });

        expect(response.status).toBe(302);
        const byId = new Map(
          (checkout.intent?.modifiers ?? []).map((m) => [m.id, m]),
        );
        // The add-on is applied at the chosen quantity, the promo at quantity 1,
        // and the unselected add-on is absent.
        expect(byId.get(addOn.id)?.quantity).toBe(2);
        expect(byId.get(promo.id)?.quantity).toBe(1);
        expect(byId.has(skippedAddOn.id)).toBe(false);
      } finally {
        checkout.restore();
      }
    });

    test("zero price ticket is treated as free", async () => {
      // A zero-price listing needs no payment (no payment required).
      const { response } = await submitJohnToNewListing({
        stripeKey: "sk_test_fake_key",
        unitPrice: 0,
      });

      // Should redirect to thank you page (no payment required)
      expectRedirect(response, "https://example.com/thanks");
    });

    test("redirects to Stripe checkout with stripe-mock", async () => {
      const { response } = await submitJohnToNewListing();

      // Should redirect to Stripe checkout URL
      expect(response.status).toBe(302);
      const location = response.headers.get("location");
      expect(location).not.toBeNull();
      // stripe-mock returns a URL starting with https://
      expect(location?.startsWith("https://")).toBe(true);
    });

    test("an unsigned session for an unknown listing is ignored without refunding", async () => {
      await setupStripe();

      await withMocks(
        () => ({
          mockRefund: spy(stripeApi, "refundPayment"),
          mockRetrieve: stubRetrieveCheckoutSession({
            amountTotal: 0,
            metadata: {
              email: "john@example.com",
              items: singleItem(99999, 1, 0), // Non-existent listing
              name: "John",
            },
            paymentIntent: "pi_test",
            sessionId: "cs_test",
          }),
        }),
        async ({ mockRefund }) => {
          const response = await handleRequest(
            mockRequest("/payment/success?session_id=cs_test"),
          );
          // No valid proof → ignored as not ours: shown the not-recognized page
          // and never refunded (the session may belong to a different instance).
          await expectHtmlResponse(response, 400, "not recognized");
          expect(mockRefund.calls.length).toBe(0);
        },
        resetStripeClient,
      );
    });

    test("creates attendee and shows success when payment verified", async () => {
      const { listing, stubSession } = await arrangeJohnPaidSession();

      await withMocks(
        stubSession,
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

    /** A parent with a configured thank-you URL folding one required paid child,
     * whose signed checkout metadata carries that explicit thank_you_url and two
     * listing ids. Returns the `withMocks` stub factory for the given provider
     * session id + payment intent — the scaffolding both thank-you-URL tests
     * share (they differ only in what they assert about the rendered page). */
    const parentThanksStub = async (
      sessionId: string,
      paymentIntent: string,
    ) => {
      const { stub } = await import("@std/testing/mock");
      const { stripeApi } = await import("#shared/stripe.ts");
      await setupStripe();

      const { parent, child } = await makeParent({
        children: [{ maxAttendees: 50, unitPrice: 1000 }],
        parent: {
          maxAttendees: 50,
          thankYouUrl: "https://example.com/thanks-parent",
          unitPrice: 1000,
        },
      });

      const items = JSON.stringify([
        { e: parent.id, p: 1000, q: 1 },
        { e: child.id, p: 1000, q: 1 },
      ]);

      return () =>
        stub(stripeApi, "retrieveCheckoutSession", () =>
          Promise.resolve({
            amount_total: 2000,
            id: sessionId,
            metadata: signMeta(
              {
                email: "john@example.com",
                items,
                name: "John",
                thank_you_url: "https://example.com/thanks-parent",
              },
              2000,
            ),
            payment_intent: paymentIntent,
            payment_status: "paid",
          } as unknown as Awaited<
            ReturnType<typeof stripeApi.retrieveCheckoutSession>
          >),
        );
    };

    test("a parent's thank-you URL survives a folded paid child (multi-listing)", async () => {
      // A single parent with a configured thank_you_url folds a required paid
      // child, so the completed booking has TWO unique listing ids. The default
      // success rule drops thank_you_url for multi-listing orders; the explicit
      // intent value (carried in the signed metadata) must still win.
      await withMocks(
        await parentThanksStub("cs_parent_thanks", "pi_parent_thanks"),
        async () => {
          const response = await handleRequest(
            mockRequest("/payment/success?session_id=cs_parent_thanks"),
          );
          // The explicit URL renders the success page directly with the parent's
          // thank-you URL, even though two listings were booked.
          await expectHtmlResponse(
            response,
            200,
            "Thank you for your order",
            "https://example.com/thanks-parent",
          );
        },
      );
    });

    test("a parent's direct-render booking keeps its ticket URL on reload", async () => {
      // The explicit-thank-you (parent) booking renders the success page directly
      // from session_id (no token in the URL). Re-hitting the same provider
      // callback lands on the already-processed branch; the ticket token must be
      // persisted so that reload still renders a non-null ticket URL (and the
      // parent's thank-you URL), instead of losing the buyer's ticket link.
      await withMocks(
        await parentThanksStub("cs_parent_reload", "pi_parent_reload"),
        async () => {
          // First hit finalizes and renders directly with the ticket URL.
          const first = await handleRequest(
            mockRequest("/payment/success?session_id=cs_parent_reload"),
          );
          const firstHtml = await expectHtmlResponse(
            first,
            200,
            "Thank you for your order",
            "https://example.com/thanks-parent",
          );
          expect(firstHtml).toContain("/t/");

          // Reload hits the already-processed branch; the persisted token still
          // yields a non-null ticket URL and the parent's thank-you URL.
          const reload = await handleRequest(
            mockRequest("/payment/success?session_id=cs_parent_reload"),
          );
          const reloadHtml = await expectHtmlResponse(
            reload,
            200,
            "Thank you for your order",
            "https://example.com/thanks-parent",
          );
          expect(reloadHtml).toContain("/t/");
        },
      );
    });

    test("handles replay of same session (idempotent)", async () => {
      const { listing, stubSession } = await arrangeJohnPaidSession();

      // Create attendee as if payment was already processed (using atomic to simulate production flow)
      await bookAttendee(listing, {
        email: "john@example.com",
        name: "John",
        paymentId: "pi_test_123",
      });

      await withMocks(
        stubSession,
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
      const listing = await arrangePaidListing({
        maxQuantity: 5,
        thankYouUrl: "https://example.com/thanks",
      });

      await withMocks(
        () =>
          stubRetrieveCheckoutSession({
            amountTotal: 3000,
            email: "john@example.com",
            items: singleItem(listing.id, 3, 3000),
            name: "John",
            paymentIntent: "pi_test_123",
            sessionId: "cs_test_paid",
          }),
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
          await expectAttendeeCounts([
            { count: 1, listingId: listing.id, quantity: 3 },
          ]);
        },
      );
    });

    test("rejects paid listing registration when sold out before payment", async () => {
      const listing = await arrangeSoldOutListing();

      // Try to register - should fail before Stripe session is created
      const response = await submitTicketForm(listing.slug, {
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
  });
});
