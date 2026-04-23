/**
 * Admin routes for custom questions management (owner-only)
 */

/* jscpd:ignore-start */
import { createAuthedFormRoute } from "#lib/app-forms.ts";
import { logActivity } from "#lib/db/activityLog.ts";
import { getEventWithCount } from "#lib/db/events.ts";
import {
  type Answer,
  answersTable,
  deleteAnswer,
  deleteQuestion,
  getAllQuestionsWithAnswers,
  getAnswerCountsForQuestion,
  getEventQuestionIds,
  getNextAnswerSortOrder,
  getQuestionWithAnswers,
  type QuestionWithAnswers,
  questionsTable,
  setEventQuestions,
  swapAnswerOrder,
} from "#lib/db/questions.ts";
import { getFlash } from "#lib/flash-context.ts";
import { defineForm } from "#lib/forms.tsx";
import type { AdminSession } from "#lib/types.ts";
import {
  createConfirmedHandlers,
  verifyOrRedirect,
} from "#routes/admin/confirmation.ts";
import {
  OWNER_FORM,
  ownerPage,
  requireOwnerOr,
  withAuth,
} from "#routes/auth.ts";
import type { FormParams } from "#routes/csrf.ts";
import { ownerFormById, ownerGetById } from "#routes/entity.ts";
import {
  errorRedirect,
  htmlResponse,
  notFoundResponse,
  redirect,
} from "#routes/response.ts";
import { defineRoutes } from "#routes/router.ts";
import {
  adminAnswerDeletePage,
  adminEventQuestionsPage,
  adminQuestionDeletePage,
  adminQuestionPage,
  adminQuestionsPage,
} from "#templates/admin/questions.tsx";

/* jscpd:ignore-end */

export const questionTextForm = defineForm({
  fields: [
    {
      label: "Question text",
      name: "text",
      placeholder: "e.g. What is your T-shirt size?",
      required: true,
      type: "text",
    },
  ] as const,
  id: "questionText",
});

export const answerTextForm = defineForm({
  fields: [
    {
      label: "Answer text",
      name: "text",
      placeholder: "e.g. Medium",
      required: true,
      type: "text",
    },
  ] as const,
  id: "answerText",
});

/** Handle GET /admin/questions */
const handleQuestionsGet = ownerPage(async (session) => {
  const flash = getFlash();
  return adminQuestionsPage(
    await getAllQuestionsWithAnswers(),
    session,
    flash.error,
  );
});

/** Handle POST /admin/questions (create question) */
const handleQuestionsPost = createAuthedFormRoute({
  auth: OWNER_FORM,
  form: questionTextForm,
  onInvalid: ({ error }) => errorRedirect("/admin/questions", error),
  onValid: async ({ values: { text } }) => {
    await questionsTable.insert({ text });
    await logActivity(`Question '${text}' created`);
    return redirect("/admin/questions", "Question created", true);
  },
});

/** Handle GET /admin/questions/:id */
const handleQuestionGet = ownerGetById(
  getQuestionWithAnswers,
  async (q, session) => {
    const flash = getFlash();
    const answerCounts = await getAnswerCountsForQuestion(q.id);
    return htmlResponse(
      adminQuestionPage(q, session, flash.error, answerCounts),
    );
  },
);

type QuestionIdParams = { id: number };

const redirectToQuestion = (
  args: { error: string; params: QuestionIdParams },
): Response => errorRedirect(`/admin/questions/${args.params.id}`, args.error);

/** Handle POST /admin/questions/:id/edit */
const handleQuestionEdit = createAuthedFormRoute<
  { text: string },
  QuestionIdParams
>({
  auth: OWNER_FORM,
  form: questionTextForm,
  onInvalid: redirectToQuestion,
  onValid: async ({ params, values: { text } }) => {
    const updated = await questionsTable.update(params.id, { text });
    if (!updated) return notFoundResponse();
    await logActivity(`Question '${text}' updated`);
    return redirect(`/admin/questions/${params.id}`, "Question updated", true);
  },
});

/** Handle POST /admin/questions/:id/answers (add answer) */
const handleAddAnswer = createAuthedFormRoute<
  { text: string },
  QuestionIdParams
>({
  auth: OWNER_FORM,
  form: answerTextForm,
  onInvalid: redirectToQuestion,
  onValid: async ({ params, values: { text } }) => {
    const sortOrder = await getNextAnswerSortOrder(params.id);
    await answersTable.insert({ questionId: params.id, sortOrder, text });
    await logActivity(`Answer '${text}' added to question ${params.id}`);
    return redirect(`/admin/questions/${params.id}`, "Answer added", true);
  },
});

/** Confirmed-delete handlers for questions */
const questionDelete = createConfirmedHandlers<QuestionWithAnswers>({
  identifier: (q) => q.text,
  identifierLabel: "Question text",
  load: (id) => getQuestionWithAnswers(id),
  onConfirm: async (q) => {
    await deleteQuestion(q.id);
    await logActivity(`Question '${q.text}' deleted`);
  },
  path: "/admin/questions/:id/delete",
  render: (q, session, error) => adminQuestionDeletePage(q, session, error),
  successMessage: "Question deleted",
  successRedirect: "/admin/questions",
});

/** Load question + answer by IDs, returning 404 if either is missing */
const withAnswer = async <T>(
  questionId: number,
  answerId: number,
  handler: (question: QuestionWithAnswers, answer: Answer) => T | Promise<T>,
): Promise<T | Response> => {
  const question = await getQuestionWithAnswers(questionId);
  if (!question) return notFoundResponse();
  const answer = question.answers.find((a) => a.id === answerId);
  if (!answer) return notFoundResponse();
  return handler(question, answer);
};

type AnswerRouteParams = { id: number; answerId: number };
type AnswerHandler<Extra extends unknown[]> = (
  question: QuestionWithAnswers,
  answer: Answer,
  session: AdminSession,
  ...extra: Extra
) => Response | Promise<Response>;

/** Owner answer-scoped route factory, parameterized by auth type */
const withAnswerAuth =
  <Extra extends unknown[]>(
    auth: (
      request: Request,
      handler: (
        session: AdminSession,
        ...extra: Extra
      ) => Response | Promise<Response>,
    ) => Promise<Response>,
  ) =>
  (handler: AnswerHandler<Extra>) =>
  (request: Request, { id, answerId }: AnswerRouteParams): Promise<Response> =>
    auth(request, (session, ...extra) =>
      withAnswer(id, answerId, (question, answer) =>
        handler(question, answer, session, ...extra),
      ),
    );

/** Owner GET route for answer-scoped pages */
const answerRoute = withAnswerAuth(requireOwnerOr);

/** Owner POST route for answer-scoped form actions */
const answerFormRoute = withAnswerAuth(
  (
    request: Request,
    handler: (s: AdminSession, f: FormParams) => Response | Promise<Response>,
  ) => withAuth(request, OWNER_FORM, handler),
);

/** Handle GET /admin/questions/:id/answers/:answerId/delete */
const handleDeleteAnswerGet = answerRoute((question, answer, session) => {
  const flash = getFlash();
  return htmlResponse(
    adminAnswerDeletePage(question, answer, session, flash.error),
  );
});

/** Handle POST /admin/questions/:id/answers/:answerId/delete */
const handleDeleteAnswerPost = answerFormRoute(
  async (question, answer, _session, form) => {
    const error = verifyOrRedirect(
      form,
      answer.text,
      `/admin/questions/${question.id}/answers/${answer.id}/delete`,
      "Answer text",
      "deletion",
    );
    if (error) return error;
    await deleteAnswer(answer.id);
    await logActivity(
      `Answer '${answer.text}' deleted from question ${question.id}`,
    );
    return redirect(`/admin/questions/${question.id}`, "Answer deleted", true);
  },
);

/** Factory for move-up/move-down handlers */
const moveAnswerHandler = (direction: -1 | 1) =>
  answerFormRoute(async (question, answer, _session) => {
    const idx = question.answers.findIndex((a) => a.id === answer.id);
    const neighbor = question.answers[idx + direction];
    if (neighbor) {
      await swapAnswerOrder(
        answer.id,
        answer.sort_order,
        neighbor.id,
        neighbor.sort_order,
      );
    }
    return redirect(`/admin/questions/${question.id}`, "Answer moved", true);
  });

/** Handle POST /admin/questions/:id/answers/:answerId/move-up */
const handleMoveAnswerUp = moveAnswerHandler(-1);

/** Handle POST /admin/questions/:id/answers/:answerId/move-down */
const handleMoveAnswerDown = moveAnswerHandler(1);

/** Handle GET /admin/event/:id/questions */
const handleEventQuestionsGet = ownerGetById(
  getEventWithCount,
  async (event, session) => {
    const [allQuestions, assignedIds] = await Promise.all([
      getAllQuestionsWithAnswers(),
      getEventQuestionIds(event.id),
    ]);
    return htmlResponse(
      adminEventQuestionsPage(
        event,
        allQuestions,
        new Set(assignedIds),
        session,
      ),
    );
  },
);

/** Handle POST /admin/event/:id/questions */
const handleEventQuestionsPost = ownerFormById(async (id, _session, form) => {
  const event = await getEventWithCount(id);
  if (!event) return notFoundResponse();
  const questionIds = form
    .getAll("question_ids")
    .map((v) => Number.parseInt(v, 10))
    .filter((n) => !Number.isNaN(n));
  await setEventQuestions(id, questionIds);
  await logActivity(
    `Questions updated for '${event.name}' (${questionIds.length} question${
      questionIds.length !== 1 ? "s" : ""
    })`,
    event,
  );
  return redirect(`/admin/event/${id}`, "Questions updated", true);
});

/** Questions routes */
export const questionsRoutes = {
  ...questionDelete.routes,
  ...defineRoutes({
    "GET /admin/event/:id/questions": handleEventQuestionsGet,
    "GET /admin/questions": handleQuestionsGet,
    "GET /admin/questions/:id": handleQuestionGet,
    "GET /admin/questions/:id/answers/:answerId/delete": handleDeleteAnswerGet,
    "POST /admin/event/:id/questions": handleEventQuestionsPost,
    "POST /admin/questions": handleQuestionsPost,
    "POST /admin/questions/:id/answers": handleAddAnswer,
    "POST /admin/questions/:id/answers/:answerId/delete":
      handleDeleteAnswerPost,
    "POST /admin/questions/:id/answers/:answerId/move-down":
      handleMoveAnswerDown,
    "POST /admin/questions/:id/answers/:answerId/move-up": handleMoveAnswerUp,
    "POST /admin/questions/:id/edit": handleQuestionEdit,
  }),
};
