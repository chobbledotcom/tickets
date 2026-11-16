/**
 * Deletion for questions and answers (and their dependent rows).
 */

import { removalWithChildren } from "#db/child-rows.ts";
import { executeBatch } from "#db/client.ts";
import { tables } from "#db/select/tables.ts";

/** Every attendee_answers row carries question_id (choice and free-text alike,
 * the validate trigger enforces it), so the answers delete by it directly. The
 * answer→modifier link is a column on answers, so it goes with the rows. */
const questionRemoval = removalWithChildren(tables.questions, [
  [tables.attendee_answers, "question_id"],
  [tables.answers, "question_id"],
  [tables.listing_questions, "question_id"],
]);

/** The modifier_id link is a column on the answer row, so it goes with the
 * answer. */
const answerRemoval = removalWithChildren(tables.answers, [
  [tables.attendee_answers, "answer_id"],
]);

/** Delete a question and all related data in a single batch. */
export const deleteQuestion = (id: number): Promise<void> =>
  executeBatch(questionRemoval(id));

/** Delete an answer and all related attendee answers in a single batch. */
export const deleteAnswer = (id: number): Promise<void> =>
  executeBatch(answerRemoval(id));
