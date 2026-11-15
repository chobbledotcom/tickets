/** Question and answer fixtures shared by the booking suites. */

import { queryAll } from "#db/client.ts";
import { questionListings } from "#db/questions/queries.ts";
import { answersTable, questionsTable } from "#db/questions/tables.ts";
import { sql } from "#db/sql.ts";

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

/** A free-text question assigned to listings — the smallest question a
 * buyer can type an answer into. */
export const createFreeTextQuestion = async (
  assignedTo: number[] = [],
): Promise<number> => {
  const question = await questionsTable.insert({
    displayType: "free_text",
    text: "Anything else?",
  });
  if (assignedTo.length > 0) {
    await questionListings.setIds(question.id, assignedTo);
  }
  return question.id;
};

/** The used_count of every interned string, in id order. The trigger keeps
 *  this column, so a save that interns or releases a string moves it. */
export const stringUsedCounts = async (): Promise<number[]> =>
  (
    await queryAll<{ used_count: number }>(sql`SELECT used_count FROM strings`)
  ).map((row) => row.used_count);
