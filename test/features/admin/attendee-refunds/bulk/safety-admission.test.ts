// jscpd:ignore-start -- imports
import { expect } from "@std/expect";
import { afterEach, beforeEach, it as test } from "@std/testing/bdd";
import { getRefundCandidates } from "#routes/admin/refunds/candidates.ts";
import { getAttendeesRaw } from "#shared/db/attendees/queries.ts";
import { setN1GuardNotifyOnly } from "#shared/db/query-log.ts";
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

const REVIEWED_SET_SIZE = 3;

const putReviewOnLastPayment = async (listingId: number): Promise<void> => {
  const candidates = await getRefundCandidates(
    await getAttendeesRaw(listingId),
    await getTestPrivateKey(),
  );
  expect(candidates).toHaveLength(REVIEWED_SET_SIZE);
  const candidate = candidates.at(-1);
  const sessionId = candidate?.references[0]?.rowSessionIds[0];
  if (sessionId === undefined) {
    throw new Error("The last refund candidate has no payment row");
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

    test("a review on the last payment stops every provider send", async () => {
      const listing = await createPaidListing({ maxAttendees: 500 });
      await seedBatchAttendees(
        listing,
        "pi_review_last_",
        REVIEWED_SET_SIZE,
      );
      await putReviewOnLastPayment(listing.id);

      await withRefundMock(refundIsRejected, async (mockRefund) => {
        await postRefundAll(listing);
        expect(mockRefund.calls).toEqual([]);
      });
    });
  },
);
