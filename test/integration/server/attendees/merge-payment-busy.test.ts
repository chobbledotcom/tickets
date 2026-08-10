// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
// jscpd:ignore-end
import { queryOne } from "#shared/db/client.ts";
import { mergePair, submitMerge } from "#test/test-utils/attendees/merge.ts";
import { expectFlash } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  CLAIM_MIRROR,
  freshClaimSlot,
  putRowState,
  REVIEW_MIRROR,
  rowStateSlot,
} from "#test-utils/payment-claim.ts";
import { finalizeProcessedPayment } from "#test-utils/processed-payments.ts";

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
        `pi_${sessionId}`,
      );
      return pair;
    };

    describe("a refund still in progress", () => {
      test("the merge is refused and says so", async () => {
        const { target, source, sourceToken } =
          await pairWithSourcePayment("sess-merge-held");
        await putRowState(
          "sess-merge-held",
          await freshClaimSlot(source.id),
          CLAIM_MIRROR,
        );

        const { response } = await submitMerge(target.id, sourceToken);

        expectFlash(
          response,
          expect.stringContaining(
            "refund for this person is still in progress",
          ),
          false,
        );
      });

      test("nothing moves, so the run still holds what it claimed", async () => {
        const { target, source, sourceToken } = await pairWithSourcePayment(
          "sess-merge-rollback",
        );
        await putRowState(
          "sess-merge-rollback",
          await freshClaimSlot(source.id),
          CLAIM_MIRROR,
        );

        await submitMerge(target.id, sourceToken);

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
          await rowStateSlot({ review: { kind: "partial_refund" } }),
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
          await rowStateSlot({ review: { kind: "partial_refund" } }),
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
