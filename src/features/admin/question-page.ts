/**
 * The tabbed /admin/questions/:id entity page. The banner holds the question's
 * notes, so a note never hides behind one tab. The Overview tab carries the
 * edit form, the answers, and the listings assignment. The Actions tab holds
 * the type-the-name delete.
 */

import { addNoteImageUrls } from "#db/image-urls.ts";
import { getAllListings } from "#db/listings/records.ts";
import { getNotesFor } from "#db/notes/queries.ts";
import { questionNotes } from "#db/notes/target.ts";
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
import { withReturnUrl } from "#shared/return-url-field.tsx";
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";
import {
  addNoteLinkProse,
  NotesSection,
} from "#templates/admin/attendee-notes.tsx";
import {
  QuestionAnswersSection,
  QuestionEditPanel,
  QuestionListingsSection,
} from "#templates/admin/question-detail.tsx";
import { questionTextFlat } from "#templates/admin/questions.tsx";
import { isOwnerRole } from "#types";

/** The question page is owner-only (matching the route's OWNER_AUDIENCE), so
 * the note pages highlight the Questions section. */
const questionUrl = (questionId: number): string =>
  `/admin/questions/${questionId}`;

/** One note's are-you-sure delete URL, returning to the question page. */
const noteDeleteUrl = (note: { entity_id: number; id: number }): string =>
  withReturnUrl(
    `/admin/questions/${note.entity_id}/note/${note.id}/delete`,
    questionUrl(note.entity_id),
  );

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

const loadNotesPanel: SlotLoader<QuestionWithAnswers> = async (
  question,
  ctx,
) => {
  const notes = await getNotesFor(
    questionNotes(question.id),
    await requireRequestPrivateKey(),
  );
  await addNoteImageUrls(notes);
  return NotesSection({
    deleteHref: noteDeleteUrl,
    isOwner: isOwnerRole(ctx.session.adminLevel),
    notes,
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
  banner: loadNotesPanel,
  destination: "question",
  load: (id) => getQuestionWithAnswers(id),
  navActive: { section: adminPattern("questions") },
  proseExtra: ({ id }) =>
    addNoteLinkProse(
      withReturnUrl(`/admin/questions/${id}/note`, questionUrl(id)),
    ),
  tabs: [
    overviewTab,
    deleteActionTab(
      "questions.delete.submit",
      (question) => `${questionUrl(question.id)}/delete`,
    ),
  ],
  titleOf: (question) => questionTextFlat(question.text),
});
