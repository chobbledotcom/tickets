import {
  isQuestionDisplayType,
  type Question,
  type QuestionDisplayType,
  type QuestionWithAnswers,
  questionDisplayTypeError,
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

/* jscpd:ignore-start */
import { t } from "#i18n";
import { apiErrorResponse } from "#routes/api/cors.ts";
import { OWNER_API } from "#routes/auth.ts";
import { reReadResponse } from "#routes/response.ts";
import type { RouteHandlerFn } from "#routes/router.ts";
import { ADMIN_API_RESOURCES } from "#shared/admin-api-resources.ts";
import { MAX_INPUT_LENGTH, MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import { apiChildSurface } from "#shared/rest/child-surface.ts";
import { defineCrudApi } from "#shared/rest/crud-api.ts";
import {
  optionalBoolean,
  type RequiredTextReader,
  requireEntityField,
  withRequiredText,
} from "#shared/rest/crud-parsers.ts";
import { appendOnCreate } from "#shared/rest/crud-side-effects.ts";
import { errorResult, okResult, type Result } from "#shared/result.ts";
import {
  addAnswerWithLog,
  deleteAnswerWithLog,
  updateAnswerWithLog,
} from "./questions/answers.ts";

/* jscpd:ignore-end */

// The bodies a question and an answer write accept are the table's
// CreateQuestionBodySchema / UpdateQuestionBodySchema / OptionBodySchema.
// DELETE /api/admin/questions/:questionId and
// DELETE /api/admin/questions/:questionId/answers/:answerId take the shared
// DeleteBody the crud-parsers module exports.

/** The question text's read: a supplied non-string is refused with the
 *  field-named message, and an update without one keeps the stored text. A
 *  value past the form's textarea cap gets the form's own refusal. */
const questionText = (
  body: Record<string, unknown>,
  existing: string | null,
): Result<string> => {
  const text = requireEntityField(body, "text", existing);
  if (!text.ok) return text;
  if (text.value.length > MAX_TEXTAREA_LENGTH) {
    return errorResult(
      t("fields.validation.max_length", {
        label: t("questions.name_label"),
        max: MAX_TEXTAREA_LENGTH,
      }),
    );
  }
  return text;
};

/** The display type a create requires: one of the three types the form's
 *  selector offers. A missing key answers "required". Anything else that is
 *  not one of the three answers the form's own type refusal. */
const requiredDisplayType = (
  body: Record<string, unknown>,
): Result<QuestionDisplayType> => {
  const raw = body.display_type;
  if (raw === undefined) return errorResult("display_type is required");
  if (typeof raw !== "string" || !isQuestionDisplayType(raw)) {
    return errorResult(questionDisplayTypeError);
  }
  return okResult(raw);
};

/** The display type an update applies: absent keeps the stored one. A type
 *  conversion orphans existing answers, so it is not allowed — the same rule
 *  the edit form runs. A free-text question stays free-text, and a choice
 *  question can switch only between radio and select. */
const updateDisplayType = (
  body: Record<string, unknown>,
  existing: QuestionWithAnswers,
): Result<QuestionDisplayType> => {
  if (body.display_type === undefined) return okResult(existing.display_type);
  const requested = requiredDisplayType(body);
  if (!requested.ok) return requested;
  return okResult(
    existing.display_type === "free_text" || requested.value === "free_text"
      ? existing.display_type
      : requested.value,
  );
};

/** The shared input mapping for a question create or update: the same
 *  fields, the same rules and the same messages as the question form. */
const toQuestionInput = (
  body: Record<string, unknown>,
  existing: QuestionWithAnswers | null,
): Result<QuestionInput> => {
  const text = questionText(body, existing?.text ?? null);
  if (!text.ok) return text;
  const displayType =
    existing === null
      ? requiredDisplayType(body)
      : updateDisplayType(body, existing);
  if (!displayType.ok) return displayType;
  const assign = optionalBoolean(
    body,
    "assign_all",
    existing?.assign_all ?? false,
  );
  if (!assign.ok) return assign;
  return okResult({
    assignAll: assign.value,
    displayType: displayType.value,
    text: text.value,
  });
};

/** The answer write routes' parent-and-child gate. The importer creates a
 *  question and immediately posts its first answer, so the parent read pins
 *  to the primary. A lagging replica must not 404 the row the create just
 *  made. */
const answerSurface = apiChildSurface({
  childIdParam: "answerId",
  childLabel: "Answer",
  childrenOf: (question: QuestionWithAnswers) => question.answers,
  lookup: getQuestionWithAnswersOnPrimary,
  parentIdParam: "questionId",
  parentLabel: "Question",
  policy: OWNER_API,
});

/** The answer write's text read: the shared required-text rule, then the
 *  form's input cap with the form's own words. */
const withAnswerText: RequiredTextReader = (body, run) =>
  withRequiredText(body, (text) => {
    const cap = answerTextCap(text);
    return cap === null ? run(text) : Promise.resolve(cap);
  });

/** The answer text's cap refusal: the form's own words for its own cap. */
const answerTextCap = (text: string): Response | null =>
  text.length > MAX_INPUT_LENGTH
    ? apiErrorResponse(
        t("fields.validation.max_length", {
          label: t("questions.answer_label"),
          max: MAX_INPUT_LENGTH,
        }),
      )
    : null;

/** The write response: the written question re-read from the primary. */
const questionResponse = reReadResponse(
  "question",
  getQuestionWithAnswersOnPrimary,
);

/** POST /api/admin/questions/:questionId/answers */
const handleAnswerCreate: RouteHandlerFn = (request, params) =>
  answerSurface.parent(request, params, (question, body) =>
    withAnswerText(body, async (text) => {
      // Free-text questions collect a typed value, never an answer id, so
      // the request is refused with the same message the HTML form answers.
      if (question.display_type === "free_text") {
        return apiErrorResponse(t("questions.answers.free_text_no_options"));
      }
      await addAnswerWithLog(question.id, text);
      return questionResponse(question.id, 201);
    }),
  );

/** PUT /api/admin/questions/:questionId/answers/:answerId */
const handleAnswerUpdate = answerSurface.textUpdate(
  withAnswerText,
  async (question, answer, text) => {
    await updateAnswerWithLog(question, answer, { text });
    return questionResponse(question.id);
  },
);

/** DELETE /api/admin/questions/:questionId/answers/:answerId */
const handleAnswerDelete = answerSurface.confirmedDelete(
  (answer) => answer.text,
  "Answer text",
  (question, answer) => deleteAnswerWithLog(question, answer),
);

export const questionApiRoutes = defineCrudApi<
  typeof ADMIN_API_RESOURCES.questions,
  Question,
  QuestionInput,
  QuestionWithAnswers,
  boolean
>(ADMIN_API_RESOURCES.questions, {
  childHandlers: {
    answers: {
      create: handleAnswerCreate,
      delete: handleAnswerDelete,
      update: handleAnswerUpdate,
    },
  },
  getAll: getAllQuestionsWithAnswers,
  lookup: getQuestionWithAnswers,
  // Read-your-writes: the create/update response re-reads the row and its
  // answers from the primary. A lagging replica cannot answer without the
  // row the write just made.
  lookupAfterWrite: getQuestionWithAnswersOnPrimary,
  nameField: "text",
  onDelete: (id) => deleteQuestion(Number(id)),
  policy: OWNER_API,
  sideEffect: appendOnCreate(questionsOrder),
  table: questionsTable,
  toCreateInput: (body) => toQuestionInput(body, null),
  toUpdateInput: toQuestionInput,
});
