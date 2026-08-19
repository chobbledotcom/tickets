// jscpd:ignore-start -- imports
import { expect } from "@std/expect";
import { afterEach, beforeEach, it as test } from "@std/testing/bdd";
import { execute, getDb, type SqlStatement, setDb } from "#db/client.ts";
import { wrapExecute } from "#db/libsql-call.ts";
import { setN1GuardNotifyOnly } from "#db/query-log.ts";
import { claimLeaseMs } from "#payment/claim.ts";
import type { RefundCandidate } from "#routes/admin/refunds/candidates.ts";
import { STALE_RESERVATION_MS } from "#shared/limits.ts";
import { nowMs } from "#shared/now.ts";
import { proxyMembers } from "#shared/proxy-members.ts";
import {
  createPaidListing,
  createRefundableAttendee,
  markAsRefunded,
  seedTaggedBatchAttendees,
} from "#test/features/admin/refunds-helpers.ts";
import { expectFlashRedirect } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createPaidTestAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { awaitTestRequest } from "#test-utils/mocks.ts";
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
import { markProviderRefundsReturned } from "#test-utils/payment-references.ts";
import {
  finalizeProcessedPayment,
  taggedPaymentReference,
} from "#test-utils/processed-payments.ts";
import { getCompleteRefundCandidatesForListing } from "#test-utils/refund-candidates.ts";
import {
  postRefundAll,
  refundAllUrl,
  refundIsRejected,
  withRefundMock,
} from "#test-utils/refund-routes.ts";
import { testCookie } from "#test-utils/session.ts";

// jscpd:ignore-end

const EXPECTED_REFUND_ALL_PAGE_SIZE = 1;
const REVIEWED_SET_SIZE = 3;

const lastRefundCandidate = async (
  listingId: number,
  expectedSize: number,
): Promise<RefundCandidate> => {
  const candidates = await getCompleteRefundCandidatesForListing(listingId);
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
      review: reviewCase({ kind: "partially_returned_obligation" }),
    }),
    REVIEW_MIRROR,
  );
};

const putUnrecordedOnLastPayment = async (
  listingId: number,
  expectedSize: number,
): Promise<void> => {
  const candidate = await lastRefundCandidate(listingId, expectedSize);
  await markProviderRefundsReturned(candidate.references, "due");
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
  await seedTaggedBatchAttendees(listing, paymentPrefix, attendeeCount);
  await putBlocker(listing.id, attendeeCount);

  await withRefundMock(refundIsRejected, async (mockRefund) => {
    await postRefundAll(listing);
    expect(mockRefund.calls).toEqual([]);
  });
};

const refundCandidatesFor = async (listingId: number) =>
  await getCompleteRefundCandidatesForListing(listingId);

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
    await markProviderRefundsReturned(attendeeReferences);
    await markAsRefunded(candidate.attendee.id);
    const sessionId = attendeeReferences[0]?.rowSessionIds[0];
    if (sessionId === undefined) {
      throw new Error(`Attendee ${candidate.attendee.id} has no payment row`);
    }
    await putRowState(
      sessionId,
      await rowStateSlot({
        claim: refundClaimFixture(candidate.attendee.id, "checking", writtenAt),
      }),
      CLAIM_MIRROR,
    );
    sessionIds.push(sessionId);
  }
  return sessionIds;
};

const withPaymentChangeBeforeReferenceLoad = async (
  change: SqlStatement,
  work: () => Promise<void>,
): Promise<void> => {
  const real = getDb();
  let changed = false;
  setDb(
    proxyMembers(real, {
      execute: wrapExecute(real, async (statement, execute) => {
        const sql = typeof statement === "string" ? statement : statement.sql;
        if (
          !changed &&
          sql.includes("FROM processed_payments") &&
          sql.includes("attendee_id IN")
        ) {
          changed = true;
          await real.execute(change);
        }
        return await execute();
      }),
    }),
  );

  try {
    await work();
  } finally {
    setDb(real);
  }
  expect(changed).toBe(true);
};

describeWithEnv(
  "server (admin refund-all safety admission)",
  { db: true },
  () => {
    const errors = setupErrorSpy();
    beforeEach(() => setN1GuardNotifyOnly(true));
    afterEach(() => setN1GuardNotifyOnly(null));

    test("a review on the last payment stops every provider send", async () => {
      await expectBlockerStopsRefundAll(
        "pi_review_last_",
        REVIEWED_SET_SIZE,
        putReviewOnLastPayment,
      );
    });

    test("a blocker explains why Refund All is unavailable without offering its form", async () => {
      const listing = await createPaidListing({ maxAttendees: 500 });
      await seedTaggedBatchAttendees(listing, "pi_blocked_page_", 2);
      await putReviewOnLastPayment(listing.id, 2);

      const response = await awaitTestRequest(refundAllUrl(listing.id), {
        cookie: await testCookie(),
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain(
        "This payment needs an owner review before another refund can be attempted.",
      );
      expect(html).not.toContain(
        `action="/admin/listing/${listing.id}/refund-all"`,
      );
      expect(html).not.toContain("Refund All Attendees");
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

    test("a review on a settled payment does not block another candidate", async () => {
      const listing = await createPaidListing();
      const settled = await createRefundableAttendee(
        listing.id,
        "Settled Payment",
        "settled-payment@example.com",
        "pi_settled_review",
      );
      await createRefundableAttendee(
        listing.id,
        "Refund Candidate",
        "refund-candidate@example.com",
        "pi_remaining_candidate",
      );
      const settledCandidate = (await refundCandidatesFor(listing.id)).find(
        ({ attendee }) => attendee.id === settled.id,
      );
      if (settledCandidate === undefined) {
        throw new Error("The settled attendee has no payment candidate");
      }
      await markProviderRefundsReturned(settledCandidate.references);
      await markAsRefunded(settled.id);
      await putRowState(
        paymentRowOf(settledCandidate),
        await rowStateSlot({
          review: reviewCase({ kind: "partially_returned_obligation" }),
        }),
        REVIEW_MIRROR,
      );
      setN1GuardNotifyOnly(false);

      await withRefundMock(refundIsRejected, async (mockRefund) => {
        await postRefundAll(listing);
        expect(
          mockRefund.calls.map((call) => call.args[0].paymentReference),
        ).toEqual(["pi_remaining_candidate"]);
      });
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

    test("throws when a selected current payment disappears while loading", async () => {
      const listing = await createPaidListing();
      const attendee = await createPaidTestAttendee(
        listing.id,
        "Changed Current Payment",
        "changed-current-payment@example.com",
        "",
      );
      await finalizeProcessedPayment(
        "changed_current_payment",
        attendee.id,
        "",
        taggedPaymentReference("pi_changed_current_payment"),
      );
      await withPaymentChangeBeforeReferenceLoad(
        {
          args: [attendee.id],
          sql: "DELETE FROM processed_payments WHERE attendee_id = ?",
        },
        async () => {
          await withRefundMock(refundIsRejected, async (mockRefund) => {
            await expect(postRefundAll(listing)).rejects.toThrow(
              "Refund All candidate set changed while it was loading",
            );
            expect(mockRefund.calls).toEqual([]);
          });
        },
      );
      expect(
        errors.contains(
          "Refund All candidate set changed while it was loading",
        ),
      ).toBe(true);
    });

    test("a reference becoming incomplete after batch admission stops before any send", async () => {
      const listing = await createPaidListing();
      const attendee = await createRefundableAttendee(
        listing.id,
        "Changed Payment History",
        "changed-payment-history@example.com",
        "pi_changed_payment_history",
      );

      await withPaymentChangeBeforeReferenceLoad(
        {
          args: [attendee.id],
          sql: `UPDATE processed_payments
                   SET payment_reference_index = ''
                 WHERE attendee_id = ?`,
        },
        async () => {
          await withRefundMock(refundIsRejected, async (mockRefund) => {
            await expectFlashRedirect(
              `/admin/listing/${listing.id}/refund-all`,
              "This attendee has older payment history that cannot be refunded here. Refund it directly through the payment provider. No money was sent.",
              false,
            )(await postRefundAll(listing));
            expect(mockRefund.calls).toEqual([]);
          });
        },
      );
    });

    test("a selected PII-only payment stops an indexed sibling before any send", async () => {
      const listing = await createPaidListing();
      const attendee = await createPaidTestAttendee(
        listing.id,
        "Old Deposit",
        "old-deposit@example.com",
        "pi_old_deposit",
      );
      await execute("DELETE FROM processed_payments WHERE attendee_id = ?", [
        attendee.id,
      ]);
      await finalizeProcessedPayment(
        "new_balance_payment",
        attendee.id,
        "",
        taggedPaymentReference("pi_new_balance"),
      );

      await withRefundMock(refundIsRejected, async (mockRefund) => {
        await expectFlashRedirect(
          `/admin/listing/${listing.id}/refund-all`,
          expect.stringContaining("older payment history"),
          false,
        )(await postRefundAll(listing));
        expect(mockRefund.calls).toEqual([]);
      });
    });
  },
);
