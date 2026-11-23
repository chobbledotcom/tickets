import { getAllListings } from "#db/listings/records.ts";
import { getAttendeeLineAnswers } from "#db/questions/attendee-answers/reads.ts";
import { getAllQuestionsWithAnswers } from "#db/questions/queries.ts";
import { fieldById, requiredMapValue } from "#fp";
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";

export type LineAnswerRow = {
  answer: string;
  listingName: string;
  question: string;
};

/** The attendee's answers for each booked listing. A deleted question or
 * listing takes its answers, so each answer here names both. */
export const loadLineAnswerRows = async (
  attendeeId: number,
): Promise<LineAnswerRow[]> => {
  const answers = await getAttendeeLineAnswers(
    attendeeId,
    requireRequestPrivateKey,
  );
  if (answers.length === 0) return [];
  const [questions, listings] = await Promise.all([
    getAllQuestionsWithAnswers(),
    getAllListings(),
  ]);
  const questionById = fieldById("text")(questions);
  const listingById = fieldById("name")(listings);
  return answers.map((answer) => ({
    answer: answer.text,
    listingName: requiredMapValue(listingById, answer.listingId),
    question: requiredMapValue(questionById, answer.questionId),
  }));
};
