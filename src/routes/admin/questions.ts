/**
 * Admin routes for custom questions management (owner-only)
 */

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
  getQuestion,
  getQuestionWithAnswers,
  type QuestionWithAnswers,
  questionsTable,
  setEventQuestions,
  swapAnswerOrder,
} from "#lib/db/questions.ts";
import type { AdminSession } from "#lib/types.ts";
import { verifyIdentifier } from "#routes/admin/utils.ts";
import { defineRoutes } from "#routes/router.ts";
import {
  htmlResponse,
  notFoundResponse,
  ownerFormById,
  ownerGetById,
  redirect,
  requireOwnerOr,
  withOwnerAuthForm,
} from "#routes/utils.ts";
import {
  adminAnswerDeletePage,
  adminEventQuestionsPage,
  adminQuestionDeletePage,
  adminQuestionPage,
  adminQuestionsPage,
} from "#templates/admin/questions.tsx";

/** Extract trimmed text value from a form */
const extractText = (form: URLSearchParams): string =>
  (form.get("text") || "").trim();

/** Validate text is non-empty, returning error page if blank */
const requireTextOrError = async (
  form: URLSearchParams,
  questionId: number,
  session: AdminSession,
  errorMsg: string,
): Promise<string | Response> => {
  const text = extractText(form);
  if (text) return text;
  const question = await getQuestionWithAnswers(questionId);
  return question
    ? htmlResponse(adminQuestionPage(question, session, errorMsg), 400)
    : notFoundResponse();
};

/** Handle GET /admin/questions */
const handleQuestionsGet = (request: Request): Promise<Response> =>
  requireOwnerOr(request, async (session) =>
    htmlResponse(
      adminQuestionsPage(await getAllQuestionsWithAnswers(), session),
    ),
  );

/** Handle POST /admin/questions (create question) */
const handleQuestionsPost = (request: Request) =>
  withOwnerAuthForm(request, async (session, form) => {
    const text = extractText(form);
    if (!text) {
      return htmlResponse(
        adminQuestionsPage(
          await getAllQuestionsWithAnswers(),
          session,
          "Question text is required",
        ),
        400,
      );
    }
    await questionsTable.insert({ text });
    await logActivity(`Question '${text}' created`);
    return redirect("/admin/questions", "Question created", true);
  });

/** Handle GET /admin/questions/:id */
const handleQuestionGet = ownerGetById(
  getQuestionWithAnswers,
  async (q, session) => {
    const answerCounts = await getAnswerCountsForQuestion(q.id);
    return htmlResponse(adminQuestionPage(q, session, undefined, answerCounts));
  },
);

/** Shared handler for question-scoped text submit actions (edit/add answer) */
const withValidatedText = (
  errorMsg: string,
  onValid: (id: number, text: string) => Promise<Response>,
) =>
  ownerFormById(async (id, session, form) => {
    const textOrError = await requireTextOrError(form, id, session, errorMsg);
    return textOrError instanceof Response
      ? textOrError
      : onValid(id, textOrError);
  });

/** Handle POST /admin/questions/:id/edit */
const handleQuestionEdit = withValidatedText(
  "Question text is required",
  async (id, text) => {
    const updated = await questionsTable.update(id, { text });
    if (!updated) return notFoundResponse();
    await logActivity(`Question '${text}' updated`);
    return redirect(`/admin/questions/${id}`, "Question updated", true);
  },
);

/** Handle POST /admin/questions/:id/answers (add answer) */
const handleAddAnswer = withValidatedText(
  "Answer text is required",
  async (id, text) => {
    const sortOrder = await getNextAnswerSortOrder(id);
    await answersTable.insert({ questionId: id, text, sortOrder });
    await logActivity(`Answer '${text}' added to question ${id}`);
    return redirect(`/admin/questions/${id}`, "Answer added", true);
  },
);

const CONFIRM_TEXT_MSG =
  "Text does not match. Please type the exact text to confirm deletion.";

/** Handle GET /admin/questions/:id/delete */
const handleDeleteQuestionGet = ownerGetById(
  getQuestionWithAnswers,
  (q, session) => htmlResponse(adminQuestionDeletePage(q, session)),
);

/** Handle POST /admin/questions/:id/delete */
const handleDeleteQuestionPost = ownerFormById(async (id, session, form) => {
  const question = await getQuestion(id);
  if (!question) return notFoundResponse();
  const confirm = form.get("confirm_identifier") ?? "";
  if (!verifyIdentifier(question.text, confirm)) {
    const questionWithAnswers = await getQuestionWithAnswers(id);
    return questionWithAnswers
      ? htmlResponse(
          adminQuestionDeletePage(
            questionWithAnswers,
            session,
            CONFIRM_TEXT_MSG,
          ),
          400,
        )
      : notFoundResponse();
  }
  await deleteQuestion(id);
  await logActivity(`Question '${question.text}' deleted`);
  return redirect("/admin/questions", "Question deleted", true);
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
const answerFormRoute = withAnswerAuth(withOwnerAuthForm);

/** Handle GET /admin/questions/:id/answers/:answerId/delete */
const handleDeleteAnswerGet = answerRoute((question, answer, session) =>
  htmlResponse(adminAnswerDeletePage(question, answer, session)),
);

/** Handle POST /admin/questions/:id/answers/:answerId/delete */
const handleDeleteAnswerPost = answerFormRoute(
  async (question, answer, session, form) => {
    const confirm = form.get("confirm_identifier") ?? "";
    if (!verifyIdentifier(answer.text, confirm)) {
      return htmlResponse(
        adminAnswerDeletePage(question, answer, session, CONFIRM_TEXT_MSG),
        400,
      );
    }
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
    `Questions updated for '${event.name}' (${questionIds.length} question${questionIds.length !== 1 ? "s" : ""})`,
    event,
  );
  return redirect(`/admin/event/${id}`, "Questions updated", true);
});

/** Questions routes */
export const questionsRoutes = defineRoutes({
  "GET /admin/questions": handleQuestionsGet,
  "POST /admin/questions": handleQuestionsPost,
  "GET /admin/questions/:id": handleQuestionGet,
  "POST /admin/questions/:id/edit": handleQuestionEdit,
  "POST /admin/questions/:id/answers": handleAddAnswer,
  "GET /admin/questions/:id/delete": handleDeleteQuestionGet,
  "POST /admin/questions/:id/delete": handleDeleteQuestionPost,
  "GET /admin/questions/:id/answers/:answerId/delete": handleDeleteAnswerGet,
  "POST /admin/questions/:id/answers/:answerId/delete": handleDeleteAnswerPost,
  "POST /admin/questions/:id/answers/:answerId/move-up": handleMoveAnswerUp,
  "POST /admin/questions/:id/answers/:answerId/move-down": handleMoveAnswerDown,
  "GET /admin/event/:id/questions": handleEventQuestionsGet,
  "POST /admin/event/:id/questions": handleEventQuestionsPost,
});
