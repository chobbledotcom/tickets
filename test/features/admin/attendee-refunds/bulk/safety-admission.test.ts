// jscpd:ignore-start -- imports
import { expect } from "@std/expect";
import { afterEach, beforeEach, it as test } from "@std/testing/bdd";
import { getRefundCandidates } from "#routes/admin/refunds/candidates.ts";
import { getAttendeesRaw } from "#shared/db/attendees/queries.ts";
import { setN1GuardNotifyOnly } from "#shared/db/query-log.ts";
import { BULK_REFUND_LIMIT } from "#shared/subrequest-budget.ts";
import {
  createPaidListing,
  seedBatchAttendees,
} from "#test/features/admin/refunds-helpers.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  putRowState,
  REVIEW_MIRROR,
  reviewCase,
  rowStateSlot,
} from "#test-utils/payment-claim.ts";
import {
  postRefundAll,
  refundIsRejected,
  withRefundMock,
} from "#test-utils/refund-routes.ts";

// jscpd:ignore-end

const putReviewOutsideFirstBatch = async (listingId: number): Promise<void> => {
  const candidates = await getRefundCandidates(
    await getAttendeesRaw(listingId),
    await getTestPrivateKey(),
  );
  expect(candidates).toHaveLength(BULK_REFUND_LIMIT + 1);
  const candidate = candidates[BULK_REFUND_LIMIT];
  const sessionId = candidate?.references[0]?.rowSessionIds[0];
  if (sessionId === undefined) {
    throw new Error("The candidate outside the first refund batch has no row");
  }
  await putRowState(
    sessionId,
    await rowStateSlot({
      review: reviewCase({ kind: "partial_refund" }),
    }),
    REVIEW_MIRROR,
  );
};

describeWithEnv(
  "server (admin refund-all safety admission)",
  { db: true },
  () => {
    beforeEach(() => setN1GuardNotifyOnly(true));
    afterEach(() => setN1GuardNotifyOnly(null));

    test("a review outside the execution limit stops every provider send", async () => {
      const listing = await createPaidListing({ maxAttendees: 500 });
      await seedBatchAttendees(
        listing,
        "pi_review_outside_batch_",
        BULK_REFUND_LIMIT + 1,
      );
      await putReviewOutsideFirstBatch(listing.id);

      await withRefundMock(refundIsRejected, async (mockRefund) => {
        await postRefundAll(listing);
        expect(mockRefund.calls).toEqual([]);
      });
    });
  },
);
