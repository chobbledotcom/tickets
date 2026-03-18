/**
 * Admin routes for custom questions management (owner-only)
 */

import { logActivity } from "#lib/db/activityLog.ts";
import { getEventWithCount } from "#lib/db/events.ts";
import {
  answersTable,
  deleteAnswer,
  deleteQuestion,
  getAllQuestionsWithAnswers,
  getNextAnswerSortOrder,
  getQuestion,
  getQuestionsForEvent,
  getQuestionWithAnswers,
  questionsTable,
  setEventQuestions,
} from "#lib/db/questions.ts";
import type { AdminSession } from "#lib/types.ts";
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
  adminEventQuestionsPage,
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
const handleQuestionsPost = (request: Request): Promise<Response> =>
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
  (q, session) => htmlResponse(adminQuestionPage(q, session)),
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

/** Handle POST /admin/questions/:id/answers/:answerId/delete */
const handleDeleteAnswer = (
  request: Request,
  { id, answerId }: { id: number; answerId: number },
): Promise<Response> =>
  withOwnerAuthForm(request, async () => {
    await deleteAnswer(answerId);
    await logActivity(`Answer deleted from question ${id}`);
    return redirect(`/admin/questions/${id}`, "Answer deleted", true);
  });

/** Handle POST /admin/questions/:id/delete */
const handleDeleteQuestion = ownerFormById(async (id) => {
  const question = await getQuestion(id);
  if (!question) return notFoundResponse();
  await deleteQuestion(id);
  await logActivity(`Question '${question.text}' deleted`);
  return redirect("/admin/questions", "Question deleted", true);
});

/** Handle GET /admin/event/:id/questions */
const handleEventQuestionsGet = ownerGetById(
  getEventWithCount,
  async (event, session) => {
    const [allQuestions, assigned] = await Promise.all([
      getAllQuestionsWithAnswers(),
      getQuestionsForEvent(event.id),
    ]);
    return htmlResponse(
      adminEventQuestionsPage(
        event,
        allQuestions,
        new Set(assigned.map((q) => q.id)),
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
  "POST /admin/questions/:id/answers/:answerId/delete": handleDeleteAnswer,
  "POST /admin/questions/:id/delete": handleDeleteQuestion,
  "GET /admin/event/:id/questions": handleEventQuestionsGet,
  "POST /admin/event/:id/questions": handleEventQuestionsPost,
});
