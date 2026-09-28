/** The attendee answer reads this branch changed: the choice-id read the
 * registration emails pin to the primary, beside the by-question read it
 * shares its shape with. */

import { expect } from "@std/expect";
import { beforeEach, it as test } from "@std/testing/bdd";
import { execute } from "#db/client.ts";
import {
  choiceAnswerIdsPrimary,
  getAttendeeAnswersByQuestion,
} from "#db/questions/attendee-answers/reads.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendeeDirect } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { createQuestionWithAnswer } from "#test-utils/db-helpers/questions.ts";

describeWithEnv(
  "db > attendee answer reads",
  { db: true, triggers: true },
  () => {
    let attendeeId: number;
    let questionId: number;
    let answerId: number;

    beforeEach(async () => {
      const listing = await createTestListing({ maxAttendees: 5 });
      const { attendee } = await createTestAttendeeDirect(
        listing.id,
        "Answer Reader",
        `reader-${Date.now()}-${Math.floor(Math.random() * 10_000)}@example.com`,
      );
      const created = await createQuestionWithAnswer([listing.id]);
      questionId = created.questionId;
      answerId = created.answerId;
      attendeeId = attendee.id;
      // Book the choice the way a paid booking's tail does: one
      // attendee_answers row naming the chosen answer id.
      await execute(
        `INSERT INTO attendee_answers (attendee_id, question_id, answer_id)
         VALUES (?, ?, ?)`,
        [attendee.id, questionId, answerId],
      );
    });

    test("reads the chosen answer ids pinned to the primary", async () => {
      const choices = await choiceAnswerIdsPrimary([attendeeId]);

      expect(choices.get(attendeeId)).toEqual([answerId]);
    });

    test("groups the chosen ids under each question", async () => {
      const byQuestion = await getAttendeeAnswersByQuestion(attendeeId);

      expect(byQuestion.get(questionId)).toEqual({
        answerId,
        answerText: "Chosen",
      });
    });
  },
);
