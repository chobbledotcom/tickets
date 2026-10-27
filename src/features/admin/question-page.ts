/**
 * The tabbed /admin/questions/:id entity page. The Overview tab carries the
 * edit form, the answers, and the listings assignment. The Actions tab holds
 * the type-the-name delete.
 */

import { getAllListings } from "#db/listings/records.ts";
import type { QuestionWithAnswers } from "#db/question-types.ts";
import { getAnswerSelectionTotals } from "#db/questions/aggregates.ts";
import {
  getQuestionWithAnswers,
  questionListings,
} from "#db/questions/queries.ts";
import {
  customSection,
  defineEntityPage,
  deleteActionTab,
  type EntityPage,
  type SlotLoader,
  type TabDef,
} from "#routes/admin/entity-pages.ts";
import { adminPattern } from "#shared/admin-surface.ts";
import {
  QuestionAnswersSection,
  QuestionEditPanel,
  QuestionListingsSection,
} from "#templates/admin/question-detail.tsx";
import { questionTextFlat } from "#templates/admin/questions.tsx";

const loadEditPanel: SlotLoader<QuestionWithAnswers> = (question) =>
  Promise.resolve(QuestionEditPanel({ question }));

const loadAnswersPanel: SlotLoader<QuestionWithAnswers> = async (question) =>
  QuestionAnswersSection({
    answerCounts: await getAnswerSelectionTotals(question.id),
    question,
  });

const loadListingsPanel: SlotLoader<QuestionWithAnswers> = async (question) => {
  const [allListings, assignedListingIds] = await Promise.all([
    getAllListings(),
    questionListings.getIds(question.id),
  ]);
  return QuestionListingsSection({
    allListings,
    assignedListingIds: new Set(assignedListingIds),
    question,
  });
};

const overviewTab: TabDef<QuestionWithAnswers> = {
  labelKey: "entity.tab.overview",
  sections: [
    customSection(loadEditPanel),
    customSection(loadAnswersPanel),
    customSection(loadListingsPanel),
  ],
  slug: "",
};

/** The tabbed question page. */
export const questionPage: EntityPage<QuestionWithAnswers> = defineEntityPage({
  destination: "question",
  load: (id) => getQuestionWithAnswers(id),
  navActive: { section: adminPattern("questions") },
  recordId: (question) => question.id,
  tabs: [
    overviewTab,
    deleteActionTab("questions.delete.submit", "questionDelete"),
  ],
  titleOf: (question) => questionTextFlat(question.text),
});
