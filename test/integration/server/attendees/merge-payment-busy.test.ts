// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
// jscpd:ignore-end
import { queryOne } from "#db/client.ts";
import { expectFlash } from "#test-utils/assertions.ts";
import {
  getMergeVersion,
  mergePair,
  submitMerge,
} from "#test-utils/attendees/merge.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  CLAIM_MIRROR,
  freshClaimSlot,
  putRowState,
  REVIEW_MIRROR,
  reviewCase,
  rowStateSlot,
} from "#test-utils/payment-claim.ts";
import {
  finalizeProcessedPayment,
  taggedPaymentReference,
} from "#test-utils/processed-payments.ts";
import { adminFormPost } from "#test-utils/session.ts";

/** Who owns the payment row now, and what the prune can see on it. Both facts
 *  in one read, because "did the merge move it" and "did the marker survive"
 *  are the same question asked of one row. */
const paymentRow = (
  sessionId: string,
): Promise<{ attendee_id: number; protected_state: string } | null> =>
  queryOne(
    `SELECT attendee_id, protected_state
       FROM processed_payments
      WHERE payment_session_id = ?`,
    [sessionId],
  );

describeWithEnv(
  "server (admin attendees) > merging someone whose payment is busy",
  { db: true, encryptionKey: true },
  () => {
    /** A merge pair whose SOURCE carries one finalized payment row. */
    const pairWithSourcePayment = async (sessionId: string) => {
      const pair = await mergePair();
      await finalizeProcessedPayment(
        sessionId,
        pair.source.id,
        "tok",
        taggedPaymentReference(`pi_${sessionId}`),
      );
      return pair;
    };

    /** Render an admitted preview, then let a refund claim win before POST. */
    const submitAfterRefundStarts = async (sessionId: string) => {
      const { target, source, sourceToken } =
        await pairWithSourcePayment(sessionId);
      const mergeVersion = await getMergeVersion(target.id, sourceToken);
      await putRowState(
        sessionId,
        await freshClaimSlot(source.id),
        CLAIM_MIRROR,
      );
      const { response } = await adminFormPost(
        `/admin/attendees/${target.id}/merge`,
        { merge_version: mergeVersion, source_token: sourceToken },
      );
      return { response, source };
    };

    describe("a refund still in progress", () => {
      test("a claim arriving after preview is refused and says so", async () => {
        const { response } = await submitAfterRefundStarts("sess-merge-held");

        expectFlash(
          response,
          expect.stringContaining(
            "refund for this person is still in progress",
          ),
          false,
        );
      });

      test("nothing moves, so the run still holds what it claimed", async () => {
        const { source } = await submitAfterRefundStarts("sess-merge-rollback");

        // The whole merge rolls back: had the row changed hands mid-refund, the
        // run holding it would finish against an attendee that no longer owns
        // the money.
        expect(await paymentRow("sess-merge-rollback")).toEqual({
          attendee_id: source.id,
          protected_state: CLAIM_MIRROR,
        });
      });
    });

    describe("a payment the owner still has to check", () => {
      test("the merge goes ahead", async () => {
        const { target, sourceToken } =
          await pairWithSourcePayment("sess-merge-review");
        await putRowState(
          "sess-merge-review",
          await rowStateSlot({
            review: reviewCase({ kind: "partially_returned_obligation" }),
          }),
          REVIEW_MIRROR,
        );

        const { response } = await submitMerge(target.id, sourceToken);

        // A merge only relocates the row, so the review is not destroyed by it
        // — unlike a delete, which is refused for exactly that reason.
        expectFlash(response, expect.stringContaining("Merged"), true);
      });

      test("the review rides across to the merged person", async () => {
        const { target, sourceToken } = await pairWithSourcePayment(
          "sess-merge-review-moves",
        );
        await putRowState(
          "sess-merge-review-moves",
          await rowStateSlot({
            review: reviewCase({ kind: "partially_returned_obligation" }),
          }),
          REVIEW_MIRROR,
        );

        await submitMerge(target.id, sourceToken);

        // The marker lands on the target untouched, so the one review still to
        // do now gates the person who owns the money.
        expect(await paymentRow("sess-merge-review-moves")).toEqual({
          attendee_id: target.id,
          protected_state: REVIEW_MIRROR,
        });
      });
    });
  },
);
