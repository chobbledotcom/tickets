/**
 * Sort-order swaps and next-order assignment for questions and answers.
 */

import { nextSortOrder } from "#shared/db/client.ts";
import { assignNextSortOrder, swapSortOrder } from "#shared/db/query.ts";

/** Swap the sort_order of two answers by their ids, reading the current values
 * so callers only need the ids (like {@link swapQuestionOrder}). Serialises on
 * the write lock, so two concurrent reorders can't leave answers sharing a
 * sort_order. */
export const swapAnswerOrder = (
  answerId1: number,
  answerId2: number,
): Promise<void> => swapSortOrder("answers", answerId1, answerId2);

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
export const assignNextQuestionSortOrder = (
  questionId: number,
): Promise<void> => assignNextSortOrder("questions", questionId);
