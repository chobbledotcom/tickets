/**
 * Admin routes for custom questions management (owner-only)
 */

import {
  createConfirmedHandlers,
  createVerifiedFormRoute,
} from "#routes/admin/confirmation.ts";
import { OWNER_FORM, ownerPage, requireOwnerOr } from "#routes/auth.ts";
import { ownerFormById, ownerGetById } from "#routes/entity.ts";
import {
  errorRedirect,
  htmlResponse,
  notFoundResponse,
  redirect,
} from "#routes/response.ts";
import { defineRoutes } from "#routes/router.ts";
/* jscpd:ignore-start */
import {
  createAuthedFormRoute,
  createAuthedHandler,
} from "#shared/app-forms.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import { getAllListings, getListingWithCount } from "#shared/db/listings.ts";
import {
  type Answer,
  answersTable,
  assignNextQuestionSortOrder,
  deleteAnswer,
  deleteQuestion,
  getAllQuestionsWithAnswers,
  getAnswerCountsForQuestion,
  getListingQuestionIds,
  getNextAnswerSortOrder,
  getQuestionListingIds,
  getQuestionWithAnswers,
  type QuestionDisplayType,
  type QuestionWithAnswers,
  questionsTable,
  setListingQuestions,
  setQuestionListings,
  swapAnswerOrder,
  swapQuestionOrder,
} from "#shared/db/questions.ts";
import { getFlash } from "#shared/flash-context.ts";
import { defineForm } from "#shared/forms.tsx";
import {
  type CalcKind,
  isCalcKind,
  isModifierDirection,
  type ModifierDirection,
  validateCalcValue,
} from "#shared/price-modifier.ts";
import type { AdminSession } from "#shared/types.ts";
import {
  adminAnswerDeletePage,
  adminListingQuestionsPage,
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
    {
      label: "Display as",
      name: "display_type",
      options: [
        { label: "Radio buttons", value: "radio" },
        { label: "Select box", value: "select" },
      ],
      required: true,
      type: "select",
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
    {
      defaultValue: "fixed",
      label: "Price modifier type",
      name: "calc_kind",
      options: [
        { label: "Fixed amount", value: "fixed" },
        { label: "Percentage", value: "percent" },
        { label: "Multiplier", value: "multiply" },
      ],
      type: "select",
    },
    {
      defaultValue: "charge",
      label: "Price modifier direction",
      name: "direction",
      options: [
        { label: "Charge (adds to the price)", value: "charge" },
        { label: "Discount (reduces the price)", value: "discount" },
      ],
      type: "select",
    },
    {
      hint: "Optional. Leave blank for no price change. Fixed amounts are in your currency; percentages and multipliers work like Modifiers.",
      inputmode: "decimal",
      label: "Price modifier value",
      name: "calc_value",
      parse: (value: string) => (value ? Number.parseFloat(value) : null),
      type: "text",
      validate: (value: string) =>
        Number.isFinite(Number.parseFloat(value))
          ? null
          : "Enter a valid number",
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
  onValid: async ({ values: { display_type, text } }) => {
    const question = await questionsTable.insert({
      displayType: display_type as QuestionDisplayType,
      text,
    });
    await assignNextQuestionSortOrder(question.id);
    await logActivity(`Question '${text}' created`);
    return redirect(
      `/admin/questions/${question.id}`,
      "Question created",
      true,
    );
  },
});

/** Handle GET /admin/questions/:id */
const handleQuestionGet = ownerGetById(
  getQuestionWithAnswers,
  async (q, session) => {
    const flash = getFlash();
    const [answerCounts, allListings, assignedListingIds] = await Promise.all([
      getAnswerCountsForQuestion(q.id),
      getAllListings(),
      getQuestionListingIds(q.id),
    ]);
    return htmlResponse(
      adminQuestionPage(
        q,
        session,
        flash.error,
        answerCounts,
        allListings,
        new Set(assignedListingIds),
      ),
    );
  },
);

type QuestionIdParams = { id: number };

const redirectToQuestion = (args: {
  error: string;
  params: QuestionIdParams;
}): Response => errorRedirect(`/admin/questions/${args.params.id}`, args.error);

/** Handle POST /admin/questions/:id/edit */
const handleQuestionEdit = createAuthedFormRoute<
  { display_type: string; text: string },
  QuestionIdParams
>({
  auth: OWNER_FORM,
  form: questionTextForm,
  onInvalid: redirectToQuestion,
  onValid: async ({ params, values: { display_type, text } }) => {
    const updated = await questionsTable.update(params.id, {
      displayType: display_type as QuestionDisplayType,
      text,
    });
    if (!updated) return notFoundResponse();
    await logActivity(`Question '${text}' updated`);
    return redirect(`/admin/questions/${params.id}`, "Question updated", true);
  },
});

/** Handle POST /admin/questions/:id/listings (assign question to listings) */
const handleQuestionListings = ownerFormById(async (id, _session, form) => {
  const question = await getQuestionWithAnswers(id);
  if (!question) return notFoundResponse();
  const listingIds = form.getNumberArray("listing_ids");
  await setQuestionListings(id, listingIds);
  await logActivity(
    `Question '${question.text}' assigned to ${listingIds.length} listing${
      listingIds.length !== 1 ? "s" : ""
    }`,
  );
  return redirect(`/admin/questions/${id}`, "Listings updated", true);
});

/** Handle POST /admin/questions/:id/answers (add answer) */
const handleAddAnswer = createAuthedFormRoute<
  {
    calc_kind: string | null;
    calc_value: number | null;
    direction: string | null;
    text: string;
  },
  QuestionIdParams
>({
  auth: OWNER_FORM,
  form: answerTextForm,
  onInvalid: redirectToQuestion,
  onValid: async ({
    params,
    values: { calc_kind, calc_value, direction, text },
  }) => {
    const kind = calc_kind;
    const dir = direction;
    if (calc_value !== null) {
      if (!kind || !dir || !isCalcKind(kind) || !isModifierDirection(dir)) {
        return redirectToQuestion({ error: "Invalid price modifier", params });
      }
      const error = validateCalcValue(kind, calc_value);
      if (error) return redirectToQuestion({ error, params });
    }
    const sortOrder = await getNextAnswerSortOrder(params.id);
    await answersTable.insert(
      calc_value === null
        ? { questionId: params.id, sortOrder, text }
        : {
            calcKind: kind as CalcKind,
            calcValue: calc_value,
            direction: dir as ModifierDirection,
            questionId: params.id,
            sortOrder,
            text,
          },
    );
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

type AnswerRouteParams = { id: number; answerId: number };
type AnswerContext = { question: QuestionWithAnswers; answer: Answer };

/** Load question + answer by route params, returning null if either is missing */
const loadQuestionAndAnswer = async ({
  id,
  answerId,
}: AnswerRouteParams): Promise<AnswerContext | null> => {
  const question = await getQuestionWithAnswers(id);
  if (!question) return null;
  const answer = question.answers.find((a) => a.id === answerId);
  if (!answer) return null;
  return { answer, question };
};

/** Owner GET route for answer-scoped pages */
const answerRoute =
  (
    handler: (
      question: QuestionWithAnswers,
      answer: Answer,
      session: AdminSession,
    ) => Response | Promise<Response>,
  ) =>
  (request: Request, { id, answerId }: AnswerRouteParams): Promise<Response> =>
    requireOwnerOr(request, async (session) => {
      const result = await loadQuestionAndAnswer({ answerId, id });
      if (!result) return notFoundResponse();
      return handler(result.question, result.answer, session);
    });

/** Handle GET /admin/questions/:id/answers/:answerId/delete */
const handleDeleteAnswerGet = answerRoute((question, answer, session) => {
  const flash = getFlash();
  return htmlResponse(
    adminAnswerDeletePage(question, answer, session, flash.error),
  );
});

/** Handle POST /admin/questions/:id/answers/:answerId/delete */
const handleDeleteAnswerPost = createVerifiedFormRoute<
  AnswerRouteParams,
  AnswerContext
>({
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
    return redirect(`/admin/questions/${question.id}`, "Answer deleted", true);
  },
});

/** Factory for move-up/move-down handlers */
const moveAnswerHandler = (direction: -1 | 1) =>
  createAuthedHandler<AnswerRouteParams, AnswerContext>({
    auth: OWNER_FORM,
    handle: async ({ context: { answer, question } }) => {
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
    },
    loadContext: loadQuestionAndAnswer,
  });

/** Handle POST /admin/questions/:id/answers/:answerId/move-up */
const handleMoveAnswerUp = moveAnswerHandler(-1);

/** Handle POST /admin/questions/:id/answers/:answerId/move-down */
const handleMoveAnswerDown = moveAnswerHandler(1);

/** Factory for question move-up/move-down handlers. Swaps the question's
 * global sort_order with its neighbour in the ordered list. */
const moveQuestionHandler = (direction: -1 | 1) =>
  createAuthedHandler<QuestionIdParams, QuestionWithAnswers>({
    auth: OWNER_FORM,
    handle: async ({ context: question }) => {
      const all = await getAllQuestionsWithAnswers();
      const idx = all.findIndex((q) => q.id === question.id);
      const neighbor = all[idx + direction];
      if (neighbor) await swapQuestionOrder(question.id, neighbor.id);
      return redirect("/admin/questions", "Question moved", true);
    },
    loadContext: ({ id }) => getQuestionWithAnswers(id),
  });

/** Handle POST /admin/questions/:id/move-up */
const handleMoveQuestionUp = moveQuestionHandler(-1);

/** Handle POST /admin/questions/:id/move-down */
const handleMoveQuestionDown = moveQuestionHandler(1);

/** Handle GET /admin/listing/:id/questions */
const handleListingQuestionsGet = ownerGetById(
  getListingWithCount,
  async (listing, session) => {
    const [allQuestions, assignedIds] = await Promise.all([
      getAllQuestionsWithAnswers(),
      getListingQuestionIds(listing.id),
    ]);
    return htmlResponse(
      adminListingQuestionsPage(
        listing,
        allQuestions,
        new Set(assignedIds),
        session,
      ),
    );
  },
);

/** Handle POST /admin/listing/:id/questions */
const handleListingQuestionsPost = ownerFormById(async (id, _session, form) => {
  const listing = await getListingWithCount(id);
  if (!listing) return notFoundResponse();
  const questionIds = form.getNumberArray("question_ids");
  await setListingQuestions(id, questionIds);
  await logActivity(
    `Questions updated for '${listing.name}' (${questionIds.length} question${
      questionIds.length !== 1 ? "s" : ""
    })`,
    listing,
  );
  return redirect(`/admin/listing/${id}`, "Questions updated", true);
});

/** Questions routes */
export const questionsRoutes = {
  ...questionDelete.routes,
  ...defineRoutes({
    "GET /admin/listing/:id/questions": handleListingQuestionsGet,
    "GET /admin/questions": handleQuestionsGet,
    "GET /admin/questions/:id": handleQuestionGet,
    "GET /admin/questions/:id/answers/:answerId/delete": handleDeleteAnswerGet,
    "POST /admin/listing/:id/questions": handleListingQuestionsPost,
    "POST /admin/questions": handleQuestionsPost,
    "POST /admin/questions/:id/answers": handleAddAnswer,
    "POST /admin/questions/:id/answers/:answerId/delete":
      handleDeleteAnswerPost,
    "POST /admin/questions/:id/answers/:answerId/move-down":
      handleMoveAnswerDown,
    "POST /admin/questions/:id/answers/:answerId/move-up": handleMoveAnswerUp,
    "POST /admin/questions/:id/edit": handleQuestionEdit,
    "POST /admin/questions/:id/listings": handleQuestionListings,
    "POST /admin/questions/:id/move-down": handleMoveQuestionDown,
    "POST /admin/questions/:id/move-up": handleMoveQuestionUp,
  }),
};
