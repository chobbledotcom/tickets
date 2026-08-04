import { defineRoutes } from "#routes/router.ts";
/**
 * Admin routes for custom questions management (owner-only)
 */

import { fieldById, mapNotNullish } from "#fp";
import { createConfirmedHandlers } from "#routes/admin/confirmation.ts";
import { OWNER_FORM, ownerPage } from "#routes/auth.ts";
import { idRouteFor, ownerFormById, ownerGetById } from "#routes/entity.ts";
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
import { logActivity } from "#shared/db/activity-log.ts";
import { writeRowInTransaction } from "#shared/db/client.ts";
import { getAllListings } from "#shared/db/listings/records.ts";
import { flatCollectionSwap } from "#shared/db/ordered-collection.ts";
import {
  type QuestionWithAnswers,
  requireQuestionDisplayType,
} from "#shared/db/question-types.ts";
import { getAnswerSelectionTotals } from "#shared/db/questions/aggregates.ts";
import { deleteQuestion } from "#shared/db/questions/delete.ts";
import {
  getAllQuestionsWithAnswers,
  getQuestionWithAnswers,
  listingQuestions,
  questionListings,
} from "#shared/db/questions/queries.ts";
import { questionsOrder, questionsTable } from "#shared/db/questions/tables.ts";
import { getFlash } from "#shared/flash-context.ts";
import {
  adminQuestionDeletePage,
  adminQuestionPage,
  adminQuestionsPage,
  questionTextFlat,
} from "#templates/admin/questions.tsx";

/* jscpd:ignore-end */
import { createListingChoicePost } from "./listing-choice-post.ts";
import {
  answerOrder,
  handleAddAnswer,
  handleAnswerRecalculateGet,
  handleAnswerRecalculatePost,
  handleDeleteAnswerGet,
  handleDeleteAnswerPost,
  handleEditAnswerGet,
  handleEditAnswerPost,
  type QuestionIdParams,
  redirectToQuestion,
} from "./questions/answers.ts";
import { questionTextForm } from "./questions/forms.ts";

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
  const nameById = fieldById("name")(allListings);
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
    const displayType = requireQuestionDisplayType(display_type);
    // One transaction: a question must never exist without its order entry
    // or its log line.
    const questionId = await writeRowInTransaction(
      await questionsTable.insertStatement({ displayType, text }),
      null,
      async (transaction, id) => {
        await questionsOrder.append({ key: id, transaction });
        await logActivity(
          `Question '${text}' created`,
          undefined,
          undefined,
          transaction,
        );
      },
    );
    return redirect(`/admin/questions/${questionId}`, "Question created", true);
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
    await questionsTable.updateStatement(id, { assignAll }),
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

const questionOrder = createOrderedCollectionHandlers({
  auth: OWNER_FORM,
  keys: async () =>
    (await getAllQuestionsWithAnswers()).map((question) => question.id),
  loadContext: ({ id }: QuestionIdParams) => getQuestionWithAnswers(id),
  movedMessage: "Question moved",
  redirectPath: () => "/admin/questions",
  swap: flatCollectionSwap(questionsOrder),
  target: ({ context }) => context.id,
});

const handleListingQuestionsPost = createListingChoicePost({
  feature: "questions",
  fieldName: "question_ids",
  label: "Questions",
  noun: "question",
  saveIds: listingQuestions.setIds,
  tab: "questions",
});

/** Questions routes */
export const adminHandlers = defineRoutes({
  "GET /admin/questions": handleQuestionsGet,
  "GET /admin/questions/:id": handleQuestionGet,
  "GET /admin/questions/:id/answers/:answerId/delete": handleDeleteAnswerGet,
  "GET /admin/questions/:id/answers/:answerId/edit": handleEditAnswerGet,
  "GET /admin/questions/:id/answers/:answerId/recalculate":
    handleAnswerRecalculateGet,
  "GET /admin/questions/:id/delete": idRouteFor(questionDelete.get),
  "POST /admin/listing/:id/questions": handleListingQuestionsPost,
  "POST /admin/questions": handleQuestionsPost,
  "POST /admin/questions/:id/answers": handleAddAnswer,
  "POST /admin/questions/:id/answers/:answerId/delete": handleDeleteAnswerPost,
  "POST /admin/questions/:id/answers/:answerId/edit": handleEditAnswerPost,
  "POST /admin/questions/:id/answers/:answerId/move-down": answerOrder.down,
  "POST /admin/questions/:id/answers/:answerId/move-up": answerOrder.up,
  "POST /admin/questions/:id/answers/:answerId/recalculate":
    handleAnswerRecalculatePost,
  "POST /admin/questions/:id/delete": idRouteFor(questionDelete.post),
  "POST /admin/questions/:id/edit": handleQuestionEdit,
  "POST /admin/questions/:id/listings": handleQuestionListings,
  "POST /admin/questions/:id/move-down": questionOrder.down,
  "POST /admin/questions/:id/move-up": questionOrder.up,
});
