/**
 * Owner notes on a custom question. Questions are owner-only records, and the
 * add/delete note routes follow the shared record-notes shape. The questions
 * route table binds them under the question paths.
 */

import { getQuestionWithAnswers } from "#db/questions/queries.ts";
import { adminPattern } from "#shared/admin-surface.ts";
import { questionTextFlat } from "#templates/admin/questions.tsx";
import { recordNoteRoutes } from "./record-notes.ts";

/** The question's add/delete note routes. */
export const questionNoteRoutes = recordNoteRoutes({
  activeSection: adminPattern("questions"),
  // Questions are owner-only records, so their note routes are too. The
  // staff-generic default widens the question page's own audience floor.
  auth: "owner",
  entityKind: "question",
  loadRecord: (id) => getQuestionWithAnswers(id),
  nameOf: (question) => questionTextFlat(question.text),
  noteBasePath: (id) => `/admin/questions/${id}/note`,
  recordPagePath: (id) => `/admin/questions/${id}`,
});
