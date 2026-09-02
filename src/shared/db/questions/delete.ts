/**
 * Deletion for questions and answers (and their dependent rows).
 */

import { deleteWithChildren } from "#db/client.ts";

/** Delete a question and all related data in a single batch, child rows before
 * the question itself. Every attendee_answers row carries question_id (choice
 * and free-text alike, the validate trigger enforces it), so the answers delete
 * by it directly. The answer→modifier link is a column on answers, so it's
 * removed with the rows. */
export const deleteQuestion = deleteWithChildren("questions", [
  { field: "question_id", table: "attendee_answers" },
  { field: "question_id", table: "answers" },
  { field: "question_id", table: "listing_questions" },
]);

/** Delete an answer and all related attendee answers in a single batch (its
 * modifier_id link is a column on the row, so it's removed with the answer). */
export const deleteAnswer = deleteWithChildren("answers", [
  { field: "answer_id", table: "attendee_answers" },
]);
