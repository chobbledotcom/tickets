// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { settings } from "#shared/db/settings.ts";
import { paymentsApi } from "#shared/payments.ts";
import {
  adminFormPost,
  adminGet,
  awaitTestRequest,
  bookAttendee,
  createPaidAttendeeWithoutLedger,
  createPaidTestAttendee,
  createTestAttendee,
  createTestListing,
  describeWithEnv,
  expectFlash,
  expectFlashRedirect,
  expectHtmlResponse,
  FLASH_TEST_ID,
  flashCookieHeader,
  mockProviderType,
  testCookie,
  testRequiresAuth,
  withMocks,
} from "#test-utils";

// jscpd:ignore-end
describeWithEnv(
  "server (admin attendees) > attendee payment",
  { db: true },
  () => {
    describe("payment details on edit page", () => {
      test("shows payment details for paid attendee", async () => {
        const listing = await createTestListing({
          maxAttendees: 100,
          unitPrice: 1000,
        });
        const result = await bookAttendee(listing, {
          email: "paid@example.com",
          name: "Paid User",
          paymentId: "pi_test_123",
          pricePaid: 1000,
          quantity: 1,
        });
        if (!result.success) throw new Error("Failed to create attendee");
        const response = await adminGet(
          `/admin/attendees/${result.attendees[0]!.id}`,
        );
        await expectHtmlResponse(
          response,
          200,
          "Payment Details",
          "pi_test_123",
          "Not refunded",
          "Refresh payment status",
        );
      });

      test("links the payment id to the configured provider dashboard", async () => {
        settings.setForTest({
          payment_provider: "stripe",
          stripe_secret_key: "sk_live_abc",
        });
        try {
          const listing = await createTestListing({
            maxAttendees: 100,
            unitPrice: 1000,
          });
          const result = await bookAttendee(listing, {
            email: "linked@example.com",
            name: "Linked User",
            paymentId: "pi_linked_123",
            pricePaid: 1000,
            quantity: 1,
          });
          if (!result.success) throw new Error("Failed to create attendee");
          const response = await adminGet(
            `/admin/attendees/${result.attendees[0]!.id}`,
          );
          await expectHtmlResponse(
            response,
            200,
            'href="https://dashboard.stripe.com/payments/pi_linked_123"',
            'target="_blank"',
          );
        } finally {
          settings.clearTestOverrides();
        }
      });

      test("shows refunded status for refunded attendee", async () => {
        const listing = await createTestListing({
          maxAttendees: 100,
          unitPrice: 1000,
        });
        const { postAttendeeRefund } = await import("#test-utils/ledger.ts");
        const result = await bookAttendee(listing, {
          email: "refunded@example.com",
          name: "Refunded User",
          paymentId: "pi_refunded_123",
          pricePaid: 1000,
          quantity: 1,
        });
        if (!result.success) throw new Error("Failed to create attendee");
        await postAttendeeRefund({
          attendeeId: result.attendees[0]!.id,
          listingId: listing.id,
        });
        const response = await adminGet(
          `/admin/attendees/${result.attendees[0]!.id}`,
        );
        await expectHtmlResponse(response, 200, "Refunded");
      });

      test("shows both badges for a checked-in and refunded booking", async () => {
        const listing = await createTestListing({
          maxAttendees: 100,
          unitPrice: 1000,
        });
        const { updateCheckedIn } = await import("#shared/db/attendees.ts");
        const { postAttendeeRefund } = await import("#test-utils/ledger.ts");
        const result = await bookAttendee(listing, {
          email: "both@example.com",
          name: "Both Badges",
          paymentId: "pi_both_123",
          pricePaid: 1000,
          quantity: 1,
        });
        if (!result.success) throw new Error("Failed to create attendee");
        await updateCheckedIn(result.attendees[0]!.id, listing.id, true);
        await postAttendeeRefund({
          attendeeId: result.attendees[0]!.id,
          listingId: listing.id,
        });
        const response = await adminGet(
          `/admin/attendees/${result.attendees[0]!.id}`,
        );
        const html = await response.text();
        expect(response.status).toBe(200);
        // Both badges render, separated by the space between them.
        expect(html).toContain("Checked in");
        expect(html).toContain("Refunded");
      });

      test("shows success message when flash cookie present", async () => {
        const listing = await createTestListing({ maxAttendees: 100 });
        const attendee = await createTestAttendee(
          listing.id,
          listing.slug,
          "John Doe",
          "john@example.com",
        );
        const cookie = await testCookie();
        const response = await awaitTestRequest(
          `/admin/attendees/${attendee.id}?flash=${FLASH_TEST_ID}`,
          {
            cookie: `${cookie}; ${flashCookieHeader(
              "Payment status is up to date",
            )}`,
          },
        );
        await expectHtmlResponse(response, 200, "Payment status is up to date");
      });

      test("does not show payment details for free attendee", async () => {
        const listing = await createTestListing({ maxAttendees: 100 });
        const attendee = await createTestAttendee(
          listing.id,
          listing.slug,
          "Free User",
          "free@example.com",
        );
        const response = await adminGet(`/admin/attendees/${attendee.id}`);
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).not.toContain("Payment Details");
      });
    });

    describe("POST /admin/attendees/:attendeeId/refresh-payment", () => {
      testRequiresAuth("/admin/attendees/1/refresh-payment", {
        body: {},
        method: "POST",
        setup: async () => {
          const listing = await createTestListing({ maxAttendees: 100 });
          await createTestAttendee(
            listing.id,
            listing.slug,
            "John Doe",
            "john@example.com",
          );
        },
      });

      test("redirects to edit page when attendee has no payment", async () => {
        const listing = await createTestListing({ maxAttendees: 100 });
        const attendee = await createTestAttendee(
          listing.id,
          listing.slug,
          "John Doe",
          "john@example.com",
        );
        const { response } = await adminFormPost(
          `/admin/attendees/${attendee.id}/refresh-payment`,
        );
        expect(response.status).toBe(302);
        await expectFlashRedirect(
          `/admin/attendees/${attendee.id}`,
          "No payment to refresh",
          false,
        )(response);
      });

      test("returns 404 for non-existent attendee", async () => {
        const { response } = await adminFormPost(
          "/admin/attendees/999/refresh-payment",
        );
        expect(response.status).toBe(404);
      });

      test("returns 404 when attendee has no bookings", async () => {
        const listing = await createTestListing({ maxAttendees: 100 });
        const attendee = await createTestAttendee(
          listing.id,
          listing.slug,
          "John Doe",
          "john@example.com",
        );
        const { getDb: getDbFn } = await import("#shared/db/client.ts");
        const db = getDbFn();
        await db.execute({
          args: [attendee.id],
          sql: "DELETE FROM listing_attendees WHERE attendee_id = ?",
        });
        const { response } = await adminFormPost(
          `/admin/attendees/${attendee.id}/refresh-payment`,
        );
        expect(response.status).toBe(404);
      });

      test("returns error when no payment provider configured", async () => {
        const listing = await createTestListing({
          maxAttendees: 100,
          unitPrice: 500,
        });
        const attendee = await createPaidTestAttendee(
          listing.id,
          "John Doe",
          "john@example.com",
          "pi_no_provider",
        );
        await withMocks(
          () => stub(paymentsApi, "getConfiguredProvider", () => null),
          async () => {
            const { response } = await adminFormPost(
              `/admin/attendees/${attendee.id}/refresh-payment`,
            );
            expect(response.status).toBe(302);
            expectFlash(
              response,
              expect.stringContaining("payment provider"),
              false,
            );
          },
        );
      });

      test("marks as refunded when Stripe reports refund", async () => {
        const listing = await createTestListing({
          maxAttendees: 100,
          unitPrice: 500,
        });
        const attendee = await createPaidTestAttendee(
          listing.id,
          "John Doe",
          "john@example.com",
          "pi_refresh_refund",
        );
        await withMocks(
          () =>
            stub(paymentsApi, "getConfiguredProvider", () =>
              mockProviderType("stripe"),
            ),
          async () => {
            const { stripePaymentProvider } = await import(
              "#shared/stripe-provider.ts"
            );
            const mockRefunded = stub(
              stripePaymentProvider,
              "isPaymentRefunded",
              () => Promise.resolve(true),
            );
            try {
              const { response } = await adminFormPost(
                `/admin/attendees/${attendee.id}/refresh-payment`,
              );
              expect(response.status).toBe(302);
              expect(response.headers.get("location")).toContain(
                `/admin/attendees/${attendee.id}`,
              );
              expectFlash(response, expect.stringContaining("refunded"));
              expect(mockRefunded.calls[0]!.args).toEqual([
                "pi_refresh_refund",
              ]);
            } finally {
              mockRefunded.restore();
            }
          },
        );
      });

      test("surfaces a Stripe refund the ledger could not record", async () => {
        // Stripe reports the payment refunded, but the booking predates the ledger
        // so the reversal finds no clean order to post. Refund status is ledger-only
        // now, so this must surface for a manual adjustment rather than silently
        // succeed and leave the payment looking un-refunded.
        const listing = await createTestListing({
          maxAttendees: 100,
          unitPrice: 500,
        });
        const attendee = await createPaidAttendeeWithoutLedger(
          listing.id,
          "John Doe",
          "john@example.com",
          "pi_refresh_unrecorded",
        );
        await withMocks(
          () =>
            stub(paymentsApi, "getConfiguredProvider", () =>
              mockProviderType("stripe"),
            ),
          async () => {
            const { stripePaymentProvider } = await import(
              "#shared/stripe-provider.ts"
            );
            const mockRefunded = stub(
              stripePaymentProvider,
              "isPaymentRefunded",
              () => Promise.resolve(true),
            );
            try {
              const { response } = await adminFormPost(
                `/admin/attendees/${attendee.id}/refresh-payment`,
              );
              expect(response.status).toBe(302);
              expectFlash(
                response,
                expect.stringContaining("could not be recorded"),
                false,
              );
            } finally {
              mockRefunded.restore();
            }
          },
        );
      });

      test("redirects without marking refunded when payment is not refunded", async () => {
        const listing = await createTestListing({
          maxAttendees: 100,
          unitPrice: 500,
        });
        const attendee = await createPaidTestAttendee(
          listing.id,
          "John Doe",
          "john@example.com",
          "pi_refresh_ok",
        );
        await withMocks(
          () =>
            stub(paymentsApi, "getConfiguredProvider", () =>
              mockProviderType("stripe"),
            ),
          async () => {
            const { stripePaymentProvider } = await import(
              "#shared/stripe-provider.ts"
            );
            const mockRefunded = stub(
              stripePaymentProvider,
              "isPaymentRefunded",
              () => Promise.resolve(false),
            );
            try {
              const { response } = await adminFormPost(
                `/admin/attendees/${attendee.id}/refresh-payment`,
              );
              expect(response.status).toBe(302);
              expect(response.headers.get("location")).toContain(
                `/admin/attendees/${attendee.id}`,
              );
              expectFlash(response, expect.stringContaining("up to date"));
            } finally {
              mockRefunded.restore();
            }
          },
        );
      });
    });
  },
);
