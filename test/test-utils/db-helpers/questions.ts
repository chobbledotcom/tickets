/** Question and answer fixtures shared by the booking suites. */

import { questionListings } from "#db/questions/queries.ts";
import { answersTable, questionsTable } from "#db/questions/tables.ts";

/** A radio question with one chosen answer, optionally assigned to listings —
 * the smallest question a booking can answer. */
export const createQuestionWithAnswer = async (
  assignedTo: number[] = [],
): Promise<{ answerId: number; questionId: number }> => {
  const question = await questionsTable.insert({
    displayType: "radio",
    text: "Choose one",
  });
  const answer = await answersTable.insert({
    questionId: question.id,
    sortOrder: 0,
    text: "Chosen",
  });
  if (assignedTo.length > 0) {
    await questionListings.setIds(question.id, assignedTo);
  }
  return { answerId: answer.id, questionId: question.id };
};
