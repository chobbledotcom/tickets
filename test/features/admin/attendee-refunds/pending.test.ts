import { afterEach, beforeEach, it as test } from "@std/testing/bdd";
import { setN1GuardNotifyOnly } from "#shared/db/query-log.ts";
import {
  createPaidListing,
  createRefundableAttendee,
} from "#test/features/admin/refunds-helpers.ts";
import { getListingActivityLog } from "#test-utils/activity-log.ts";
import { expectFlashRedirect } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
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

const holdPayment = async (attendeeId: number): Promise<void> => {
  await claimCurrentAttendeeRows([attendeeId]);
};

describeWithEnv("server (admin refunds still settling)", { db: true }, () => {
  beforeEach(() => setN1GuardNotifyOnly(true));
  afterEach(() => setN1GuardNotifyOnly(null));

  test("reports an accepted bulk refund as pending, not failed", async () => {
    const listing = await createPaidListing();
    await createRefundableAttendee(
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

  test("keeps an untouched refund separate from a pending refund", async () => {
    const listing = await createPaidListing();
    await createRefundableAttendee(
      listing.id,
      "Pending User",
      "pending@example.com",
      "pi_pending_side",
    );
    await createRefundableAttendee(
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
          "0 refunds succeeded. 1 refund is still settling. Do not send it again. 1 other refund remains. Refresh payment status before continuing.",
        )(await postRefundAll(listing));
      },
    );

    const activity = await bulkRefundActivity(listing.id);
    if (!activity.includes("1 still settling")) {
      throw new Error(`Mixed refund was logged incorrectly: ${activity}`);
    }
    if (activity.includes("failed")) {
      throw new Error(`Untouched refund was logged as failed: ${activity}`);
    }
  });

  test("a blocked bulk run says every untouched refund remains", async () => {
    const listing = await createPaidListing();
    const held = await createRefundableAttendee(
      listing.id,
      "Held User",
      "held@example.com",
      "pi_bulk_held",
    );
    await createRefundableAttendee(
      listing.id,
      "Untouched One",
      "untouched-one@example.com",
      "pi_bulk_untouched_one",
    );
    await holdPayment(held.id);

    await withRefundMock(refundCompletes, async (mockRefund) => {
      await expectFlashRedirect(
        refundAllUrl(listing.id),
        "A refund for this payment is still settling. Refresh payment status after it completes. 2 refunds remain. Submit again to continue.",
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
