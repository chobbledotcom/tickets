import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  expectFlashRedirect,
  expectHtmlResponse,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createPaidTestAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { awaitTestRequest } from "#test-utils/mocks.ts";
import {
  refundAllUrl,
  refundUrl,
  submitRefund,
  withRefundMock,
} from "#test-utils/refund-routes.ts";
import { testCookie } from "#test-utils/session.ts";
import {
  createPaidListing,
  markAsRefunded,
  setupRefundTest,
} from "./server-refunds-helpers.ts";

describeWithEnv("server (admin refund state)", { db: true }, () => {
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
});
