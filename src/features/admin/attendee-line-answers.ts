import { getAllGroupNames } from "#db/groups.ts";
import { getAllListings } from "#db/listings/records.ts";
import {
  getAttendeeLineAnswers,
  type TicketScope,
} from "#db/questions/attendee-answers/reads.ts";
import {
  lineLabel,
  namesWithMissing,
  ticketAnswerName,
} from "#db/questions/line-answers.ts";
import { getAllQuestionsWithAnswers } from "#db/questions/queries.ts";
import { requiredMapValue } from "#fp";
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";
import { questionTextFlat } from "#templates/admin/questions.tsx";

/** One answer as the attendee page shows it: the stored answer, what it
 * answers, and the answer. */
export type LineAnswerRow = {
  answer: string;
  id: number;
  name: string;
};

/** The attendee's answers for each line and ticket in `scope`. A deleted
 * question or line takes its answers, so each answer here names both. */
export const loadLineAnswerRows = async (
  attendeeId: number,
  scope: TicketScope,
): Promise<LineAnswerRow[]> => {
  const answers = await getAttendeeLineAnswers(
    attendeeId,
    requireRequestPrivateKey,
    scope,
  );
  if (answers.length === 0) return [];
  const [questions, listings, packages] = await Promise.all([
    getAllQuestionsWithAnswers(),
    getAllListings(),
    getAllGroupNames(),
  ]);
  const questionById = new Map(questions.map((q) => [q.id, q]));
  const names = {
    listings: namesWithMissing(
      new Map(listings.map((listing) => [listing.id, listing.name])),
      answers.map((answer) => answer.parentListingId),
    ),
    packages: namesWithMissing(
      packages,
      answers.map((answer) => answer.packageGroupId),
    ),
  };
  return answers.map((answer) => {
    const question = requiredMapValue(questionById, answer.questionId);
    return {
      answer: answer.text,
      id: answer.id,
      name: ticketAnswerName(
        { ...question, text: questionTextFlat(question.text) },
        lineLabel(answer, names),
        answer.unit,
      ),
    };
  });
};
