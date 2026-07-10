/**
 * Deletion for questions and answers (and their dependent rows).
 */

import { executeBatch } from "#shared/db/client.ts";

/** Delete a question and all related data in a single batch. Every
 * attendee_answers row carries question_id (choice and free-text alike, the
 * validate trigger enforces it), so the answers delete by it directly. The
 * answer→modifier link is a column on answers, so it's removed with the rows. */
export const deleteQuestion = async (questionId: number): Promise<void> => {
  await executeBatch([
    {
      args: [questionId],
      sql: "DELETE FROM attendee_answers WHERE question_id = ?",
    },
    { args: [questionId], sql: "DELETE FROM answers WHERE question_id = ?" },
    {
      args: [questionId],
      sql: "DELETE FROM listing_questions WHERE question_id = ?",
    },
    { args: [questionId], sql: "DELETE FROM questions WHERE id = ?" },
  ]);
};

/** Delete an answer and all related attendee answers in a single batch (its
 * modifier_id link is a column on the row, so it's removed with the answer). */
export const deleteAnswer = async (answerId: number): Promise<void> => {
  await executeBatch([
    {
      args: [answerId],
      sql: "DELETE FROM attendee_answers WHERE answer_id = ?",
    },
    { args: [answerId], sql: "DELETE FROM answers WHERE id = ?" },
  ]);
};
