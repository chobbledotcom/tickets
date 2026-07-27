import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  createPaidListing,
  createRefundableTestAttendee,
  setupRefundTest,
} from "#test/lib/server-refunds-helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import {
  postRefundAll,
  submitRefund,
  withRefundMock,
} from "#test-utils/refund-routes.ts";

describeWithEnv("server (admin refund provider logging)", { db: true }, () => {
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
        loggedDetails().some((s) =>
          s.includes("Admin refund did not complete every payment"),
        ),
      ).toBe(true);
    });

    test("a bulk refund the provider rejects is logged per attendee", async () => {
      const listing = await createPaidListing();
      await createRefundableTestAttendee(
        listing.id,
        "Bulk Fail",
        "bulkfail@example.com",
        "pi_logfail_bulk",
      );
      await withRefundMock(false, async () => {
        await postRefundAll(listing);
      });
      expect(
        loggedDetails().some((s) =>
          s.includes("Admin refund did not complete every payment"),
        ),
      ).toBe(true);
    });

    test("a bulk refund the provider throws on is logged as errored", async () => {
      const listing = await createPaidListing();
      await createRefundableTestAttendee(
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
        loggedDetails().some((s) => s.includes("Admin refund errored")),
      ).toBe(true);
    });
  });
});
