/**
 * Deletion for questions and answers (and their dependent rows).
 */

import { executeBatch } from "#db/client.ts";
import { tables } from "#db/select/tables.ts";
import { deleteFrom } from "#db/write.ts";

/**
 * Delete a question and all related data in a single batch, child rows before
 * the question itself. Every attendee_answers row carries question_id (choice
 * and free-text alike, the validate trigger enforces it), so the answers delete
 * by it directly. The answer→modifier link is a column on answers, so it's
 * removed with the rows.
 */
export const deleteQuestion = async (id: number): Promise<void> => {
  await executeBatch([
    deleteFrom(tables.attendee_answers).where({ question_id: id }),
    deleteFrom(tables.answers).where({ question_id: id }),
    deleteFrom(tables.listing_questions).where({ question_id: id }),
    deleteFrom(tables.questions).where({ id }),
  ]);
};

/** Delete an answer and all related attendee answers in a single batch (its
 * modifier_id link is a column on the row, so it's removed with the answer). */
export const deleteAnswer = async (id: number): Promise<void> => {
  await executeBatch([
    deleteFrom(tables.attendee_answers).where({ answer_id: id }),
    deleteFrom(tables.answers).where({ id }),
  ]);
};
