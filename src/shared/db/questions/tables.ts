/**
 * The write input and the orders of custom questions and their answers. The
 * `listing_questions` link table is declared in `questions/queries.ts`, beside
 * the membership joins that consume it.
 */

import { defineOrderedCollection } from "#db/ordered-collection.ts";
import type { QuestionDisplayType } from "#db/question-types.ts";

/** The writable fields one question row write carries. The `sort_order`
 * column is not one of them: only the ordered-row helpers write it, so a
 * generic write cannot break the order. */
export type QuestionInput = {
  assignAll?: boolean;
  displayType: QuestionDisplayType;
  text: string;
};

export const questionsOrder = defineOrderedCollection({
  key: "id",
  start: 1,
  table: "questions",
});

export const answersOrder = defineOrderedCollection({
  key: "id",
  scope: "question_id",
  table: "answers",
});
