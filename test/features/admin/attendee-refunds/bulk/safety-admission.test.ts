// jscpd:ignore-start -- imports
import { expect } from "@std/expect";
import { afterEach, beforeEach, it as test } from "@std/testing/bdd";
import {
  getRefundCandidates,
  type RefundCandidate,
} from "#routes/admin/refunds/candidates.ts";
import { getAttendeesRaw } from "#shared/db/attendees/queries.ts";
import { getDb, setDb } from "#shared/db/client.ts";
import { wrapExecute } from "#shared/db/libsql-call.ts";
import { markPaymentReferencesProviderRefunded } from "#shared/db/payment-references.ts";
import { setN1GuardNotifyOnly } from "#shared/db/query-log.ts";
import { STALE_RESERVATION_MS } from "#shared/limits.ts";
import { nowMs } from "#shared/now.ts";
import { claimLeaseMs } from "#shared/payment/claim.ts";
import { proxyMembers } from "#shared/proxy-members.ts";
import {
  createPaidListing,
  markAsRefunded,
  seedBatchAttendees,
  seedTaggedBatchAttendees,
} from "#test/features/admin/refunds-helpers.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createPaidTestAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { withExpectedError } from "#test-utils/mocks.ts";
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

const EXPECTED_REFUND_ALL_PAGE_SIZE = 5;
const REVIEWED_SET_SIZE = 3;

const lastRefundCandidate = async (
  listingId: number,
  expectedSize: number,
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
  expectedSize: number,
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

type RefundAllBlocker = (
  listingId: number,
  attendeeCount: number,
) => Promise<void>;

const expectBlockerStopsRefundAll = async (
  paymentPrefix: string,
  attendeeCount: number,
  putBlocker: RefundAllBlocker,
): Promise<void> => {
  const listing = await createPaidListing({ maxAttendees: 500 });
  await seedBatchAttendees(listing, paymentPrefix, attendeeCount);
  await putBlocker(listing.id, attendeeCount);

  await withRefundMock(refundIsRejected, async (mockRefund) => {
    await postRefundAll(listing);
    expect(mockRefund.calls).toEqual([]);
  });
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
      await expectBlockerStopsRefundAll(
        "pi_review_last_",
        REVIEWED_SET_SIZE,
        putReviewOnLastPayment,
      );
    });

    test("a review after the first refund batch stops every provider send", async () => {
      await expectBlockerStopsRefundAll(
        "pi_review_after_batch_",
        EXPECTED_REFUND_ALL_PAGE_SIZE + 1,
        putReviewOnLastPayment,
      );
    });

    test("unrecorded money after the first batch stops every provider send", async () => {
      await expectBlockerStopsRefundAll(
        "pi_unrecorded_after_batch_",
        EXPECTED_REFUND_ALL_PAGE_SIZE + 1,
        putUnrecordedOnLastPayment,
      );
    });

    test("more claims than one batch retire a bounded batch without deadlocking", async () => {
      const listing = await createPaidListing({ maxAttendees: 500 });
      await seedTaggedBatchAttendees(
        listing,
        "pi_claim_batch_",
        EXPECTED_REFUND_ALL_PAGE_SIZE + 1,
      );
      const sessionIds = await putReturnedClaimsOnEveryPayment(listing.id);

      await withRefundMock(refundIsRejected, async (mockRefund) => {
        await postRefundAll(listing);
        expect(mockRefund.calls).toEqual([]);
      });

      const states = await Promise.all(sessionIds.map(protectedStateOf));
      expect(states.filter((state) => state === "")).toHaveLength(
        EXPECTED_REFUND_ALL_PAGE_SIZE,
      );
      expect(states.filter((state) => state === "claim")).toHaveLength(1);
    });

    test("fails closed when a selected payment disappears before references load", async () => {
      const listing = await createPaidListing();
      const attendee = await createPaidTestAttendee(
        listing.id,
        "Changed Payment",
        "changed-payment@example.com",
        "pi_changed_payment",
      );
      const real = getDb();
      let changed = false;
      setDb(
        proxyMembers(real, {
          execute: wrapExecute(real, async (statement, execute) => {
            const sql =
              typeof statement === "string" ? statement : statement.sql;
            if (
              !changed &&
              sql.includes("FROM processed_payments") &&
              sql.includes("attendee_id IN")
            ) {
              changed = true;
              await real.execute(
                "DELETE FROM processed_payments WHERE attendee_id = ?",
                [attendee.id],
              );
            }
            return await execute();
          }),
        }),
      );

      try {
        await withRefundMock(refundIsRejected, async (mockRefund) => {
          const response = await withExpectedError(() =>
            postRefundAll(listing),
          );
          expect(response.status).toBe(503);
          expect(mockRefund.calls).toEqual([]);
        });
      } finally {
        setDb(real);
      }
      expect(changed).toBe(true);
    });
  },
);
