/**
 * Sort-order swaps and next-order assignment for questions and answers.
 */

import { executeBatch, nextSortOrder } from "#shared/db/client.ts";
import { swapSortOrder } from "#shared/db/query.ts";

/** Swap the sort_order of two answers by their IDs */
export const swapAnswerOrder = async (
  answerId1: number,
  sortOrder1: number,
  answerId2: number,
  sortOrder2: number,
): Promise<void> => {
  await executeBatch([
    {
      args: [sortOrder2, answerId1],
      sql: "UPDATE answers SET sort_order = ? WHERE id = ?",
    },
    {
      args: [sortOrder1, answerId2],
      sql: "UPDATE answers SET sort_order = ? WHERE id = ?",
    },
  ]);
};

/** Get the next sort_order for a new answer in a question */
export const getNextAnswerSortOrder = (questionId: number): Promise<number> =>
  nextSortOrder("answers", "question_id", questionId);

/** Swap the global sort_order of two questions, reading their current values
 * so callers only need the ids. A no-op visually when both share a value
 * (e.g. legacy rows still at 0 before the id backfill). Callers pass two
 * existing question ids (the move handler takes them from the rendered list). */
export const swapQuestionOrder = (
  questionId1: number,
  questionId2: number,
): Promise<void> => swapSortOrder("questions", questionId1, questionId2);

/** Assign a freshly-created question the next global sort_order (max + 1).
 * Always >= 1 so new questions never collide with the one-time id-backfill of
 * legacy rows, which only seeds rows still at sort_order 0. */
export const assignNextQuestionSortOrder = async (
  questionId: number,
): Promise<void> => {
  await executeBatch([
    {
      args: [questionId, questionId],
      sql: `UPDATE questions
            SET sort_order = COALESCE(
              (SELECT MAX(sort_order) FROM questions WHERE id != ?), 0
            ) + 1
            WHERE id = ?`,
    },
  ]);
};
