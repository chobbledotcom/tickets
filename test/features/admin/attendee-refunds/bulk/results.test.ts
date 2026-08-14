// jscpd:ignore-start
import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { resetI18nForTest } from "#i18n";
import { setN1GuardNotifyOnly } from "#shared/db/query-log.ts";
import {
  createPaidListing,
  seedBatchAttendees,
} from "#test/features/admin/refunds-helpers.ts";
import { getListingActivityLog } from "#test-utils/activity-log.ts";
import { expectFlashRedirect } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createPaidAttendeeWithoutLedger } from "#test-utils/db-helpers/attendee-payments.ts";
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
  "0 refunds succeeded. There was 1 failure. There was 1 error. Check the activity log for details. 1 refund remains. Submit again to continue.";
const OVERSIZED_REFUND_COUNT = 9;

describeWithEnv("server (admin refund-all results)", { db: true }, () => {
  beforeEach(() => setN1GuardNotifyOnly(true));
  afterEach(() => setN1GuardNotifyOnly(null));

  describe("a bulk refund the ledger could not record", () => {
    const errors = setupErrorSpy();

    test("counts it as errored, not refunded, and reports the broken promise", async () => {
      const listing = await createPaidListing();
      const unledgered = await createPaidAttendeeWithoutLedger(
        listing.id,
        "Unledgered",
        "unledgered@example.com",
        "pi_mixed_unledgered",
      );
      await withRefundMock(refundCompletes, async (mockRefund) => {
        const response = await postRefundAll(listing);
        expect(mockRefund.calls.length).toBe(1);
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

  test("makes one visible step through an oversized listing", async () => {
    const listing = await createPaidListing({ maxAttendees: 500 });
    await seedBatchAttendees(listing, "pi_batch_", OVERSIZED_REFUND_COUNT);
    await withRefundMock(refundCompletes, async (mockRefund) => {
      const response = await postRefundAll(listing);
      expect(mockRefund.calls).toHaveLength(1);
      await expectFlashRedirect(
        `/admin/listing/${listing.id}/refund-all`,
        "1 refund succeeded. 8 refunds remain. Submit again to continue.",
        true,
      )(response);
    });
  });

  test("applies copy replacements to a failed refund result", async () => {
    const listing = await createPaidListing();
    await createPaidAttendeeWithoutLedger(
      listing.id,
      "Rejected User",
      "rejected@example.com",
      "pi_rejected",
    );
    using _env = withEnv({ I18N_REPLACEMENTS: "failure|problem" });
    resetI18nForTest();
    try {
      await withRefundMock(refundIsRejected, async () => {
        await expectFlashRedirect(
          `/admin/listing/${listing.id}/refund-all`,
          "0 refunds succeeded. There was 1 problem. 1 refund remains. Submit again to continue.",
          false,
        )(await postRefundAll(listing));
      });
    } finally {
      resetI18nForTest();
    }

    const log = (await getListingActivityLog(listing.id)).find((entry) =>
      entry.message.includes("Bulk refund: 0 succeeded"),
    );
    expect(log?.message).toContain("0 succeeded, 1 failed");
  });

  test("reports one uncertain refund answer in the flash", async () => {
    const listing = await createPaidListing();
    await createPaidAttendeeWithoutLedger(
      listing.id,
      "Throw User",
      "throw@example.com",
      "pi_throw_boom",
    );
    await withRefundMock(
      () =>
        Promise.resolve({
          kind: "uncertain",
          reason: "network_error",
        } as const),
      async () => {
        const response = await postRefundAll(listing);
        await expectFlashRedirect(
          `/admin/listing/${listing.id}/refund-all`,
          "0 refunds succeeded. 1 refund is still settling. Do not send it again.",
          true,
        )(response);
      },
    );
  });
});
