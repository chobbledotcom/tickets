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
import {
  createVerifiedFormRoute,
  verifiedDelete,
} from "#routes/admin/confirmation.ts";
import { orderRoutes } from "#routes/admin/route-tables.ts";
import { formGuard, formPolicyFor, pageGuardFor } from "#routes/auth.ts";
import { createEntityHandler, throughParent } from "#routes/entity.ts";
import {
  errorRedirect,
  htmlResponse,
  notFoundResponse,
  redirect,
  redirectToDetail,
} from "#routes/response.ts";
import { adminDestinationAt } from "#shared/admin-surface.ts";
import {
  createAuthedFormRoute,
  createOrderedCollectionHandlers,
} from "#shared/app-forms.ts";
import { getFlash } from "#shared/flash-context.ts";
import type { ParamsRoute, ResponseHandler } from "#shared/response-steps.ts";
import { parsePositiveInt } from "#shared/validation/number.ts";
import {
  type AnswerModifierOption,
  adminAnswerDeletePage,
  adminAnswerEditPage,
  adminAnswerRecalculatePage,
} from "#templates/admin/questions.tsx";
import { getAnswerAggregateFields } from "#templates/fields/aggregate.ts";
import type { AdminSession } from "#types";
import { answerTextForm } from "./forms.ts";

export type QuestionIdParams = { id: number };

export const redirectToQuestion = redirectToDetail("question");

/** Insert an answer and place it in its question's order, atomically. */
const addAnswerRow = insertScopedOrderedRow(answersTable, answersOrder);

/** Add one answer to a question, in its order, and log it. The one add the
 *  HTML route and the JSON API route share. */
export const addAnswerWithLog = async (
  questionId: number,
  text: string,
): Promise<void> => {
  await addAnswerRow(
    questionId,
    { questionId, sortOrder: 0, text },
    (transaction) =>
      logActivity(
        `Answer '${text}' added to question ${questionId}`,
        undefined,
        undefined,
        transaction,
      ),
  );
};

/** Update one answer's text, and its active flag where the caller sets it,
 *  then log it. The one update the HTML route and the JSON API route share. */
export const updateAnswerWithLog = async (
  question: QuestionWithAnswers,
  answer: Answer,
  patch: { active?: boolean; text: string },
): Promise<void> => {
  await answersTable.update(answer.id, patch);
  await logActivity(
    `Answer '${patch.text}' updated in question ${question.id}`,
  );
};

/** Delete one answer and its dependent attendee answers, then log it against
 *  its question. The one delete the HTML route and the JSON API route share. */
export const deleteAnswerWithLog = async (
  question: QuestionWithAnswers,
  answer: Answer,
): Promise<void> => {
  await deleteAnswer(answer.id);
  await logActivity(
    `Answer '${answer.text}' deleted from question ${question.id}`,
  );
};

/** Handle POST /admin/questions/:id/answers (add answer) */
const handleAddAnswer = createAuthedFormRoute<
  { text: string },
  QuestionIdParams
>({
  auth: formPolicyFor(adminDestinationAt("/admin/questions/:id/answers")),
  form: answerTextForm,
  onInvalid: redirectToQuestion,
  onValid: async ({ params, values: { text } }) => {
    const question = await getQuestionWithAnswers(params.id);
    if (!question) return notFoundResponse();
    // Free-text questions collect a typed value, never an answer id, so the
    // request is refused with an error, and any answer-triggered modifiers
    // never run.
    if (question.display_type === "free_text") {
      return errorRedirect(
        `/admin/questions/${params.id}`,
        t("questions.answers.free_text_no_options"),
      );
    }
    // One transaction: an answer must never exist without its place in the
    // order or its log line. The inserted sortOrder is a placeholder the
    // append overwrites before anything can read it.
    await addAnswerWithLog(params.id, text);
    return redirect(
      `/admin/questions/${params.id}`,
      t("questions.answer_added"),
      true,
    );
  },
});

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
  get: answerEntityHandler(
    pageGuardFor(
      adminDestinationAt("/admin/questions/:id/answers/:answerId/delete"),
    ),
  ),
  post: answerEntityHandler(
    formGuard(
      formPolicyFor(
        adminDestinationAt(
          "/admin/questions/:id/answers/:answerId/recalculate",
        ),
      ),
    ),
  ),
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
const handleDeleteAnswerGet = answerFlashRoute(
  (question, answer, session, flash) =>
    htmlResponse(adminAnswerDeletePage(question, answer, session, flash.error)),
);

/** Handle POST /admin/questions/:id/answers/:answerId/delete */
const handleDeleteAnswerPost: ParamsRoute<AnswerRouteParams> =
  createVerifiedFormRoute<AnswerRouteParams, AnswerContext>({
    actionLabel: "deletion",
    auth: formPolicyFor(
      adminDestinationAt("/admin/questions/:id/answers/:answerId/delete"),
    ),
    identifier: ({ answer }) => answer.text,
    identifierLabel: t("questions.answer_label"),
    loadContext: loadQuestionAndAnswer,
    mismatchRedirect: (_, { id, answerId }) =>
      `/admin/questions/${id}/answers/${answerId}/delete`,
    onConfirm: verifiedDelete(
      ({ answer, question }) => deleteAnswerWithLog(question, answer),
      ({ question }) => `/admin/questions/${question.id}`,
      () => t("questions.answer_deleted"),
    ),
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
const handleEditAnswerGet = answerFlashRoute(
  async (question, answer, session, flash) => {
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
  },
);

/** Handle POST /admin/questions/:id/answers/:answerId/edit (text + modifier) */
const handleEditAnswerPost: ParamsRoute<AnswerRouteParams> =
  createAuthedFormRoute<{ text: string }, AnswerRouteParams, AnswerContext>({
    auth: formPolicyFor(
      adminDestinationAt("/admin/questions/:id/answers/:answerId/edit"),
    ),
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
      const rawModifierId = form.getString("modifier_id");
      const modifierId = rawModifierId ? parsePositiveInt(rawModifierId) : null;
      // A blank field clears the link. A value that is not an id, or an id
      // that cannot trigger this answer, is refused, never cleared.
      const modifierRefused =
        (rawModifierId !== "" && modifierId === null) ||
        (modifierId !== null &&
          !(await answerTriggerModifiers()).some((m) => m.id === modifierId));
      if (modifierRefused) {
        return errorRedirect(
          editAnswerPath(params),
          t("questions.invalid_modifier"),
        );
      }
      const aggregates = parseEditableAggregateForm<AnswerAggregateValues>(
        form,
        getAnswerAggregateFields(),
      );
      if (!aggregates.ok) {
        return errorRedirect(editAnswerPath(params), aggregates.error);
      }
      await updateAnswerWithLog(question, answer, {
        active: form.get("active") === "on",
        text,
      });
      await setAnswerModifier(answer.id, modifierId);
      if (aggregates.input) {
        await answerAggregates.update(answer.id, aggregates.input);
      }
      return redirect(
        `/admin/questions/${question.id}`,
        t("questions.answer_updated"),
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
const handleAnswerRecalculateGet = answerFlashRoute(
  (question, answer, session, flash) =>
    renderAnswerRecalculatePage(
      { answer, question },
      session,
      flash.error,
      flash.success,
    ),
);

/** Handle POST /admin/questions/:id/answers/:answerId/recalculate */
const handleAnswerRecalculatePost = answerHandlers.post(
  ({ answer, question }, session, form, _request, params) =>
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

const answerOrder: {
  down: ParamsRoute<AnswerRouteParams>;
  up: ParamsRoute<AnswerRouteParams>;
} = createOrderedCollectionHandlers({
  auth: formPolicyFor(
    adminDestinationAt("/admin/questions/:id/answers/:answerId/move-up"),
  ),
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

/** The answer routes, ready to spread into the question route table. */
export const answerRoutes = {
  "GET /admin/questions/:id/answers/:answerId/delete": handleDeleteAnswerGet,
  "GET /admin/questions/:id/answers/:answerId/edit": handleEditAnswerGet,
  "GET /admin/questions/:id/answers/:answerId/recalculate":
    handleAnswerRecalculateGet,
  "POST /admin/questions/:id/answers": handleAddAnswer,
  "POST /admin/questions/:id/answers/:answerId/delete": handleDeleteAnswerPost,
  "POST /admin/questions/:id/answers/:answerId/edit": handleEditAnswerPost,
  ...orderRoutes("/admin/questions/:id/answers/:answerId", answerOrder),
  "POST /admin/questions/:id/answers/:answerId/recalculate":
    handleAnswerRecalculatePost,
};
