// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getAttendeeAnswersByQuestion } from "#db/questions/attendee-answers/reads.ts";
import { getListingActivityLog } from "#test-utils/activity-log.ts";
import { expectFlash } from "#test-utils/assertions.ts";
import {
  assignMergeAnswers,
  mergePair,
  mergePairWithQuestion,
  submitMerge,
} from "#test-utils/attendees/merge.ts";
import { describeWithEnv } from "#test-utils/db.ts";

// jscpd:ignore-end

/** The merge record on the target's listing activity log. */
const mergeLog = async (listingId: number): Promise<string> => {
  const log = (await getListingActivityLog(listingId)).find((entry) =>
    entry.message.includes("merged into"),
  );
  if (!log) throw new Error("No merge log entry was recorded");
  return log.message;
};

/** The answer the surviving attendee holds for one question, or undefined
 *  when the merge cleared it. */
const answerOf = async (
  attendeeId: number,
  questionId: number,
): Promise<number | undefined> =>
  (await getAttendeeAnswersByQuestion(attendeeId)).get(questionId)?.answerId;

/** Set up a two-answer conflict (target holds the first, source the second),
 *  submit the merge with the given choice, and hand back what the log and the
 *  surviving answers now say. The source-named runs take the source's name so
 *  both arms of the merged-name decision stay pinned. */
const runAnswerConflict = async (
  questionText: string,
  choice: "source" | "clear",
  nameChoice: "source" | "target" = "target",
) => {
  const { a1, a2, listing1, q, sourceToken, target } =
    await mergePairWithQuestion(questionText, ["first", "second"]);
  await assignMergeAnswers(target.id, sourceToken, {
    source: [a2!.id],
    target: [a1.id],
  });
  const { response } = await submitMerge(target.id, sourceToken, {
    [`answer_${q.id}`]: choice,
    pii_name: nameChoice,
  });
  return { a1, a2, listing1, response, target };
};

describeWithEnv(
  "server (admin attendees) > merge decisions",
  { db: true },
  () => {
    test("a take_source booking decision replaces the target's row", async () => {
      const { listing1, target, sourceToken } = await mergePair({
        sameListing: true,
      });

      const { response } = await submitMerge(target.id, sourceToken, {
        [`booking_${listing1.id}:null:0:0`]: "take_source",
      });
      expect(response.status).toBe(302);
      // The flash is a short confirmation; the replaced count is log-only.
      expectFlash(response, "Merged John Smith into Jane Doe", true);
      expect(await mergeLog(listing1.id)).toBe(
        "Attendee 'John Smith' merged into 'Jane Doe'. 1 booking(s) replaced",
      );
    });

    test("a source answer decision takes the source's answer and logs it", async () => {
      const { a2, listing1, response, target } = await runAnswerConflict(
        "Size?",
        "source",
        "source",
      );
      expect(response.status).toBe(302);
      expect(await answerOf(target.id, a2!.question_id)).toBe(a2!.id);

      // The merged person is named by the name decision: the source here.
      expect(await mergeLog(listing1.id)).toBe(
        "Attendee 'John Smith' merged into 'John Smith'. 1 booking(s) moved. " +
          "1 answer(s) from source",
      );
    });

    test("a clear answer decision drops the answer and logs it", async () => {
      const { a1, listing1, response, target } = await runAnswerConflict(
        "Diet?",
        "clear",
        "target",
      );
      expect(response.status).toBe(302);
      expect(await answerOf(target.id, a1.question_id)).toBeUndefined();

      // Keeping the target's name names the merged person after the target.
      expect(await mergeLog(listing1.id)).toBe(
        "Attendee 'John Smith' merged into 'Jane Doe'. 1 booking(s) moved. " +
          "1 answer(s) cleared",
      );
    });
  },
);
