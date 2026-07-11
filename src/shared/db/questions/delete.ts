/**
 * Deletion for questions and answers (and their dependent rows).
 */

import { deleteByFieldBatch } from "#shared/db/client.ts";

/** Delete a question and all related data in a single batch, child rows before
 * the question itself. Every attendee_answers row carries question_id (choice
 * and free-text alike, the validate trigger enforces it), so the answers delete
 * by it directly. The answer→modifier link is a column on answers, so it's
 * removed with the rows. */
export const deleteQuestion = (questionId: number): Promise<void> =>
  deleteByFieldBatch([
    { field: "question_id", table: "attendee_answers", value: questionId },
    { field: "question_id", table: "answers", value: questionId },
    { field: "question_id", table: "listing_questions", value: questionId },
    { field: "id", table: "questions", value: questionId },
  ]);

/** Delete an answer and all related attendee answers in a single batch (its
 * modifier_id link is a column on the row, so it's removed with the answer). */
export const deleteAnswer = (answerId: number): Promise<void> =>
  deleteByFieldBatch([
    { field: "answer_id", table: "attendee_answers", value: answerId },
    { field: "id", table: "answers", value: answerId },
  ]);
