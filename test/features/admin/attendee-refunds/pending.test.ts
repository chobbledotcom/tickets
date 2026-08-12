import { afterEach, beforeEach, it as test } from "@std/testing/bdd";
import { setN1GuardNotifyOnly } from "#shared/db/query-log.ts";
import { BULK_REFUND_LIMIT } from "#shared/subrequest-budget.ts";
import {
  createPaidListing,
  seedBatchAttendees,
} from "#test/features/admin/refunds-helpers.ts";
import { getListingActivityLog } from "#test-utils/activity-log.ts";
import { expectFlashRedirect } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createPaidTestAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { claimCurrentAttendeeRows } from "#test-utils/payment-claim.ts";
import {
  postRefundAll,
  refundAllUrl,
  refundCompletes,
  refundIsRejected,
  refundStaysPending,
  withRefundMock,
} from "#test-utils/refund-routes.ts";

const bulkRefundActivity = async (listingId: number): Promise<string> => {
  const log = (await getListingActivityLog(listingId)).find((entry) =>
    entry.message.includes("Bulk refund:"),
  );
  if (!log) throw new Error("Bulk refund activity was not recorded");
  return log.message;
};

const holdLegacyPayment = async (
  attendeeId: number,
  reference: string,
): Promise<void> => {
  await claimCurrentAttendeeRows(
    [attendeeId],
    "keyless",
    new Map([[attendeeId, reference]]),
  );
};

describeWithEnv("server (admin refunds still settling)", { db: true }, () => {
  beforeEach(() => setN1GuardNotifyOnly(true));
  afterEach(() => setN1GuardNotifyOnly(null));

  test("reports an accepted bulk refund as pending, not failed", async () => {
    const listing = await createPaidListing();
    await createPaidTestAttendee(
      listing.id,
      "Pending User",
      "pending@example.com",
      "pi_bulk_pending",
    );

    await withRefundMock(refundStaysPending, async () => {
      await expectFlashRedirect(
        refundAllUrl(listing.id),
        "0 refunds succeeded. 1 refund is still settling. Do not send it again.",
      )(await postRefundAll(listing));
    });

    const activity = await bulkRefundActivity(listing.id);
    if (!activity.includes("1 still settling")) {
      throw new Error(`Pending refund was logged incorrectly: ${activity}`);
    }
    if (activity.includes("1 failed")) {
      throw new Error(`Pending refund was logged as failed: ${activity}`);
    }
  });

  test("keeps pending refunds separate when another refund fails", async () => {
    const listing = await createPaidListing();
    await createPaidTestAttendee(
      listing.id,
      "Pending User",
      "pending@example.com",
      "pi_pending_side",
    );
    await createPaidTestAttendee(
      listing.id,
      "Failed User",
      "failed@example.com",
      "pi_failed_side",
    );

    await withRefundMock(
      (request) =>
        request.paymentReference === "pi_pending_side"
          ? refundStaysPending(request)
          : refundIsRejected(request),
      async () => {
        await expectFlashRedirect(
          refundAllUrl(listing.id),
          "0 refunds succeeded. 1 refund is still settling. Do not send it again. There was 1 failure. Some payments may have already been refunded.",
          false,
        )(await postRefundAll(listing));
      },
    );

    const activity = await bulkRefundActivity(listing.id);
    if (!activity.includes("1 still settling, 1 failed")) {
      throw new Error(`Mixed refund was logged incorrectly: ${activity}`);
    }
  });

  test("reports settling refunds before the next capped batch", async () => {
    const listing = await createPaidListing({ maxAttendees: 500 });
    await seedBatchAttendees(
      listing,
      "pi_pending_batch_",
      BULK_REFUND_LIMIT + 1,
    );

    await withRefundMock(refundStaysPending, async () => {
      await expectFlashRedirect(
        refundAllUrl(listing.id),
        `0 refunds succeeded. ${BULK_REFUND_LIMIT} refunds are still settling. Do not send them again. 1 refund remains. Submit again to continue.`,
      )(await postRefundAll(listing));
    });

    const activity = await bulkRefundActivity(listing.id);
    if (!activity.includes(`${BULK_REFUND_LIMIT} still settling`)) {
      throw new Error(
        `Capped pending batch was logged incorrectly: ${activity}`,
      );
    }
  });

  test("a blocked bulk run says every untouched refund remains", async () => {
    const listing = await createPaidListing();
    const held = await createPaidTestAttendee(
      listing.id,
      "Held User",
      "held@example.com",
      "pi_bulk_held",
    );
    await createPaidTestAttendee(
      listing.id,
      "Untouched One",
      "untouched-one@example.com",
      "pi_bulk_untouched_one",
    );
    await createPaidTestAttendee(
      listing.id,
      "Untouched Two",
      "untouched-two@example.com",
      "pi_bulk_untouched_two",
    );
    await holdLegacyPayment(held.id, "pi_bulk_held");

    await withRefundMock(refundCompletes, async (mockRefund) => {
      await expectFlashRedirect(
        refundAllUrl(listing.id),
        "A refund for this payment is still settling. Try again after it completes. 3 refunds remain. Submit again to continue.",
        false,
      )(await postRefundAll(listing));
      if (mockRefund.calls.length !== 0) {
        throw new Error("A blocked bulk run asked the provider for money");
      }
    });

    const activity = await bulkRefundActivity(listing.id);
    if (!activity.includes("not started")) {
      throw new Error(
        `Blocked bulk refund was logged incorrectly: ${activity}`,
      );
    }
    if (activity.includes("still settling,") || activity.includes("failed")) {
      throw new Error(
        `Untouched refunds were tallied as outcomes: ${activity}`,
      );
    }
  });
});
