// jscpd:ignore-start -- imports
import { expect } from "@std/expect";
import { afterEach, beforeEach, it as test } from "@std/testing/bdd";
import {
  getRefundCandidates,
  type RefundCandidate,
} from "#routes/admin/refunds/candidates.ts";
import { getAttendeesRaw } from "#shared/db/attendees/queries.ts";
import { markPaymentReferencesProviderRefunded } from "#shared/db/payment-references.ts";
import { setN1GuardNotifyOnly } from "#shared/db/query-log.ts";
import { REFUND_ALL_BATCH_SIZE } from "#shared/db/refund-all-candidates.ts";
import { STALE_RESERVATION_MS } from "#shared/limits.ts";
import { nowMs } from "#shared/now.ts";
import { claimLeaseMs } from "#shared/payment/claim.ts";
import {
  createPaidListing,
  markAsRefunded,
  seedBatchAttendees,
  seedTaggedBatchAttendees,
} from "#test/features/admin/refunds-helpers.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  CLAIM_MIRROR,
  protectedStateOf,
  putRowState,
  REVIEW_MIRROR,
  refundClaimFixture,
  reviewCase,
  rowStateSlot,
  UNRECORDED_MIRROR,
} from "#test-utils/payment-claim.ts";
import {
  postRefundAll,
  refundIsRejected,
  withRefundMock,
} from "#test-utils/refund-routes.ts";

// jscpd:ignore-end

const REVIEWED_SET_SIZE = 3;

const lastRefundCandidate = async (
  listingId: number,
  expectedSize = REVIEWED_SET_SIZE,
): Promise<RefundCandidate> => {
  const candidates = await getRefundCandidates(
    await getAttendeesRaw(listingId),
    await getTestPrivateKey(),
  );
  expect(candidates).toHaveLength(expectedSize);
  const candidate = candidates.at(-1);
  if (candidate === undefined) {
    throw new Error("The listing has no last refund candidate");
  }
  return candidate;
};

const paymentRowOf = (candidate: RefundCandidate): string => {
  const sessionId = candidate.references[0]?.rowSessionIds[0];
  if (sessionId === undefined) {
    throw new Error("The last refund candidate has no payment row");
  }
  return sessionId;
};

const putReviewOnLastPayment = async (
  listingId: number,
  expectedSize = REVIEWED_SET_SIZE,
): Promise<void> => {
  const candidate = await lastRefundCandidate(listingId, expectedSize);
  await putRowState(
    paymentRowOf(candidate),
    await rowStateSlot({
      review: reviewCase({ kind: "partial_refund" }),
    }),
    REVIEW_MIRROR,
  );
};

const putUnrecordedOnLastPayment = async (
  listingId: number,
  expectedSize: number,
): Promise<void> => {
  const candidate = await lastRefundCandidate(listingId, expectedSize);
  await markPaymentReferencesProviderRefunded(candidate.references);
  await putRowState(
    paymentRowOf(candidate),
    await rowStateSlot({
      unrecorded: { returnedAt: "2026-08-13T12:00:00.000Z" },
    }),
    UNRECORDED_MIRROR,
  );
};

const refundCandidatesFor = async (listingId: number) =>
  await getRefundCandidates(
    await getAttendeesRaw(listingId),
    await getTestPrivateKey(),
  );

/** Leave each returned payment under a crashed claim. A later run only needs
 * to retire the claim; it must make bounded progress without provider calls. */
const putReturnedClaimsOnEveryPayment = async (
  listingId: number,
): Promise<string[]> => {
  const candidates = await refundCandidatesFor(listingId);
  const writtenAt = new Date(
    nowMs() - claimLeaseMs(STALE_RESERVATION_MS) - 1000,
  ).toISOString();
  const sessionIds: string[] = [];
  for (const candidate of candidates) {
    const attendeeReferences = candidate.references;
    await markPaymentReferencesProviderRefunded(attendeeReferences);
    await markAsRefunded(candidate.attendee.id);
    const sessionId = attendeeReferences[0]?.rowSessionIds[0];
    if (sessionId === undefined) {
      throw new Error(`Attendee ${candidate.attendee.id} has no payment row`);
    }
    await putRowState(
      sessionId,
      await rowStateSlot({
        claim: refundClaimFixture(
          candidate.attendee.id,
          "send_armed_keyed",
          writtenAt,
        ),
      }),
      CLAIM_MIRROR,
    );
    sessionIds.push(sessionId);
  }
  return sessionIds;
};

describeWithEnv(
  "server (admin refund-all safety admission)",
  { db: true },
  () => {
    beforeEach(() => setN1GuardNotifyOnly(true));
    afterEach(() => setN1GuardNotifyOnly(null));

    test("a review on the last payment stops every provider send", async () => {
      const listing = await createPaidListing({ maxAttendees: 500 });
      await seedBatchAttendees(listing, "pi_review_last_", REVIEWED_SET_SIZE);
      await putReviewOnLastPayment(listing.id);

      await withRefundMock(refundIsRejected, async (mockRefund) => {
        await postRefundAll(listing);
        expect(mockRefund.calls).toEqual([]);
      });
    });

    test("a review after the first refund batch stops every provider send", async () => {
      const listing = await createPaidListing({ maxAttendees: 500 });
      await seedBatchAttendees(
        listing,
        "pi_review_after_batch_",
        REFUND_ALL_BATCH_SIZE + 1,
      );
      await putReviewOnLastPayment(listing.id, REFUND_ALL_BATCH_SIZE + 1);

      await withRefundMock(refundIsRejected, async (mockRefund) => {
        await postRefundAll(listing);
        expect(mockRefund.calls).toEqual([]);
      });
    });

    test("unrecorded money after the first batch stops every provider send", async () => {
      const listing = await createPaidListing({ maxAttendees: 500 });
      await seedBatchAttendees(
        listing,
        "pi_unrecorded_after_batch_",
        REFUND_ALL_BATCH_SIZE + 1,
      );
      await putUnrecordedOnLastPayment(listing.id, REFUND_ALL_BATCH_SIZE + 1);

      await withRefundMock(refundIsRejected, async (mockRefund) => {
        await postRefundAll(listing);
        expect(mockRefund.calls).toEqual([]);
      });
    });

    test("more claims than one batch retire a bounded batch without deadlocking", async () => {
      const listing = await createPaidListing({ maxAttendees: 500 });
      await seedTaggedBatchAttendees(
        listing,
        "pi_claim_batch_",
        REFUND_ALL_BATCH_SIZE + 1,
      );
      const sessionIds = await putReturnedClaimsOnEveryPayment(listing.id);

      await withRefundMock(refundIsRejected, async (mockRefund) => {
        await postRefundAll(listing);
        expect(mockRefund.calls).toEqual([]);
      });

      const states = await Promise.all(sessionIds.map(protectedStateOf));
      expect(states.filter((state) => state === "")).toHaveLength(
        REFUND_ALL_BATCH_SIZE,
      );
      expect(states.filter((state) => state === "claim")).toHaveLength(1);
    });
  },
);
