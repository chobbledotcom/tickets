/**
 * Admin routes for custom questions management (owner-only). The question
 * record owns the write rule and the audience. The answer surfaces stay
 * child routes.
 */

import { logActivity } from "#db/activity-log.ts";
import { getAllListings } from "#db/listings/records.ts";
import { flatCollectionSwap } from "#db/ordered-collection.ts";
import {
  type QuestionWithAnswers,
  requireQuestionDisplayType,
} from "#db/question-types.ts";
import {
  getAllQuestionsWithAnswers,
  getQuestionWithAnswers,
  listingQuestions,
  questionListings,
} from "#db/questions/queries.ts";
import { questionsOrder, questionsTable } from "#db/questions/tables.ts";
import { writeRowInTransaction } from "#db/row-write.ts";
import { fieldById, mapNotNullish } from "#fp";
import { t } from "#i18n";
import {
  defineAdminRoutes,
  orderRoutes,
  recordRoutes,
} from "#routes/admin/route-tables.ts";
import { formPolicyFor } from "#routes/auth.ts";
import { entityFormById } from "#routes/entity.ts";
import { notFoundResponse, redirect } from "#routes/response.ts";
import { adminDestinationAt } from "#shared/admin-surface.ts";
import { createOrderedCollectionHandlers } from "#shared/app-forms.ts";
import { getFlash } from "#shared/flash-context.ts";
import { questionRecord } from "#shared/records/questions.ts";
import { recordPages } from "#shared/rest/record-pages.ts";
import {
  adminQuestionDeletePage,
  adminQuestionsPage,
  questionTextFlat,
} from "#templates/admin/questions.tsx";
import type { AdminSession } from "#types";
import { createListingChoicePost } from "./listing-choice-post.ts";
import { questionPage } from "./question-page.ts";
import { answerRoutes, type QuestionIdParams } from "./questions/answers.ts";
import { questionTextForm } from "./questions/forms.ts";

/** The list renderer also resolves each question's listing ids to their
 * decrypted names. Ids whose listing has since been deleted are dropped:
 * listing_questions rows are not pruned on listing deletion, so orphans can
 * linger. */
const renderList = async (
  questions: QuestionWithAnswers[],
  session: AdminSession,
): Promise<string> => {
  const allListings = await getAllListings();
  const questionListingIds = await questionListings.getIdsByKeys(
    questions.map((question) => question.id),
  );
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
    getFlash().error,
    listingNames,
    allListings.length,
  );
};

const pages = recordPages(questionRecord, {
  createErrorPath: "/admin/questions",
  editErrorPath: (id) => `/admin/questions/${id}`,
  form: questionTextForm,
  identifier: (question) => questionTextFlat(question.text),
  renderDelete: adminQuestionDeletePage,
  renderList,
  toInput: ({ display_type, text }) => ({
    displayType: requireQuestionDisplayType(display_type),
    text,
  }),
});

/** Handle POST /admin/questions/:id/listings (assign question to listings) */
const handleQuestionListings = entityFormById(
  "/admin/questions/:id/listings",
  async (id, _session, form) => {
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
    return redirect(
      `/admin/questions/${id}`,
      t("questions.listings_updated"),
      true,
    );
  },
);

const questionOrder = createOrderedCollectionHandlers({
  auth: formPolicyFor(adminDestinationAt("/admin/questions/:id/move-up")),
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
  pattern: "/admin/listing/:id/questions",
  saveIds: listingQuestions.setIds,
  tab: "questions",
});

/** Questions routes */
export const adminHandlers = defineAdminRoutes({
  ...recordRoutes("questions", pages, questionPage),
  ...answerRoutes,
  "POST /admin/listing/:id/questions": handleListingQuestionsPost,
  "POST /admin/questions/:id/listings": handleQuestionListings,
  ...orderRoutes("/admin/questions/:id", questionOrder),
});
