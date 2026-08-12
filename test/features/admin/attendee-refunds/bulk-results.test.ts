// jscpd:ignore-start
import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { resetI18nForTest } from "#i18n";
import { setN1GuardNotifyOnly } from "#shared/db/query-log.ts";
import { BULK_REFUND_LIMIT } from "#shared/subrequest-budget.ts";
import {
  createPaidListing,
  seedBatchAttendees,
} from "#test/features/admin/refunds-helpers.ts";
import { getListingActivityLog } from "#test-utils/activity-log.ts";
import { expectFlashRedirect } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createPaidAttendeeWithoutLedger,
  createPaidTestAttendee,
} from "#test-utils/db-helpers/attendee-payments.ts";
import { withEnv } from "#test-utils/env.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import {
  postRefundAll,
  refundCompletes,
  refundIsRejected,
  withRefundMock,
} from "#test-utils/refund-routes.ts";

// jscpd:ignore-end

const SINGLE_ERROR_RESULT =
  "1 refund succeeded. There was 1 failure. There was 1 error. Check the activity log for details. Some payments may have already been refunded.";

describeWithEnv("server (admin refund-all results)", { db: true }, () => {
  beforeEach(() => setN1GuardNotifyOnly(true));
  afterEach(() => setN1GuardNotifyOnly(null));

  describe("a bulk refund the ledger could not record", () => {
    const errors = setupErrorSpy();

    test("counts it as errored, not refunded, and reports the broken promise", async () => {
      const listing = await createPaidListing();
      await createPaidTestAttendee(
        listing.id,
        "Ledgered",
        "ledgered@example.com",
        "pi_mixed_ledgered",
      );
      const unledgered = await createPaidAttendeeWithoutLedger(
        listing.id,
        "Unledgered",
        "unledgered@example.com",
        "pi_mixed_unledgered",
      );
      await withRefundMock(refundCompletes, async (mockRefund) => {
        const response = await postRefundAll(listing);
        expect(mockRefund.calls.length).toBe(2);
        await expectFlashRedirect(
          `/admin/listing/${listing.id}/refund-all`,
          SINGLE_ERROR_RESULT,
          false,
        )(response);
        // Money moved at the provider for this attendee with no ledger
        // record — the aggregate error count alone must not swallow WHO
        // needs the manual correction.
        expect(
          errors.contains(
            `[Error] E_INVARIANT_REPORTED listing=${listing.id} ` +
              `attendee=${unledgered.id} detail="error.refund_not_recorded"`,
          ),
        ).toBe(true);
      });
    });
  });

  test("caps refunds to preserve the edge subrequest budget", async () => {
    const listing = await createPaidListing({ maxAttendees: 500 });
    await seedBatchAttendees(listing, "pi_batch_", BULK_REFUND_LIMIT + 1);
    await withRefundMock(refundCompletes, async (mockRefund) => {
      const response = await postRefundAll(listing);
      expect(mockRefund.calls.length).toBe(BULK_REFUND_LIMIT);
      await expectFlashRedirect(
        `/admin/listing/${listing.id}/refund-all`,
        `${BULK_REFUND_LIMIT} refunds succeeded. 1 refund remains. Submit again to continue.`,
      )(response);
    });

    const log = (await getListingActivityLog(listing.id)).find((entry) =>
      entry.message.includes(`Bulk refund: ${BULK_REFUND_LIMIT} of`),
    );
    expect(log?.message).toContain(
      `Bulk refund: ${BULK_REFUND_LIMIT} of ${BULK_REFUND_LIMIT + 1} refunded`,
    );
  });

  const remainingFailureCases = [
    {
      count: 1,
      expected: `0 refunds succeeded. There were ${BULK_REFUND_LIMIT} failures. 1 refund remains. Submit again to continue.`,
      label: "one refund remaining",
    },
    {
      count: 2,
      expected: `0 refunds succeeded. There were ${BULK_REFUND_LIMIT} failures. 2 refunds remain. Submit again to continue.`,
      label: "multiple refunds remaining",
    },
  ];
  for (const { count, expected, label } of remainingFailureCases) {
    test(`reports failures with ${label}`, async () => {
      const listing = await createPaidListing({ maxAttendees: 500 });
      await seedBatchAttendees(
        listing,
        `pi_batchfail_${count}_`,
        BULK_REFUND_LIMIT + count,
      );
      await withRefundMock(refundIsRejected, async () => {
        await expectFlashRedirect(
          `/admin/listing/${listing.id}/refund-all`,
          expected,
          false,
        )(await postRefundAll(listing));
      });
    });
  }

  test("applies copy replacements to a completed partial-refund result", async () => {
    const listing = await createPaidListing();
    await createPaidTestAttendee(
      listing.id,
      "Good User",
      "good@example.com",
      "pi_partial_ok",
    );
    await createPaidTestAttendee(
      listing.id,
      "Bad User",
      "bad@example.com",
      "pi_partial_fail",
    );
    let callNum = 0;
    using _env = withEnv({ I18N_REPLACEMENTS: "failure|problem" });
    resetI18nForTest();
    try {
      await withRefundMock(
        (request) =>
          ++callNum <= 1 ? refundCompletes(request) : refundIsRejected(request),
        async () => {
          await expectFlashRedirect(
            `/admin/listing/${listing.id}/refund-all`,
            "1 refund succeeded. There was 1 problem. Some payments may have already been refunded.",
            false,
          )(await postRefundAll(listing));
        },
      );
    } finally {
      resetI18nForTest();
    }

    const log = (await getListingActivityLog(listing.id)).find((entry) =>
      entry.message.includes("Bulk refund: 1 succeeded"),
    );
    expect(log?.message).toContain("1 succeeded, 1 failed");
  });

  test("reports one uncertain refund answer in the flash", async () => {
    const listing = await createPaidListing();
    await createPaidTestAttendee(
      listing.id,
      "Good User",
      "good@example.com",
      "pi_throw_ok",
    );
    await createPaidTestAttendee(
      listing.id,
      "Throw User",
      "throw@example.com",
      "pi_throw_boom",
    );
    let callNum = 0;
    await withRefundMock(
      (request) => {
        callNum++;
        if (callNum === 1) return refundCompletes(request);
        return Promise.resolve({
          kind: "uncertain",
          reason: "network_error",
        } as const);
      },
      async () => {
        const response = await postRefundAll(listing);
        await expectFlashRedirect(
          `/admin/listing/${listing.id}/refund-all`,
          SINGLE_ERROR_RESULT,
          false,
        )(response);
      },
    );
  });

  test("uses plural error copy for multiple uncertain answers", async () => {
    const listing = await createPaidListing();
    await createPaidTestAttendee(
      listing.id,
      "Throw One",
      "throw-one@example.com",
      "pi_throw_one",
    );
    await createPaidTestAttendee(
      listing.id,
      "Throw Two",
      "throw-two@example.com",
      "pi_throw_two",
    );
    await withRefundMock(
      (_request) =>
        Promise.resolve({
          kind: "uncertain",
          reason: "network_error",
        } as const),
      async () => {
        await expectFlashRedirect(
          `/admin/listing/${listing.id}/refund-all`,
          "0 refunds succeeded. There were 2 failures. There were 2 errors. Check the activity log for details. Some payments may have already been refunded.",
          false,
        )(await postRefundAll(listing));
      },
    );
  });
});
