import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  adminGet,
  awaitTestRequest,
  createPaidTestAttendee,
  createTestAttendee,
  createTestListing,
  describeWithEnv,
  expectFlashRedirect,
  expectHtmlResponse,
  postRefundAll,
  refundAllUrl,
  refundUrl,
  submitRefund,
  testCookie,
  withRefundMock,
} from "#test-utils";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import {
  createPaidListing,
  markAsRefunded,
  setupRefundTest,
} from "./server-refunds-helpers.ts";

describeWithEnv("server (admin refund state and UI)", { db: true }, () => {
  describe("already-refunded guard", () => {
    test("GET refund page shows error for already-refunded attendee", async () => {
      const ctx = await setupRefundTest("pi_already_refunded");
      await markAsRefunded(ctx.attendee.id);

      const response = await awaitTestRequest(refundUrl(ctx.attendee.id), {
        cookie: ctx.cookie,
      });
      await expectHtmlResponse(response, 400, "already been refunded");
    });

    test("POST refund returns error for already-refunded attendee", async () => {
      const ctx = await setupRefundTest("pi_post_already");
      await markAsRefunded(ctx.attendee.id);

      const response = await submitRefund(ctx);
      await expectFlashRedirect(
        `/admin/attendees/${ctx.attendee.id}/refund`,
        expect.stringContaining("already been refunded"),
        false,
      )(response);
    });

    test("refund-all excludes already-refunded attendees", async () => {
      const listing = await createPaidListing();
      const refundedAttendee = await createPaidTestAttendee(
        listing.id,
        "Refunded",
        "refunded@example.com",
        "pi_ra_1",
      );
      await createPaidTestAttendee(
        listing.id,
        "Not Refunded",
        "notrefunded@example.com",
        "pi_ra_2",
      );
      await markAsRefunded(refundedAttendee.id);

      const response = await awaitTestRequest(refundAllUrl(listing.id), {
        cookie: await testCookie(),
      });
      await expectHtmlResponse(response, 200, "1 attendee(s) with payments");
    });

    test("marks attendee as refunded after successful refund", async () => {
      const ctx = await setupRefundTest("pi_mark_refund");

      await withRefundMock(true, async () => {
        const response = await submitRefund(ctx);
        expect(response.status).toBe(302);

        const retryResponse = await submitRefund(ctx);
        await expectFlashRedirect(
          `/admin/attendees/${ctx.attendee.id}/refund`,
          expect.stringContaining("already been refunded"),
          false,
        )(retryResponse);
      });
    });
  });

  describe("listing page UI", () => {
    const getListingPageHtml = async (listingId: number): Promise<string> => {
      const response = await adminGet(`/admin/listing/${listingId}`);
      expect(response.status).toBe(200);
      return response.text();
    };

    test("shows the listing-level Refund All on a paid listing", async () => {
      const listing = await createPaidListing();
      await createPaidTestAttendee(
        listing.id,
        "Paid User",
        "paid@example.com",
        "pi_ui_1",
      );

      const response = await adminGet(`/admin/listing/${listing.id}/actions`);
      await expectHtmlResponse(response, 200, "Refund All");
    });

    const createAttendeeAndGetHtml = async (
      listing: Awaited<ReturnType<typeof createTestListing>>,
      name: string,
      email: string,
    ) => {
      await createTestAttendee(listing.id, listing.slug, name, email);
      return getListingPageHtml(listing.id);
    };

    test("does not show Refund All for free listings", async () => {
      const listing = await createTestListing({ maxAttendees: 100 });
      const html = await createAttendeeAndGetHtml(
        listing,
        "Free User",
        "free@example.com",
      );
      expect(html).not.toContain("Refund All");
    });

    test("shows the per-attendee Refund action on a paid attendee's edit page", async () => {
      const listing = await createPaidListing();
      const attendee = await createPaidTestAttendee(
        listing.id,
        "Paid User",
        "paid@example.com",
        "pi_edit_1",
      );
      const response = await adminGet(
        `/admin/attendees/${attendee.id}/actions`,
      );
      const html = await expectHtmlResponse(response, 200);
      expect(html).toContain(`/admin/attendees/${attendee.id}/refund`);
    });

    test("hides the Refund action but keeps delete/resend when the attendee has no payment", async () => {
      const listing = await createPaidListing();
      const attendee = await createTestAttendee(
        listing.id,
        listing.slug,
        "No Payment User",
        "nopay@example.com",
      );
      const response = await adminGet(
        `/admin/attendees/${attendee.id}/actions`,
      );
      const html = await expectHtmlResponse(response, 200);
      expect(html).not.toContain(`/admin/attendees/${attendee.id}/refund`);
      expect(html).toContain(`/admin/attendees/${attendee.id}/delete`);
      expect(html).toContain(
        `/admin/attendees/${attendee.id}/resend-notification`,
      );
    });
  });

  describe("provider refund failures reach the error log", () => {
    const errors = setupErrorSpy();
    const loggedDetails = (): string[] =>
      errors.calls.map((call) => String(call.args[0]));

    test("a single refund the provider rejects is logged", async () => {
      const ctx = await setupRefundTest("pi_logfail_single");
      await withRefundMock(false, async () => {
        await submitRefund(ctx);
      });
      expect(
        loggedDetails().some((s) => s.includes("Admin refund failed")),
      ).toBe(true);
    });

    test("a bulk refund the provider rejects is logged per attendee", async () => {
      const listing = await createPaidListing();
      await createPaidTestAttendee(
        listing.id,
        "Bulk Fail",
        "bulkfail@example.com",
        "pi_logfail_bulk",
      );
      await withRefundMock(false, async () => {
        await postRefundAll(listing);
      });
      expect(
        loggedDetails().some((s) => s.includes("Admin bulk refund failed")),
      ).toBe(true);
    });

    test("a bulk refund the provider throws on is logged as errored", async () => {
      const listing = await createPaidListing();
      await createPaidTestAttendee(
        listing.id,
        "Bulk Throw",
        "bulkthrow@example.com",
        "pi_logfail_throw",
      );
      await withRefundMock(
        () => Promise.reject(new Error("provider boom")),
        async () => {
          await postRefundAll(listing);
        },
      );
      expect(
        loggedDetails().some((s) => s.includes("Admin bulk refund errored")),
      ).toBe(true);
    });
  });
});
