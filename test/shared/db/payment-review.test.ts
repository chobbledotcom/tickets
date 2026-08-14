import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { execute, withTransaction } from "#shared/db/client.ts";
import {
  type PaymentRowRecord,
  readAttendeeRowStates,
} from "#shared/db/payment-claim.ts";
import {
  acknowledgeCurrentPaymentReview,
  getPaymentReviewState,
  getPaymentWorkStatus,
} from "#shared/db/payment-review.ts";
import { nowIso } from "#shared/now.ts";
import type { PaymentReviewCase } from "#shared/payment/review.ts";
import type { PaymentRowState } from "#shared/payment/row-state.ts";
import { getAttendeeActivityLog } from "#test-utils/activity-log.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  CLAIM_MIRROR,
  protectedStateOf,
  putRowState,
  REVIEW_MIRROR,
  reviewCase,
  rowStateSlot,
  storedRecordOf,
} from "#test-utils/payment-claim.ts";
import {
  bookedWithPayment,
  finalizeProcessedPayment,
} from "#test-utils/processed-payments.ts";
import { addProviderRefundTestCase } from "#test-utils/provider-refund-cases.ts";

const LISTING_ID = 1;
const REVIEW_ACTIVITY = "Payment review acknowledged by owner";

const stateRows = (attendeeId: number): Promise<PaymentRowRecord[]> =>
  withTransaction((tx) => readAttendeeRowStates(tx, [attendeeId]));

const stateBySession = async (
  attendeeId: number,
): Promise<ReadonlyMap<string, PaymentRowState>> =>
  new Map(
    (await stateRows(attendeeId)).map((row) => [row.sessionId, row.state]),
  );

const reviewOf = async (
  attendeeId: number,
  sessionId: string,
): Promise<PaymentReviewCase> => {
  const state = (await stateBySession(attendeeId)).get(sessionId);
  if (state?.review === undefined) {
    throw new Error(`Payment row ${sessionId} has no review`);
  }
  return state.review;
};

const currentReviewIdentity = async (attendeeId: number): Promise<string> => {
  const state = await getPaymentReviewState(attendeeId);
  if (state.status !== "needs_review") {
    throw new Error(`Attendee ${attendeeId} has no current payment review`);
  }
  return state.identity;
};

const acknowledge = async (attendeeId: number, reviewIdentity?: string) => {
  const identity = reviewIdentity ?? (await currentReviewIdentity(attendeeId));
  return acknowledgeCurrentPaymentReview({
    attendeeId,
    listingId: LISTING_ID,
    reviewIdentity: identity,
  });
};

const putReview = async (
  sessionId: string,
  caseId = `case-${sessionId}`,
): Promise<void> => {
  await putRowState(
    sessionId,
    await rowStateSlot({
      review: reviewCase({ kind: "partially_returned_obligation" }, caseId),
    }),
    REVIEW_MIRROR,
  );
};

describeWithEnv(
  "db > acknowledging a payment review",
  { db: true, encryptionKey: true },
  () => {
    test("summarizes payment work by claim, owner review, ledger priority", async () => {
      const attendeeId = await bookedWithPayment("sess-status", "pi_status");
      expect(await getPaymentWorkStatus(attendeeId)).toBe("clear");

      await putReview("sess-status");
      expect(await getPaymentWorkStatus(attendeeId)).toBe("needs_review");

      await putRowState(
        "sess-status",
        await rowStateSlot({
          review: reviewCase({ kind: "partially_returned_obligation" }),
          unrecorded: { returnedAt: "2026-08-11T10:00:00.000Z" },
        }),
        REVIEW_MIRROR,
      );
      expect(await getPaymentWorkStatus(attendeeId)).toBe("needs_review");

      await putRowState(
        "sess-status",
        await rowStateSlot({
          claim: {
            attendeeIds: [attendeeId],
            commandId: "review-status-command",
            phase: "checking",
            scope: "attendee_set",
            writtenAt: nowIso(),
          },
          review: reviewCase({ kind: "partially_returned_obligation" }),
          unrecorded: { returnedAt: "2026-08-11T10:00:00.000Z" },
        }),
        CLAIM_MIRROR,
      );
      expect(await getPaymentWorkStatus(attendeeId)).toBe("moving");
    });

    test("projects canonical provider work onto the attendee action state", async () => {
      const reference = "pi_provider_work";
      const attendeeId = await bookedWithPayment("sess-provider", reference);
      await addProviderRefundTestCase(reference, undefined, "stripe");

      expect(await getPaymentWorkStatus(attendeeId)).toBe(
        "needs_provider_recovery",
      );
    });

    test("records acknowledgement without retiring payment facts", async () => {
      const attendeeId = await bookedWithPayment("sess-review", "pi_review");
      const review = reviewCase({ kind: "partially_returned_obligation" }, "exact-review");
      await putRowState(
        "sess-review",
        await rowStateSlot({
          outcome: { error: "Existing outcome", refunded: true, status: 409 },
          review,
        }),
        REVIEW_MIRROR,
      );

      expect(await acknowledge(attendeeId)).toEqual({ kind: "acknowledged" });
      expect(await getPaymentWorkStatus(attendeeId)).toBe("needs_review");
      expect(await reviewOf(attendeeId, "sess-review")).toEqual({
        ...review,
        acknowledgedAt: expect.any(String),
      });
      expect(await protectedStateOf("sess-review")).toBe(REVIEW_MIRROR);
      expect(await getAttendeeActivityLog(attendeeId)).toEqual([
        expect.objectContaining({
          attendee_id: attendeeId,
          listing_id: LISTING_ID,
          message: REVIEW_ACTIVITY,
        }),
      ]);
    });

    test("an owner review stays reachable while its money record waits", async () => {
      const attendeeId = await bookedWithPayment("sess-money", "pi_money");
      const review = reviewCase({ kind: "partially_returned_obligation" }, "money-review");
      await putRowState(
        "sess-money",
        await rowStateSlot({
          review,
          unrecorded: { returnedAt: "2026-08-11T10:00:00.000Z" },
        }),
        REVIEW_MIRROR,
      );

      expect(await acknowledge(attendeeId)).toEqual({ kind: "acknowledged" });
      expect(await reviewOf(attendeeId, "sess-money")).toEqual({
        ...review,
        acknowledgedAt: expect.any(String),
      });
      expect((await stateBySession(attendeeId)).get("sess-money")).toEqual(
        expect.objectContaining({
          unrecorded: { returnedAt: "2026-08-11T10:00:00.000Z" },
        }),
      );
      expect(await protectedStateOf("sess-money")).toBe(REVIEW_MIRROR);
      expect(await getAttendeeActivityLog(attendeeId)).toHaveLength(1);
    });

    test("a claim blocks acknowledgement without changing or logging", async () => {
      const attendeeId = await bookedWithPayment("sess-block", "pi-block");
      await putRowState(
        "sess-block",
        await rowStateSlot({
          claim: {
            attendeeIds: [attendeeId],
            commandId: "review-block-command",
            phase: "checking",
            scope: "attendee_set",
            writtenAt: nowIso(),
          },
          review: reviewCase({ kind: "partially_returned_obligation" }),
        }),
        CLAIM_MIRROR,
      );
      const before = await storedRecordOf("sess-block");

      expect(
        await acknowledgeCurrentPaymentReview({
          attendeeId,
          listingId: LISTING_ID,
          reviewIdentity: "stale-form",
        }),
      ).toEqual({ kind: "claim_in_progress" });
      expect(await storedRecordOf("sess-block")).toBe(before);
      expect(await getAttendeeActivityLog(attendeeId)).toEqual([]);
    });

    test("returns nothing to review without writing activity", async () => {
      const attendeeId = await bookedWithPayment("sess-none", "pi-none");
      expect(
        await acknowledgeCurrentPaymentReview({
          attendeeId,
          listingId: LISTING_ID,
          reviewIdentity: "old-form",
        }),
      ).toEqual({ kind: "nothing_to_review" });
      expect(await getAttendeeActivityLog(attendeeId)).toEqual([]);
    });

    test("a stale form cannot acknowledge a newer instance of the same reason", async () => {
      const attendeeId = await bookedWithPayment("sess-changed", "pi-changed");
      await putReview("sess-changed", "first-case");
      const oldIdentity = await currentReviewIdentity(attendeeId);
      await putReview("sess-changed", "new-case");

      expect(await acknowledge(attendeeId, oldIdentity)).toEqual({
        kind: "review_changed",
      });
      expect(await reviewOf(attendeeId, "sess-changed")).toEqual(
        reviewCase({ kind: "partially_returned_obligation" }, "new-case"),
      );
      expect(await getAttendeeActivityLog(attendeeId)).toEqual([]);
    });

    test("concurrent replay acknowledges and logs exactly once", async () => {
      const attendeeId = await bookedWithPayment("sess-race", "pi-race");
      await putReview("sess-race");
      const identity = await currentReviewIdentity(attendeeId);

      const results = await Promise.all([
        acknowledge(attendeeId, identity),
        acknowledge(attendeeId, identity),
      ]);

      expect(results.map(({ kind }) => kind).sort()).toEqual([
        "acknowledged",
        "already_acknowledged",
      ]);
      expect(await getPaymentWorkStatus(attendeeId)).toBe("needs_review");
      expect(
        (await getAttendeeActivityLog(attendeeId)).map(
          ({ message }) => message,
        ),
      ).toEqual([REVIEW_ACTIVITY]);
    });

    test("acknowledges every unacknowledged row and preserves an earlier time", async () => {
      const attendeeId = await bookedWithPayment("sess-first", "pi-first");
      await finalizeProcessedPayment("sess-second", attendeeId, "tok-second");
      const earlier = "2026-08-11T09:00:00.000Z";
      await putRowState(
        "sess-first",
        await rowStateSlot({
          review: {
            ...reviewCase({ kind: "partially_returned_obligation" }, "first-case"),
            acknowledgedAt: earlier,
          },
        }),
        REVIEW_MIRROR,
      );
      await putReview("sess-second", "second-case");

      expect(await acknowledge(attendeeId)).toEqual({ kind: "acknowledged" });
      expect((await reviewOf(attendeeId, "sess-first")).acknowledgedAt).toBe(
        earlier,
      );
      expect(
        (await reviewOf(attendeeId, "sess-second")).acknowledgedAt,
      ).toEqual(expect.any(String));
    });

    test("a missed row write rolls the whole acknowledgement back", async () => {
      const attendeeId = await bookedWithPayment("sess-cas-first", "pi-cas");
      await finalizeProcessedPayment("sess-cas-lost", attendeeId, "tok-cas");
      await putReview("sess-cas-first");
      await putReview("sess-cas-lost");
      await execute(
        `CREATE TRIGGER ignore_payment_review
          BEFORE UPDATE ON processed_payments
          WHEN OLD.payment_session_id = 'sess-cas-lost'
          BEGIN SELECT RAISE(IGNORE); END`,
      );

      await expect(acknowledge(attendeeId)).rejects.toThrow(
        /^Payment review no longer owns its payment row$/u,
      );
      expect(
        (await reviewOf(attendeeId, "sess-cas-first")).acknowledgedAt,
      ).toBeUndefined();
      expect(
        (await reviewOf(attendeeId, "sess-cas-lost")).acknowledgedAt,
      ).toBeUndefined();
      expect(await getAttendeeActivityLog(attendeeId)).toEqual([]);
    });

    test("an activity failure leaves acknowledgement undone", async () => {
      const attendeeId = await bookedWithPayment("sess-log", "pi-log");
      await putReview("sess-log");
      await execute(
        `CREATE TRIGGER refuse_payment_review_activity
          BEFORE INSERT ON activity_log
          BEGIN SELECT RAISE(ABORT, 'activity unavailable'); END`,
      );

      await expect(acknowledge(attendeeId)).rejects.toThrow(
        "activity unavailable",
      );
      expect(
        (await reviewOf(attendeeId, "sess-log")).acknowledgedAt,
      ).toBeUndefined();
    });

    test("changes only the named attendee's exact review", async () => {
      const named = await bookedWithPayment("sess-named", "pi-named");
      const other = await bookedWithPayment("sess-other", "pi-other");
      await putReview("sess-named");
      await putReview("sess-other");

      expect(await acknowledge(named)).toEqual({ kind: "acknowledged" });
      expect((await reviewOf(named, "sess-named")).acknowledgedAt).toEqual(
        expect.any(String),
      );
      expect(
        (await reviewOf(other, "sess-other")).acknowledgedAt,
      ).toBeUndefined();
      expect(await getAttendeeActivityLog(other)).toEqual([]);
    });
  },
);
