/**
 * The write input and the orders of custom questions and their answers. The
 * `listing_questions` link table is declared in `questions/queries.ts`, beside
 * the membership joins that consume it.
 */

import { listWithChildOrders } from "#db/ordered-collection.ts";
import type {
  QuestionAnswerLevel,
  QuestionDisplayType,
} from "#db/question-types.ts";

/** The writable fields one question row write carries. The `sort_order`
 * column is not one of them: only the ordered-row helpers write it, so a
 * generic write cannot break the order. */
export type QuestionInput = {
  answerLevel?: QuestionAnswerLevel | undefined;
  assignAll?: boolean;
  displayType: QuestionDisplayType;
  text: string;
};

export const { children: answersOrder, list: questionsOrder } =
  listWithChildOrders("questions", "answers", "question_id");
