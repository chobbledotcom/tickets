// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { getNotesFor } from "#shared/db/notes/queries.ts";
import { attendeeNotes } from "#shared/db/notes/target.ts";
import { settings } from "#shared/db/settings.ts";
import { paymentsApi } from "#shared/payments.ts";
// jscpd:ignore-end
import {
  expectFlashPage,
  firstAttendee,
  refreshPaymentAsStripe,
  setupListingAndAttendee,
} from "#test/test-utils/attendees/helpers.ts";
import {
  expectFlash,
  expectFlashRedirect,
  expectHtmlResponse,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  bookAttendee,
  createPaidAttendeeWithoutLedger,
  createPaidTestAttendee,
} from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { withMocks } from "#test-utils/mocks.ts";
import { adminFormPost, adminGet, testCookie } from "#test-utils/session.ts";

/** A paid listing (`unitPrice: 1000`, 100 spots) — the shared setup for the
 *  "payment details on edit page" tests. */
const paidListing = (
  price = 1000,
): Parameters<typeof createTestListing>[0] => ({
  maxAttendees: 100,
  unitPrice: price,
});

describeWithEnv(
  "server (admin attendees) > attendee payment",
  { db: true },
  () => {
    describe("payment details on edit page", () => {
      test("shows payment details for paid attendee", async () => {
        const listing = await createTestListing(paidListing());
        const attendee = firstAttendee(
          await bookAttendee(listing, {
            email: "paid@example.com",
            name: "Paid User",
            paymentId: "pi_test_123",
            pricePaid: 1000,
            quantity: 1,
          }),
        );
        const response = await adminGet(`/admin/attendees/${attendee.id}`);
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
          stripe_secret_key: "sk_test_abc",
        });
        try {
          const listing = await createTestListing(paidListing());
          const attendee = firstAttendee(
            await bookAttendee(listing, {
              email: "linked@example.com",
              name: "Linked User",
              paymentId: "pi_linked_123",
              pricePaid: 1000,
              quantity: 1,
            }),
          );
          const response = await adminGet(`/admin/attendees/${attendee.id}`);
          await expectHtmlResponse(
            response,
            200,
            'href="https://dashboard.stripe.com/test/payments/pi_linked_123"',
            'target="_blank"',
          );
        } finally {
          settings.clearTestOverrides();
        }
      });

      test("shows refunded status for refunded attendee", async () => {
        const listing = await createTestListing(paidListing());
        const attendee = firstAttendee(
          await bookAttendee(listing, {
            email: "refunded@example.com",
            name: "Refunded User",
            paymentId: "pi_refunded_123",
            pricePaid: 1000,
            quantity: 1,
          }),
        );
        const { postAttendeeRefund } = await import("#test-utils/ledger.ts");
        await postAttendeeRefund({
          attendeeId: attendee.id,
          listingId: listing.id,
        });
        const response = await adminGet(`/admin/attendees/${attendee.id}`);
        await expectHtmlResponse(response, 200, "Refunded");
      });

      test("shows both badges for a checked-in and refunded booking", async () => {
        const listing = await createTestListing(paidListing());
        const attendee = firstAttendee(
          await bookAttendee(listing, {
            email: "both@example.com",
            name: "Both Badges",
            paymentId: "pi_both_123",
            pricePaid: 1000,
            quantity: 1,
          }),
        );
        const { updateCheckedIn } = await import(
          "#shared/db/attendees/update.ts"
        );
        const { postAttendeeRefund } = await import("#test-utils/ledger.ts");
        await updateCheckedIn(attendee.id, listing.id, true);
        await postAttendeeRefund({
          attendeeId: attendee.id,
          listingId: listing.id,
        });
        const response = await adminGet(`/admin/attendees/${attendee.id}`);
        const html = await response.text();
        expect(response.status).toBe(200);
        // Both badges render, separated by the space between them.
        expect(html).toContain("Checked in");
        expect(html).toContain("Refunded");
      });

      test("shows success message when flash cookie present", async () => {
        const { attendee } = await setupListingAndAttendee();
        const cookie = await testCookie();
        await expectFlashPage(
          `/admin/attendees/${attendee.id}`,
          cookie,
          "Payment status is up to date",
        );
      });

      test("does not show payment details for free attendee", async () => {
        const { attendee } = await setupListingAndAttendee({
          email: "free@example.com",
          listing: { maxAttendees: 100 },
          name: "Free User",
        });
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
          await setupListingAndAttendee();
        },
      });

      test("redirects to edit page when attendee has no payment", async () => {
        const { attendee } = await setupListingAndAttendee();
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
        const { attendee } = await setupListingAndAttendee();
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
        const listing = await createTestListing(paidListing(500));
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
        const listing = await createTestListing(paidListing(500));
        const attendee = await createPaidTestAttendee(
          listing.id,
          "John Doe",
          "john@example.com",
          "pi_refresh_refund",
        );
        const { response, refundCheckArgs } = await refreshPaymentAsStripe(
          attendee.id,
          true,
        );
        expect(response.status).toBe(302);
        expect(response.headers.get("location")).toContain(
          `/admin/attendees/${attendee.id}`,
        );
        expectFlash(response, expect.stringContaining("refunded"));
        expect(refundCheckArgs).toEqual(["pi_refresh_refund"]);
        // The "no manual refund needed" note belongs to a quantity-0
        // placeholder only. A normal booking has sale legs as well as payment
        // legs, so it must not pick up the placeholder's note.
        const notes = await getNotesFor(
          attendeeNotes(attendee.id),
          await getTestPrivateKey(),
        );
        expect(
          notes.some((note) => note.note.includes("Refund confirmed")),
        ).toBe(false);
      });

      test("surfaces a Stripe refund the ledger could not record", async () => {
        // Stripe reports the payment refunded, but the booking predates the ledger
        // so the reversal finds no clean order to post. Refund status is ledger-only
        // now, so this must surface for a manual adjustment rather than silently
        // succeed and leave the payment looking un-refunded.
        const listing = await createTestListing(paidListing(500));
        const attendee = await createPaidAttendeeWithoutLedger(
          listing.id,
          "John Doe",
          "john@example.com",
          "pi_refresh_unrecorded",
        );
        const { response } = await refreshPaymentAsStripe(attendee.id, true);
        expect(response.status).toBe(302);
        expectFlash(
          response,
          "The payment provider sent the refund. It could not be recorded in Money. Add a correction. Do not send the refund again.",
          false,
        );
        // The error must not silently flip the payment to refunded: with no
        // ledger reversal posted, the attendee page still shows "Not refunded".
        const page = await adminGet(`/admin/attendees/${attendee.id}`);
        await expectHtmlResponse(page, 200, "Not refunded");
      });

      test("redirects without marking refunded when payment is not refunded", async () => {
        const listing = await createTestListing(paidListing(500));
        const attendee = await createPaidTestAttendee(
          listing.id,
          "John Doe",
          "john@example.com",
          "pi_refresh_ok",
        );
        const { response } = await refreshPaymentAsStripe(attendee.id, false);
        expect(response.status).toBe(302);
        expect(response.headers.get("location")).toContain(
          `/admin/attendees/${attendee.id}`,
        );
        expectFlash(response, expect.stringContaining("up to date"));
      });
    });
  },
);
