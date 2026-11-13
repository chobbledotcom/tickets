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
import {
  type QuestionInput,
  questionsOrder,
  questionsTable,
} from "#db/questions/tables.ts";
import { t } from "#i18n";
import { ADMIN_API_RESOURCES } from "#shared/admin-api-resources.ts";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import {
  defineRecord,
  type RecordShapeOf,
  recordHead,
} from "#shared/rest/record.ts";
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
 *  conversion that can orphan the stored answers. A free-text question
 *  stays free-text. A choice question switches only between radio and
 *  select. */
export const questionRule = (
  input: QuestionInput,
  stored: Question | null,
): Result<QuestionInput> => {
  const capped = questionTextCap(input.text);
  if (!capped.ok) return capped;
  if (stored === null) return okResult({ ...input, text: capped.value });
  const displayType =
    stored.display_type === "free_text" || input.displayType === "free_text"
      ? stored.display_type
      : requireQuestionDisplayType(input.displayType);
  return okResult({ ...input, displayType, text: capped.value });
};

export const questionRecord = defineRecord<
  RecordShapeOf<Question, QuestionInput, QuestionWithAnswers>
>({
  ...recordHead(
    "Question",
    ADMIN_API_RESOURCES.questions,
    "questionDelete",
    "questions",
  ),
  logName: (input) => input.text,
  nameField: "text",
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
  table: questionsTable,
});
