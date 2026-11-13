import type {
  Answer,
  Question,
  QuestionWithAnswers,
} from "#db/question-types.ts";
import {
  getAnswerSelectionTotals,
  getAnswerSelectionTotalsOnPrimary,
} from "#db/questions/aggregates.ts";
import { getQuestionBookings } from "#db/questions/attendee-answers/bookings.ts";
import {
  getQuestionWithAnswers,
  getQuestionWithAnswersOnPrimary,
  requireQuestionWithAnswersOnPrimary,
} from "#db/questions/queries.ts";
import type { QuestionInput } from "#db/questions/tables.ts";

import { requiredMapValue } from "#fp";
import { t } from "#i18n";
import { apiErrorResponse } from "#routes/api/cors.ts";
import { jsonResponse } from "#routes/response.ts";
import type { RouteHandlerFn } from "#routes/router.ts";
import type {
  ADMIN_API_RESOURCES,
  AdminApiCreateQuestionBody,
  AdminApiUpdateQuestionBody,
} from "#shared/admin-api-resources.ts";
import { MAX_INPUT_LENGTH } from "#shared/limits.ts";
import { questionRecord } from "#shared/records/questions.ts";
import {
  childTextHandlers,
  recordChildSurface,
} from "#shared/rest/child-surface.ts";
import type { HydratedRows } from "#shared/rest/crud-api-types.ts";
import {
  type RequiredTextReader,
  withApiEntity,
  withRequiredText,
} from "#shared/rest/crud-parsers.ts";
import type { RecordShapeOf } from "#shared/rest/record.ts";
import { recordApi, recordJsonPolicy } from "#shared/rest/record-api.ts";
import { errorResult, okResult, type Result } from "#shared/result.ts";
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";
import {
  addAnswerWithLog,
  deleteAnswerWithLog,
  updateAnswerWithLog,
} from "./questions/answers.ts";

// The bodies a question and an answer write accept are the table's
// CreateQuestionBodySchema / UpdateQuestionBodySchema / OptionBodySchema.
// DELETE /api/admin/questions/:questionId and
// DELETE /api/admin/questions/:questionId/answers/:answerId take the shared
// DeleteBody the crud-parsers module exports.

/** The create mapping. The schema proves the text and the display type. The
 *  record's rule applies the form's cap and the type rules. */
const createQuestionInput = (
  body: AdminApiCreateQuestionBody,
): Result<QuestionInput> =>
  okResult({
    assignAll: body.assign_all ?? false,
    displayType: body.display_type,
    text: body.text,
  });

/** The update mapping. An absent field keeps the stored one. The record's
 *  rule refuses a type conversion that can orphan existing answers. */
const updateQuestionInput = (
  body: AdminApiUpdateQuestionBody,
  existing: QuestionWithAnswers,
): Result<QuestionInput> => {
  const text = (body.text ?? existing.text).trim();
  if (text === "") return errorResult("text cannot be empty");
  return okResult({
    assignAll: body.assign_all ?? existing.assign_all,
    displayType: body.display_type ?? existing.display_type,
    text,
  });
};

/** The answer write routes' parent-and-child gate. The importer creates a
 *  question and immediately posts its first answer, so the parent read pins
 *  to the primary. A lagging replica must not 404 the row the create just
 *  made. */
const answerSurface = recordChildSurface<QuestionWithAnswers, Answer>(
  questionRecord,
  "questionId",
  "Question",
  "answerId",
  "Answer",
  getQuestionWithAnswersOnPrimary,
  (question) => question.answers,
);

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

/** Every answer row the API answers with carries its selection total, the
 *  "Times selected" count the question page shows. One query covers the whole
 *  question list, so a list response costs no extra read per question. */
const hydrateAnswerStatsWith =
  (totals: (questionIds: number[]) => Promise<Map<number, number>>) =>
  async (questions: QuestionWithAnswers[]): Promise<HydratedRows> => {
    const answered = questions.filter(
      (question) => question.answers.length > 0,
    );
    const byAnswer = await totals(answered.map((question) => question.id));
    return new Map(
      answered.map((question) => [
        question.id,
        {
          answers: question.answers.map((answer) => ({
            ...answer,
            times_selected: requiredMapValue(
              byAnswer,
              answer.id,
              `Missing selection total for answer ${answer.id}`,
            ),
          })),
        },
      ]),
    );
  };

/** The read routes' totals: the question row came from the replica, so the
 *  replica serves its answers' totals too. */
const hydrateAnswerStats = hydrateAnswerStatsWith(getAnswerSelectionTotals);

/** The write responses' totals, read from the primary: a replica can miss the
 *  answer the write just made, and a missing total throws. */
const hydrateAnswerStatsAfterWrite = hydrateAnswerStatsWith(
  getAnswerSelectionTotalsOnPrimary,
);

/** The write response: the written question re-read from the primary, carrying
 *  each answer's selection total exactly as the standard read routes do. */
const questionResponse = async (
  id: number,
  status?: number,
): Promise<Response> => {
  const question = await requireQuestionWithAnswersOnPrimary(id);
  return jsonResponse(
    {
      question: {
        ...question,
        ...(await hydrateAnswerStatsAfterWrite([question])).get(question.id),
      },
    },
    status,
  );
};

/* jscpd:ignore-start -- declarative child-route config, one per record */
const answerHandlers = childTextHandlers({
  create: async (question, text) => {
    // Free-text questions collect a typed value, never an answer id, so
    // the request is refused with the same message the HTML form answers.
    if (question.display_type === "free_text") {
      return apiErrorResponse(t("questions.answers.free_text_no_options"));
    }
    await addAnswerWithLog(question.id, text);
    return questionResponse(question.id, 201);
  },
  destroy: (question, answer) => deleteAnswerWithLog(question, answer),
  label: "Answer text",
  reader: withAnswerText,
  surface: answerSurface,
  textOf: (answer) => answer.text,
  update: async (question, answer, text) => {
    await updateAnswerWithLog(question, answer, { text });
    return questionResponse(question.id);
  },
});
/* jscpd:ignore-end */

/** GET /api/admin/questions/:questionId/bookings — the bookings that answered
 *  the question, newest first. Owner-only, like the question pages. Free text
 *  is decrypted with the owner's key, so the answer holds the buyer's words. */
const handleQuestionBookings: RouteHandlerFn = (request, params) =>
  withApiEntity(
    request,
    getQuestionWithAnswers,
    params.questionId as number,
    "Question",
    async (question) =>
      jsonResponse({
        bookings: await getQuestionBookings(
          question.id,
          await requireRequestPrivateKey(),
        ),
      }),
    recordJsonPolicy(questionRecord),
  );

export const questionApiRoutes = recordApi<
  typeof ADMIN_API_RESOURCES.questions,
  RecordShapeOf<Question, QuestionInput, QuestionWithAnswers>
>(questionRecord, {
  childHandlers: { answers: answerHandlers },
  customHandlers: { bookings: handleQuestionBookings },
  hydrate: hydrateAnswerStats,
  hydrateAfterWrite: hydrateAnswerStatsAfterWrite,
  toCreateInput: createQuestionInput,
  toUpdateInput: updateQuestionInput,
});
