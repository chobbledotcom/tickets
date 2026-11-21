/**
 * The question record: its table, its one write rule, and its admin surface.
 * Its answers are the child surface the pages and the JSON API both address.
 */

import {
  type Question,
  type QuestionWithAnswers,
  requireQuestionDisplayType,
} from "#db/question-types.ts";
import { deleteQuestion } from "#db/questions/delete.ts";
import {
  getAllQuestionsWithAnswers,
  getQuestionWithAnswers,
  getQuestionWithAnswersOnPrimary,
} from "#db/questions/queries.ts";
import { type QuestionInput, questionsOrder } from "#db/questions/tables.ts";
import { tables } from "#db/select/tables.ts";
import { t } from "#i18n";
import { ADMIN_API_RESOURCES } from "#shared/admin-api-resources.ts";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import { defineRecord, type RecordShapeOf } from "#shared/rest/record.ts";
import { errorResult, okResult, type Result } from "#shared/result.ts";

/** The form's length refusal for one question text. */
const questionTextCap = (text: string): Result<string> =>
  text.length > MAX_TEXTAREA_LENGTH
    ? errorResult(
        t("fields.validation.max_length", {
          label: t("questions.name_label"),
          max: MAX_TEXTAREA_LENGTH,
        }),
      )
    : okResult(text);

/** The one question rule: a text the form can hold, and no display-type
 *  conversion that can orphan the stored answers. The answer level is set
 *  once, on create, and only for a free-text question. A free-text question
 *  stays free-text. A choice question switches only between radio and
 *  select. */
export const questionRule = (
  input: QuestionInput,
  stored: Question | null,
): Result<QuestionInput> => {
  const capped = questionTextCap(input.text);
  if (!capped.ok) return capped;
  if (stored === null) {
    // Only a free-text question can ask more than once for a booking.
    const answerLevel =
      input.displayType === "free_text"
        ? (input.answerLevel ?? "booking")
        : "booking";
    return okResult({ ...input, answerLevel, text: capped.value });
  }
  if (
    input.answerLevel !== undefined &&
    input.answerLevel !== stored.answerLevel
  ) {
    return errorResult(t("questions.answer_level.locked"));
  }
  const displayType =
    stored.displayType === "free_text" || input.displayType === "free_text"
      ? stored.displayType
      : requireQuestionDisplayType(input.displayType);
  return okResult({
    ...input,
    answerLevel: stored.answerLevel,
    displayType,
    text: capped.value,
  });
};

export const questionRecord = defineRecord<
  RecordShapeOf<Question, QuestionInput, QuestionWithAnswers>
>()({
  activityName: "Question",
  api: ADMIN_API_RESOURCES.questions,
  logName: (input) => input.text,
  nameField: "text",
  nameLabel: "questions.name_label",
  nameOf: (question) => question.text,
  onDelete: (id) => deleteQuestion(id),
  order: questionsOrder,
  reads: {
    all: getAllQuestionsWithAnswers,
    one: getQuestionWithAnswers,
    onePrimary: getQuestionWithAnswersOnPrimary,
  },
  rule: questionRule,
  saveLanding: "question",
  surface: "questions",
  table: tables.questions,
});
