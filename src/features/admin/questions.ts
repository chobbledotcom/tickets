/**
 * Admin routes for custom questions management (owner-only)
 */

import { mapNotNullish } from "#fp";
import { t } from "#i18n";
import {
  parseEditableAggregateForm,
  selectedRecalculationFields,
} from "#routes/admin/aggregate-recalculation.ts";
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
  type AuthedHandlerArgs,
  createAuthedFormRoute,
  createAuthedHandler,
} from "#shared/app-forms.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import { getAllListings, getListingWithCount } from "#shared/db/listings.ts";
import { getAllModifiers } from "#shared/db/modifiers.ts";
import {
  ANSWER_AGGREGATE_FIELDS,
  type Answer,
  type AnswerAggregateValues,
  answersTable,
  assignNextQuestionSortOrder,
  deleteAnswer,
  deleteQuestion,
  findAnswerById,
  getAllQuestionListingIds,
  getAllQuestionsWithAnswers,
  getAnswerAggregateRecalculation,
  getAnswerModifierId,
  getAnswerSelectionTotals,
  getListingQuestionIds,
  getNextAnswerSortOrder,
  getQuestionListingIds,
  getQuestionWithAnswers,
  isQuestionDisplayType,
  QUESTION_DISPLAY_TYPES,
  type QuestionWithAnswers,
  questionDisplayTypeError,
  questionsTable,
  requireQuestionDisplayType,
  resetAnswerAggregateFields,
  setAnswerModifier,
  setListingQuestions,
  setQuestionListings,
  swapAnswerOrder,
  swapQuestionOrder,
  updateAnswerAggregateValues,
} from "#shared/db/questions.ts";
import { getFlash } from "#shared/flash-context.ts";
import { defineForm } from "#shared/forms.tsx";
import type { AdminSession } from "#shared/types.ts";
import {
  type AnswerModifierOption,
  adminAnswerDeletePage,
  adminAnswerEditPage,
  adminAnswerRecalculatePage,
  adminListingQuestionsPage,
  adminQuestionDeletePage,
  adminQuestionPage,
  adminQuestionsPage,
} from "#templates/admin/questions.tsx";
import {
  type AnswerAggregateFormValues,
  answerAggregateFields,
} from "#templates/fields.ts";

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
      options: QUESTION_DISPLAY_TYPES.map((value) => ({
        label:
          value === "radio"
            ? "Radio buttons"
            : value === "select"
              ? "Select box"
              : "Free text",
        value,
      })),
      required: true,
      type: "select",
    },
  ] as const,
  id: "questionText",
  validate: ({ display_type }) =>
    isQuestionDisplayType(display_type) ? null : questionDisplayTypeError,
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
  const [questions, questionListingIds, allListings] = await Promise.all([
    getAllQuestionsWithAnswers(),
    getAllQuestionListingIds(),
    getAllListings(),
  ]);
  // Resolve listing ids to their decrypted names for the Listings column,
  // dropping any ids whose listing has since been deleted (listing_questions
  // rows are not pruned on listing deletion, so orphans can linger).
  const nameById = new Map(allListings.map((l) => [l.id, l.name]));
  const listingNames = new Map(
    [...questionListingIds].map(([questionId, ids]) => [
      questionId,
      mapNotNullish((id: number) => nameById.get(id))(ids),
    ]),
  );
  return adminQuestionsPage(
    questions,
    session,
    flash.error,
    listingNames,
    allListings.length,
  );
});

/** Handle POST /admin/questions (create question) */
const handleQuestionsPost = createAuthedFormRoute({
  auth: OWNER_FORM,
  form: questionTextForm,
  onInvalid: ({ error }) => errorRedirect("/admin/questions", error),
  onValid: async ({ values: { display_type, text } }) => {
    const question = await questionsTable.insert({
      displayType: requireQuestionDisplayType(display_type),
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
      getAnswerSelectionTotals(q.id),
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
    const existing = await getQuestionWithAnswers(params.id);
    if (!existing) return notFoundResponse();
    // Converting between free-text and choice types would orphan existing
    // answers, so it is not allowed: a free-text question stays free-text (the
    // edit form hides the selector and we ignore any submitted type), and a
    // choice question may only switch between radio and select.
    const requested = requireQuestionDisplayType(display_type);
    const displayType =
      existing.display_type === "free_text" || requested === "free_text"
        ? existing.display_type
        : requested;
    await questionsTable.update(params.id, { displayType, text });
    await logActivity(`Question '${text}' updated`);
    return redirect(`/admin/questions/${params.id}`, "Question updated", true);
  },
});

/** Handle POST /admin/questions/:id/listings (assign question to listings) */
const handleQuestionListings = ownerFormById(async (id, _session, form) => {
  const question = await getQuestionWithAnswers(id);
  if (!question) return notFoundResponse();
  const assignAll = form.get("assign_all") === "on";
  const listingIds = form.getNumberArray("listing_ids");
  await questionsTable.update(id, { assignAll });
  await setQuestionListings(id, listingIds);
  await logActivity(
    assignAll
      ? `Question '${question.text}' assigned to all listings`
      : `Question '${question.text}' assigned to ${listingIds.length} listing${
          listingIds.length !== 1 ? "s" : ""
        }`,
  );
  return redirect(`/admin/questions/${id}`, "Listings updated", true);
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
    const question = await getQuestionWithAnswers(params.id);
    if (!question) return notFoundResponse();
    // Free-text questions collect a typed value, never an answer id, so answer
    // options (and any answer-triggered modifiers) would be silently ignored.
    if (question.display_type === "free_text") {
      return errorRedirect(
        `/admin/questions/${params.id}`,
        "Free-text questions don't have answer options",
      );
    }
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

type AnswerRouteParams = { id: number; answerId: number };
type AnswerContext = { question: QuestionWithAnswers; answer: Answer };

/** Load question + answer by route params, returning null if either is missing */
const loadQuestionAndAnswer = async ({
  id,
  answerId,
}: AnswerRouteParams): Promise<AnswerContext | null> => {
  const question = await getQuestionWithAnswers(id);
  if (!question) return null;
  const answer = findAnswerById(question, answerId);
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

/** Owner POST handler for answer-scoped actions (move, recalculate): the
 * createAuthedHandler counterpart to {@link answerRoute}. Fixes the owner auth
 * policy and the question+answer loader so each action only supplies its body. */
const answerActionHandler = (
  handle: (
    args: AuthedHandlerArgs<AnswerRouteParams, AnswerContext>,
  ) => Response | Promise<Response>,
) =>
  createAuthedHandler<AnswerRouteParams, AnswerContext>({
    auth: OWNER_FORM,
    handle,
    loadContext: loadQuestionAndAnswer,
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
const handleEditAnswerGet = answerRoute(async (question, answer, session) => {
  const flash = getFlash();
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
  values: AnswerAggregateFormValues,
): AnswerAggregateValues => ({
  times_selected: values.times_selected,
});

/** Handle POST /admin/questions/:id/answers/:answerId/edit (text + modifier) */
const handleEditAnswerPost = createAuthedFormRoute<
  { text: string },
  AnswerRouteParams,
  AnswerContext
>({
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
      AnswerAggregateFormValues,
      AnswerAggregateValues
    >(form, answerAggregateFields, extractAnswerAggregateValues);
    if (!aggregates.ok) {
      return errorRedirect(editAnswerPath(params), aggregates.error);
    }
    await answersTable.update(answer.id, {
      active: form.get("active") === "on",
      text,
    });
    await setAnswerModifier(answer.id, modifierId);
    if (aggregates.input) {
      await updateAnswerAggregateValues(answer.id, aggregates.input);
    }
    await logActivity(`Answer '${text}' updated in question ${question.id}`);
    return redirect(`/admin/questions/${question.id}`, "Answer updated", true);
  },
});

/** Render the answer running-total recalculation page from the current,
 * freshly-snapshotted stored vs attendee-answer values. */
const renderAnswerRecalculatePage = async (
  question: QuestionWithAnswers,
  answer: Answer,
  session: AdminSession,
  error?: string,
  success?: string,
): Promise<Response> =>
  htmlResponse(
    adminAnswerRecalculatePage(
      question,
      answer,
      await getAnswerAggregateRecalculation(answer.id),
      session,
      error,
      success,
    ),
    error ? 400 : 200,
  );

/** Handle GET /admin/questions/:id/answers/:answerId/recalculate */
const handleAnswerRecalculateGet = answerRoute((question, answer, session) => {
  const flash = getFlash();
  return renderAnswerRecalculatePage(
    question,
    answer,
    session,
    flash.error,
    flash.success,
  );
});

/** Handle POST /admin/questions/:id/answers/:answerId/recalculate */
const handleAnswerRecalculatePost = answerActionHandler(
  async ({ context: { answer, question }, form, params, session }) => {
    const selected = selectedRecalculationFields(form, ANSWER_AGGREGATE_FIELDS);
    if (selected.length === 0) {
      return renderAnswerRecalculatePage(
        question,
        answer,
        session,
        t("questions.recalculate.choose"),
      );
    }
    await resetAnswerAggregateFields(answer.id, selected);
    await logActivity(
      `Answer '${answer.text}' selection total recalculated in question ${question.id}`,
    );
    return redirect(
      editAnswerPath(params),
      t("questions.recalculate.success"),
      true,
    );
  },
);

/** Factory for move-up/move-down handlers */
const moveAnswerHandler = (direction: -1 | 1) =>
  answerActionHandler(async ({ context: { answer, question } }) => {
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
    "GET /admin/questions/:id/answers/:answerId/edit": handleEditAnswerGet,
    "GET /admin/questions/:id/answers/:answerId/recalculate":
      handleAnswerRecalculateGet,
    "POST /admin/listing/:id/questions": handleListingQuestionsPost,
    "POST /admin/questions": handleQuestionsPost,
    "POST /admin/questions/:id/answers": handleAddAnswer,
    "POST /admin/questions/:id/answers/:answerId/delete":
      handleDeleteAnswerPost,
    "POST /admin/questions/:id/answers/:answerId/edit": handleEditAnswerPost,
    "POST /admin/questions/:id/answers/:answerId/move-down":
      handleMoveAnswerDown,
    "POST /admin/questions/:id/answers/:answerId/move-up": handleMoveAnswerUp,
    "POST /admin/questions/:id/answers/:answerId/recalculate":
      handleAnswerRecalculatePost,
    "POST /admin/questions/:id/edit": handleQuestionEdit,
    "POST /admin/questions/:id/listings": handleQuestionListings,
    "POST /admin/questions/:id/move-down": handleMoveQuestionDown,
    "POST /admin/questions/:id/move-up": handleMoveQuestionUp,
  }),
};
