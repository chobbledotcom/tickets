// jscpd:ignore-start

import { assertArrayIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
// jscpd:ignore-end
import { attendeeAccount } from "#accounting/accounts.ts";
import { queryAll } from "#db/client.ts";
import {
  assignMergeAnswers,
  mergePairWithQuestion,
  submitMerge,
} from "#test-utils/attendees/merge.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { withDbFault } from "#test-utils/db-fault.ts";
import { postListingSale, rejection } from "#test-utils/ledger.ts";
import {
  finalizeProcessedPayment,
  taggedPaymentReference,
} from "#test-utils/processed-payments.ts";

/** Everything the merge writes, read back raw, so a failed merge can be
 *  compared with the state it started from. The source attendee is part of the
 *  state: a merge that loses its writes must not have deleted it either. */
type MergeRowState = {
  answers: { answer_id: number; attendee_id: number; question_id: number }[];
  attendees: { id: number; pii_blob: string }[];
  payments: { attendee_id: number; payment_session_id: string }[];
  transfers: {
    amount: number;
    dest_id: string;
    id: number;
    source_id: string;
  }[];
};

const mergeRowState = async (
  targetId: number,
  sourceId: number,
): Promise<MergeRowState> => {
  const sourceAccount = attendeeAccount(sourceId);
  return {
    answers: await queryAll(
      `SELECT attendee_id, answer_id, question_id
         FROM attendee_answers
        WHERE attendee_id IN (?, ?)
        ORDER BY attendee_id, question_id, answer_id`,
      [targetId, sourceId],
    ),
    attendees: await queryAll(
      "SELECT id, pii_blob FROM attendees WHERE id IN (?, ?) ORDER BY id",
      [targetId, sourceId],
    ),
    payments: await queryAll(
      `SELECT attendee_id, payment_session_id
         FROM processed_payments
        WHERE attendee_id IN (?, ?)
        ORDER BY payment_session_id`,
      [targetId, sourceId],
    ),
    transfers: await queryAll(
      `SELECT id, source_id, dest_id, amount
         FROM transfers
        WHERE (source_id = ? AND source_type = ?)
           OR (dest_id = ? AND dest_type = ?)
        ORDER BY id`,
      [
        sourceAccount.id,
        sourceAccount.type,
        sourceAccount.id,
        sourceAccount.type,
      ],
    ),
  };
};

describeWithEnv(
  "server (admin attendees) > a merge that fails partway",
  { db: true, encryptionKey: true },
  () => {
    /** One merge pair with an answer conflict, a source payment row, and one
     *  posted sale, so every table the merge writes holds a row to protect. */
    const protectedPair = async (sessionId: string) => {
      const pair = await mergePairWithQuestion("Size?", ["Small", "Large"]);
      await assignMergeAnswers(pair.target.id, pair.sourceToken, {
        source: [pair.a2!.id],
        target: [pair.a1.id],
      });
      await finalizeProcessedPayment(
        sessionId,
        pair.source.id,
        "tok",
        taggedPaymentReference(`pi_${sessionId}`),
      );
      await postListingSale({
        attendeeId: pair.source.id,
        gross: 50,
        listingId: pair.listing2!.id,
      });
      return pair;
    };

    /** The merged answers write refuses, and every other write stays
     *  available. Only the save's own delete (the target's rows) trips it —
     *  the merge batch deletes the source's rows and must pass. */
    const withAnswersWriteFault =
      (targetId: number) =>
      <T>(body: () => Promise<T>) =>
        withDbFault(
          `CREATE TRIGGER test_merge_answers_fault
          BEFORE DELETE ON attendee_answers
          WHEN OLD.attendee_id = ${targetId}
          BEGIN
            SELECT RAISE(ABORT, 'merged answers write refused');
          END`,
          "test_merge_answers_fault",
          body,
        );

    /** The target's PII write refuses, and every other write stays
     *  available. The batch's pii_payment_session_id update does not touch
     *  pii_blob, so only the feature layer's PII write trips it. */
    const withPiiWriteFault =
      (targetId: number) =>
      <T>(body: () => Promise<T>) =>
        withDbFault(
          `CREATE TRIGGER test_merge_pii_fault
          BEFORE UPDATE OF pii_blob ON attendees
          WHEN NEW.id = ${targetId}
          BEGIN
            SELECT RAISE(ABORT, 'merged PII write refused');
          END`,
          "test_merge_pii_fault",
          body,
        );

    /** Run the merge under one write fault; the fault must reach the POST as a
     *  rejection, and the row state must come back exactly as it started. */
    const mergeUnderFault = async (
      sessionId: string,
      withFault: (
        targetId: number,
      ) => <T>(body: () => Promise<T>) => Promise<T>,
    ) => {
      const pair = await protectedPair(sessionId);
      const before = await mergeRowState(pair.target.id, pair.source.id);
      const submit = async (): Promise<Response> => {
        const { response } = await submitMerge(
          pair.target.id,
          pair.sourceToken,
          {
            [`answer_${pair.q.id}`]: "source",
          },
        );
        return response;
      };
      await withFault(pair.target.id)(() => rejection(submit()));
      const after = await mergeRowState(pair.target.id, pair.source.id);
      return { after, before, source: pair.source };
    };

    test("a failed answers write leaves every row as it was", async () => {
      const { after, before, source } = await mergeUnderFault(
        "sess-merge-answers-fault",
        withAnswersWriteFault,
      );

      // The answers are recoverable only from the source, so the source must
      // have survived the failed merge with its rows intact.
      assertArrayIncludes(
        after.attendees.map((row) => row.id),
        [source.id],
      );
      expect(after).toEqual(before);
    });

    test("a failed PII write leaves every row as it was", async () => {
      const { after, before, source } = await mergeUnderFault(
        "sess-merge-pii-fault",
        withPiiWriteFault,
      );

      assertArrayIncludes(
        after.attendees.map((row) => row.id),
        [source.id],
      );
      expect(after).toEqual(before);
    });
  },
);
