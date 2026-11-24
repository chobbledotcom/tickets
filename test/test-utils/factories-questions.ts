import type { Answer, QuestionWithAnswers } from "#db/question-types.ts";

/* jscpd:ignore-start -- static data, not code */
const ANSWER_DEFAULTS: Answer = {
  active: true,
  id: 10,
  questionId: 1,
  sortOrder: 0,
  text: "A",
};

const QUESTION_DEFAULTS: Omit<QuestionWithAnswers, "answers"> = {
  answerLevel: "booking",
  assignAll: false,
  displayType: "radio",
  id: 1,
  text: "Question?",
};
/* jscpd:ignore-end */

/** Factory for an {@link Answer}: `active` defaults to `true`; the ids
 *  mirror one question (id 1) with answers 10, 11, … in sort order. */
export const testAnswer = (overrides: Partial<Answer> = {}): Answer => ({
  ...ANSWER_DEFAULTS,
  ...overrides,
});

/** Factory for a {@link QuestionWithAnswers}: `displayType` defaults to
 *  `"radio"` with no answers, so a radio/dropdown/free-text question is built by
 *  overriding `displayType` and passing `answers`. The returned type keeps
 *  `displayType` as the literal {@link QuestionDisplayType}, so callers need no
 *  `… as const`. */
export const testQuestion = (
  overrides: Partial<QuestionWithAnswers> = {},
): QuestionWithAnswers => ({
  ...QUESTION_DEFAULTS,
  answers: [],
  ...overrides,
});

/** Build a radio question fixture with answer options. Each `[id, text]` pair
 * becomes an active answer whose sort order follows the array order. */
export const testRadioQuestion = (
  id: number,
  text: string,
  answers: [number, string][],
): QuestionWithAnswers =>
  testQuestion({
    answers: answers.map(([answerId, answerText], sortOrder) =>
      testAnswer({ id: answerId, questionId: id, sortOrder, text: answerText }),
    ),
    id,
    text,
  });
