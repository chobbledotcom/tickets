/**
 * Admin routes for custom questions management (owner-only)
 */

import { logActivity } from "#db/activity-log.ts";
import { getAllModifiers } from "#db/modifiers.ts";
import {
  insertScopedOrderedRow,
  scopedCollectionSwap,
} from "#db/ordered-collection.ts";
import type { Answer, QuestionWithAnswers } from "#db/question-types.ts";
import {
  ANSWER_AGGREGATE_FIELDS,
  type AnswerAggregateValues,
  answerAggregates,
  getAnswerAggregateRecalculation,
  getAnswerModifierId,
  setAnswerModifier,
} from "#db/questions/aggregates.ts";
import { deleteAnswer } from "#db/questions/delete.ts";
import { findAnswerById } from "#db/questions/parsing.ts";
import { getQuestionWithAnswers } from "#db/questions/queries.ts";
import { answersOrder, answersTable } from "#db/questions/tables.ts";
import { t } from "#i18n";
import {
  createRecalculatePageRenderer,
  parseEditableAggregateForm,
  runRecalculatePost,
} from "#routes/admin/aggregate-recalculation.ts";
import { createVerifiedFormRoute } from "#routes/admin/confirmation.ts";
import { formGuard, OWNER_FORM, requireOwnerOr } from "#routes/auth.ts";
import { createEntityHandler, throughParent } from "#routes/entity.ts";
/* jscpd:ignore-start */
import {
  errorRedirect,
  htmlResponse,
  notFoundResponse,
  redirect,
} from "#routes/response.ts";
import {
  createAuthedFormRoute,
  createOrderedCollectionHandlers,
} from "#shared/app-forms.ts";
import { getFlash } from "#shared/flash-context.ts";
import type { ParamsRoute, ResponseHandler } from "#shared/response-steps.ts";
import {
  type AnswerModifierOption,
  adminAnswerDeletePage,
  adminAnswerEditPage,
  adminAnswerRecalculatePage,
} from "#templates/admin/questions.tsx";
import { getAnswerAggregateFields } from "#templates/fields/aggregate.ts";
import type { AdminSession } from "#types";
import { answerTextForm } from "./forms.ts";

/* jscpd:ignore-end */

export type QuestionIdParams = { id: number };

export const redirectToQuestion = (args: {
  error: string;
  params: QuestionIdParams;
}): Response => errorRedirect(`/admin/questions/${args.params.id}`, args.error);

/** Handle POST /admin/questions/:id/answers (add answer) */
export const handleAddAnswer: ParamsRoute<QuestionIdParams> =
  createAuthedFormRoute<{ text: string }, QuestionIdParams>({
    auth: OWNER_FORM,
    form: answerTextForm,
    onInvalid: redirectToQuestion,
    onValid: async ({ params, values: { text } }) => {
      const question = await getQuestionWithAnswers(params.id);
      if (!question) return notFoundResponse();
      // Free-text questions collect a typed value, never an answer id, so answer
      // options (and any answer-triggered modifiers) would be silently ignored.
      if (question.display_type === "free_text") {
        return errorRedirect(
          `/admin/questions/${params.id}`,
          t("questions.answers.free_text_no_options"),
        );
      }
      // One transaction: an answer must never exist without its place in the
      // order or its log line. The inserted sortOrder is a placeholder the
      // append overwrites before anything can read it.
      await addAnswerRow(
        params.id,
        { questionId: params.id, sortOrder: 0, text },
        (transaction) =>
          logActivity(
            `Answer '${text}' added to question ${params.id}`,
            undefined,
            undefined,
            transaction,
          ),
      );
      return redirect(`/admin/questions/${params.id}`, "Answer added", true);
    },
  });

/** Insert an answer and place it in its question's order, atomically. */
const addAnswerRow = insertScopedOrderedRow(answersTable, answersOrder);

type AnswerRouteParams = { id: number; answerId: number };
type AnswerContext = { question: QuestionWithAnswers; answer: Answer };

const loadQuestionAndAnswer = ({ id, answerId }: AnswerRouteParams) =>
  throughParent(getQuestionWithAnswers(id), (question) => {
    const answer = findAnswerById(question, answerId);
    return answer ? { answer, question } : null;
  });

const answerEntityHandler = createEntityHandler<
  AnswerRouteParams,
  AnswerContext
>(loadQuestionAndAnswer);
const answerHandlers = {
  get: answerEntityHandler(requireOwnerOr),
  post: answerEntityHandler(formGuard(OWNER_FORM)),
};

/** Owner GET route for an answer-scoped page that shows the current flash. */
const answerFlashRoute = (
  render: ResponseHandler<
    [
      question: QuestionWithAnswers,
      answer: Answer,
      session: AdminSession,
      flash: ReturnType<typeof getFlash>,
    ]
  >,
): ParamsRoute<AnswerRouteParams> =>
  answerHandlers.get(({ answer, question }, session) =>
    render(question, answer, session, getFlash()),
  );

/** Handle GET /admin/questions/:id/answers/:answerId/delete */
export const handleDeleteAnswerGet: ParamsRoute<AnswerRouteParams> =
  answerFlashRoute((question, answer, session, flash) =>
    htmlResponse(adminAnswerDeletePage(question, answer, session, flash.error)),
  );

/** Handle POST /admin/questions/:id/answers/:answerId/delete */
export const handleDeleteAnswerPost: ParamsRoute<AnswerRouteParams> =
  createVerifiedFormRoute<AnswerRouteParams, AnswerContext>({
    actionLabel: "deletion",
    auth: OWNER_FORM,
    identifier: ({ answer }) => answer.text,
    identifierLabel: "Answer text",
    loadContext: loadQuestionAndAnswer,
    mismatchRedirect: (_, { id, answerId }) =>
      `/admin/questions/${id}/answers/${answerId}/delete`,
    onConfirm: async ({ context: { answer, question } }) => {
      await deleteAnswer(answer.id);
      await logActivity(
        `Answer '${answer.text}' deleted from question ${question.id}`,
      );
      return redirect(
        `/admin/questions/${question.id}`,
        "Answer deleted",
        true,
      );
    },
  });

/** The "answer"-trigger modifiers an answer can be linked to, as the lightweight
 * {id, name} options the edit page's selector renders. Only "answer"-triggered
 * modifiers apply when a buyer picks an answer, so the others are filtered out. */
const answerTriggerModifiers = async (): Promise<AnswerModifierOption[]> =>
  (await getAllModifiers())
    .filter((m) => m.trigger === "answer")
    .map((m) => ({ id: m.id, name: m.name }));

const editAnswerPath = ({ id, answerId }: AnswerRouteParams): string =>
  `/admin/questions/${id}/answers/${answerId}/edit`;

/** Handle GET /admin/questions/:id/answers/:answerId/edit */
export const handleEditAnswerGet: ParamsRoute<AnswerRouteParams> =
  answerFlashRoute(async (question, answer, session, flash) => {
    const [aggregateRecalculation, modifiers, modifierId] = await Promise.all([
      getAnswerAggregateRecalculation(answer.id),
      answerTriggerModifiers(),
      getAnswerModifierId(answer.id),
    ]);
    return htmlResponse(
      adminAnswerEditPage(
        question,
        answer,
        session,
        flash.error,
        aggregateRecalculation,
        modifiers,
        modifierId,
      ),
    );
  });

/** Map the validated aggregate form values onto the stored aggregate columns. */
const extractAnswerAggregateValues = (
  values: AnswerAggregateValues,
): AnswerAggregateValues => ({
  times_selected: values.times_selected,
});

/** Handle POST /admin/questions/:id/answers/:answerId/edit (text + modifier) */
export const handleEditAnswerPost: ParamsRoute<AnswerRouteParams> =
  createAuthedFormRoute<{ text: string }, AnswerRouteParams, AnswerContext>({
    auth: OWNER_FORM,
    form: answerTextForm,
    loadContext: loadQuestionAndAnswer,
    onInvalid: ({ error, params }) =>
      errorRedirect(editAnswerPath(params), error),
    onValid: async ({
      context: { answer, question },
      form,
      params,
      values: { text },
    }) => {
      const raw = form.getString("modifier_id");
      const modifierId = raw ? Number.parseInt(raw, 10) : null;
      if (
        modifierId !== null &&
        !(await answerTriggerModifiers()).some((m) => m.id === modifierId)
      ) {
        return errorRedirect(editAnswerPath(params), "Invalid modifier");
      }
      const aggregates = parseEditableAggregateForm<
        AnswerAggregateValues,
        AnswerAggregateValues
      >(form, getAnswerAggregateFields(), extractAnswerAggregateValues);
      if (!aggregates.ok) {
        return errorRedirect(editAnswerPath(params), aggregates.error);
      }
      await answersTable.update(answer.id, {
        active: form.get("active") === "on",
        text,
      });
      await setAnswerModifier(answer.id, modifierId);
      if (aggregates.input) {
        await answerAggregates.update(answer.id, aggregates.input);
      }
      await logActivity(`Answer '${text}' updated in question ${question.id}`);
      return redirect(
        `/admin/questions/${question.id}`,
        "Answer updated",
        true,
      );
    },
  });

/** Render the answer running-total recalculation page from the current,
 * freshly-snapshotted stored vs attendee-answer values. */
const renderAnswerRecalculatePage = createRecalculatePageRenderer(
  ({ answer }: AnswerContext) => getAnswerAggregateRecalculation(answer.id),
  ({ answer, question }, snapshot, session: AdminSession, error, success) =>
    adminAnswerRecalculatePage(
      question,
      answer,
      snapshot,
      session,
      error,
      success,
    ),
);

/** Handle GET /admin/questions/:id/answers/:answerId/recalculate */
export const handleAnswerRecalculateGet: ParamsRoute<AnswerRouteParams> =
  answerFlashRoute((question, answer, session, flash) =>
    renderAnswerRecalculatePage(
      { answer, question },
      session,
      flash.error,
      flash.success,
    ),
  );

/** Handle POST /admin/questions/:id/answers/:answerId/recalculate */
export const handleAnswerRecalculatePost: ParamsRoute<AnswerRouteParams> =
  answerHandlers.post(({ answer, question }, session, form, _request, params) =>
    runRecalculatePost({
      fields: ANSWER_AGGREGATE_FIELDS,
      form,
      log: () =>
        logActivity(
          `Answer '${answer.text}' selection total recalculated in question ${question.id}`,
        ),
      renderChoose: () =>
        renderAnswerRecalculatePage(
          { answer, question },
          session,
          t("questions.recalculate.choose"),
        ),
      reset: (selected) => answerAggregates.reset(answer.id, selected),
      successMessage: t("questions.recalculate.success"),
      successPath: editAnswerPath(params),
    }),
  );

export const answerOrder: {
  down: ParamsRoute<AnswerRouteParams>;
  up: ParamsRoute<AnswerRouteParams>;
} = createOrderedCollectionHandlers({
  auth: OWNER_FORM,
  keys: ({ context }) => context.question.answers.map((answer) => answer.id),
  loadContext: loadQuestionAndAnswer,
  movedMessage: "Answer moved",
  redirectPath: ({ context }) => `/admin/questions/${context.question.id}`,
  swap: scopedCollectionSwap(
    answersOrder,
    ({ context }: { context: AnswerContext }) => context.question.id,
  ),
  target: ({ context }) => context.answer.id,
});
