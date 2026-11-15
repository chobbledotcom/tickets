/** Question fixtures for the tests that read both answer ids. */

import type { Answer, Question } from "#db/question-types.ts";
import {
  addAnswer,
  createQuestion,
} from "#test/shared/db/questions/helpers.ts";

/** A radio question with two answers, in the order given — the setup both the
 *  batch-retrieval and swap-order tests start from. */
export const createQuestionWithAnswerPair = async (
  text: string,
  [first, second]: readonly [first: string, second: string],
): Promise<{ a1: Answer; a2: Answer; q: Question }> => {
  const q = await createQuestion(text);
  const a1 = await addAnswer(q.id, 0, first);
  const a2 = await addAnswer(q.id, 1, second);
  return { a1, a2, q };
};
