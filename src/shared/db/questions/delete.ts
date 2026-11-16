/**
 * Deletion for questions and answers (and their dependent rows).
 */

import { inOneBatch, removalWithChildren } from "#db/child-rows.ts";
import { tables } from "#db/select/tables.ts";

/** Delete a question and all related data in a single batch. Every
 * attendee_answers row carries question_id (choice and free-text alike, the
 * validate trigger enforces it), so the answers delete by it directly. The
 * answer→modifier link is a column on answers, so it goes with the rows. */
export const deleteQuestion = inOneBatch(
  removalWithChildren(tables.questions, [
    [tables.attendee_answers, "question_id"],
    [tables.answers, "question_id"],
    [tables.listing_questions, "question_id"],
  ]),
);

/** Delete an answer and all related attendee answers in a single batch. The
 * modifier_id link is a column on the answer row, so it goes with the
 * answer. */
export const deleteAnswer = inOneBatch(
  removalWithChildren(tables.answers, [[tables.attendee_answers, "answer_id"]]),
);
