/** The answers an attendee gave to questions that ask once for each listing. */

import { getAllListings } from "#db/listings/records.ts";
import { getAttendeeLineAnswers } from "#db/questions/attendee-answers/reads.ts";
import { getAllQuestionsWithAnswers } from "#db/questions/queries.ts";
import { fieldById, requiredMapValue } from "#fp";
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";

/** One answer, with the question and the listing it answers named. */
export type LineAnswerRow = {
  answer: string;
  listingName: string;
  question: string;
};

/** The attendee's answers for each booked listing, in question order. The
 * answers of a deleted question or listing go with it, so every answer read
 * here names a question and a listing that still exist. */
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
    listingName: requiredMapValue(
      listingById,
      answer.listingId,
      `Listing ${answer.listingId} missing`,
    ),
    question: requiredMapValue(
      questionById,
      answer.questionId,
      `Question ${answer.questionId} missing`,
    ),
  }));
};
