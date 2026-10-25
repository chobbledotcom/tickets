// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getAttendeeAnswersByQuestion } from "#db/questions/attendee-answers/reads.ts";
import { getListingActivityLog } from "#test-utils/activity-log.ts";
import { expectFlash } from "#test-utils/assertions.ts";
import {
  mergeWithAnswerConflict,
  submitBookingDecision,
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

describeWithEnv(
  "server (admin attendees) > merge decisions",
  { db: true },
  () => {
    test("a take_source booking decision replaces the target's row", async () => {
      const { listing1, response } = await submitBookingDecision("take_source");
      expect(response.status).toBe(302);
      // The flash is a short confirmation; the replaced count is log-only.
      expectFlash(response, "Merged John Smith into Jane Doe", true);
      expect(await mergeLog(listing1.id)).toBe(
        "Attendee 'John Smith' merged into 'Jane Doe'. 1 booking(s) replaced",
      );
    });

    test("a source answer decision takes the source's answer and logs it", async () => {
      const { a2, listing1, response, target } = await mergeWithAnswerConflict(
        "Size?",
        ["first", "second"],
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
      const { a1, listing1, response, target } = await mergeWithAnswerConflict(
        "Diet?",
        ["first", "second"],
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
