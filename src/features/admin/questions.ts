import { handlersFor } from "#routes/admin/handlers.ts";
import { planReorder } from "#shared/reorder.ts";
/**
 * Admin routes for custom questions management (owner-only)
 */

import { mapBy, mapNotNullish } from "#fp";
import { t } from "#i18n";
import {
  createRecalculatePageRenderer,
  parseEditableAggregateForm,
  runRecalculatePost,
} from "#routes/admin/aggregate-recalculation.ts";
import {
  createConfirmedHandlers,
  createVerifiedFormRoute,
} from "#routes/admin/confirmation.ts";
import {
  formGuard,
  OWNER_FORM,
  ownerPage,
  requireOwnerOr,
} from "#routes/auth.ts";
import {
  createEntityHandler,
  ownerFormById,
  ownerGetById,
} from "#routes/entity.ts";
/* jscpd:ignore-start */
import {
  errorRedirect,
  htmlResponse,
  notFoundResponse,
  redirect,
} from "#routes/response.ts";
import {
  createAuthedFormRoute,
  createAuthedHandler,
} from "#shared/app-forms.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import { writeRowInTransaction } from "#shared/db/client.ts";
import { getAllListings } from "#shared/db/listings/records.ts";
import { getAllModifiers } from "#shared/db/modifiers.ts";
import {
  type Answer,
  isQuestionDisplayType,
  QUESTION_DISPLAY_TYPES,
  type QuestionWithAnswers,
  questionDisplayTypeError,
  requireQuestionDisplayType,
} from "#shared/db/question-types.ts";
import {
  ANSWER_AGGREGATE_FIELDS,
  type AnswerAggregateValues,
  getAnswerAggregateRecalculation,
  getAnswerModifierId,
  getAnswerSelectionTotals,
  resetAnswerAggregateFields,
  setAnswerModifier,
  updateAnswerAggregateValues,
} from "#shared/db/questions/aggregates.ts";
import { deleteAnswer, deleteQuestion } from "#shared/db/questions/delete.ts";
import { findAnswerById } from "#shared/db/questions/parsing.ts";
import {
  getAllQuestionsWithAnswers,
  getQuestionWithAnswers,
  listingQuestions,
  questionListings,
} from "#shared/db/questions/queries.ts";
import {
  assignNextQuestionSortOrder,
  getNextAnswerSortOrder,
  swapAnswerOrder,
  swapQuestionOrder,
} from "#shared/db/questions/sort-order.ts";
import { answersTable, questionsTable } from "#shared/db/questions/tables.ts";
import { getFlash } from "#shared/flash-context.ts";
import { defineForm } from "#shared/forms/definition.ts";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import type { ResponseHandler } from "#shared/response-steps.ts";
import type { AdminSession, ListingWithCount } from "#shared/types.ts";
import {
  type AnswerModifierOption,
  adminAnswerDeletePage,
  adminAnswerEditPage,
  adminAnswerRecalculatePage,
  adminQuestionDeletePage,
  adminQuestionPage,
  adminQuestionsPage,
  questionTextFlat,
} from "#templates/admin/questions.tsx";
import { formattingHint } from "#templates/components/formatting-hint.ts";
import { getAnswerAggregateFields } from "#templates/fields/aggregate.ts";

/* jscpd:ignore-end */
import { createListingChoicePost } from "./listing-choice-post.ts";

export const questionTextForm = defineForm({
  fields: [
    {
      hintHtml: `Shown to attendees above the answer field. ${formattingHint()}`,
      label: "Question text",
      markdown: true,
      maxlength: MAX_TEXTAREA_LENGTH,
      name: "text",
      placeholder: "e.g. What is your T-shirt size?",
      required: true,
      type: "textarea",
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
  const [questions, allListings] = await Promise.all([
    getAllQuestionsWithAnswers(),
    getAllListings(),
  ]);
  const questionListingIds = await questionListings.getIdsByKeys(
    questions.map((question) => question.id),
  );
  // Resolve listing ids to their decrypted names for the Listings column,
  // dropping any ids whose listing has since been deleted (listing_questions
  // rows are not pruned on listing deletion, so orphans can linger).
  const nameById = mapBy(
    "id",
    (listing: ListingWithCount) => listing.name,
  )(allListings);
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
      questionListings.getIds(q.id),
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
  await writeRowInTransaction(
    await questionsTable.updateStatement!(id, { assignAll }),
    id,
    (tx) => questionListings.setIdsTx(tx, id, listingIds),
  );
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
  // The confirmation page shows the flattened text (newlines → " / "), and a
  // single-line input can't carry the raw newlines, so verify against the same
  // flattened form the operator can actually type.
  identifier: (q) => questionTextFlat(q.text),
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
): ReturnType<typeof answerHandlers.get> =>
  answerHandlers.get(({ answer, question }, session) =>
    render(question, answer, session, getFlash()),
  );

/** Handle GET /admin/questions/:id/answers/:answerId/delete */
const handleDeleteAnswerGet = answerFlashRoute(
  (question, answer, session, flash) =>
    htmlResponse(adminAnswerDeletePage(question, answer, session, flash.error)),
);

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

/** Map the validated aggregate form values onto the stored aggregate columns. */
const extractAnswerAggregateValues = (
  values: AnswerAggregateValues,
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
      await updateAnswerAggregateValues(answer.id, aggregates.input);
    }
    await logActivity(`Answer '${text}' updated in question ${question.id}`);
    return redirect(`/admin/questions/${question.id}`, "Answer updated", true);
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
      reset: (selected) => resetAnswerAggregateFields(answer.id, selected),
      successMessage: t("questions.recalculate.success"),
      successPath: editAnswerPath(params),
    }),
);

/** Factory for move-up/move-down handlers */
const moveAnswerHandler = (dir: "up" | "down") =>
  answerHandlers.post(async ({ answer, question }) => {
    const pair = planReorder(
      question.answers.map((a) => a.id),
      answer.id,
      dir,
    );
    if (pair) await swapAnswerOrder(pair[0], pair[1]);
    return redirect(`/admin/questions/${question.id}`, "Answer moved", true);
  });

/** Handle POST /admin/questions/:id/answers/:answerId/move-up */
const handleMoveAnswerUp = moveAnswerHandler("up");

/** Handle POST /admin/questions/:id/answers/:answerId/move-down */
const handleMoveAnswerDown = moveAnswerHandler("down");

/** Factory for question move-up/move-down handlers. Swaps the question's
 * global sort_order with its neighbour in the ordered list. */
const moveQuestionHandler = (dir: "up" | "down") =>
  createAuthedHandler<QuestionIdParams, QuestionWithAnswers>({
    auth: OWNER_FORM,
    handle: async ({ context: question }) => {
      const all = await getAllQuestionsWithAnswers();
      const pair = planReorder(
        all.map((q) => q.id),
        question.id,
        dir,
      );
      if (pair) await swapQuestionOrder(pair[0], pair[1]);
      return redirect("/admin/questions", "Question moved", true);
    },
    loadContext: ({ id }) => getQuestionWithAnswers(id),
  });

/** Handle POST /admin/questions/:id/move-up */
const handleMoveQuestionUp = moveQuestionHandler("up");

/** Handle POST /admin/questions/:id/move-down */
const handleMoveQuestionDown = moveQuestionHandler("down");

const handleListingQuestionsPost = createListingChoicePost({
  fieldName: "question_ids",
  label: "Questions",
  noun: "question",
  saveIds: listingQuestions.setIds,
  tab: "questions",
});

/** Questions routes */
export const adminHandlers = handlersFor("questions")({
  getQuestions: handleQuestionsGet,
  getQuestionsById: handleQuestionGet,
  getQuestionsByIdAnswersByAnswerIdDelete: handleDeleteAnswerGet,
  getQuestionsByIdAnswersByAnswerIdEdit: handleEditAnswerGet,
  getQuestionsByIdAnswersByAnswerIdRecalculate: handleAnswerRecalculateGet,
  getQuestionsByIdDelete: (request, { id }) => questionDelete.get(request, id),
  postListingByIdQuestions: handleListingQuestionsPost,
  postQuestions: handleQuestionsPost,
  postQuestionsByIdAnswers: handleAddAnswer,
  postQuestionsByIdAnswersByAnswerIdDelete: handleDeleteAnswerPost,
  postQuestionsByIdAnswersByAnswerIdEdit: handleEditAnswerPost,
  postQuestionsByIdAnswersByAnswerIdMoveDown: handleMoveAnswerDown,
  postQuestionsByIdAnswersByAnswerIdMoveUp: handleMoveAnswerUp,
  postQuestionsByIdAnswersByAnswerIdRecalculate: handleAnswerRecalculatePost,
  postQuestionsByIdDelete: (request, { id }) =>
    questionDelete.post(request, id),
  postQuestionsByIdEdit: handleQuestionEdit,
  postQuestionsByIdListings: handleQuestionListings,
  postQuestionsByIdMoveDown: handleMoveQuestionDown,
  postQuestionsByIdMoveUp: handleMoveQuestionUp,
});
