/**
 * One booking that answered a question, as the admin API and the db read both
 * answer it. Both reads answer the same row, so the expected row is built in
 * one place here instead of being spelled out again in each test.
 */

/** One booking that answered a question, as both reads answer it. A choice
 *  answer fills `answer_id` and `answer_text`. A free-text answer fills
 *  `free_text` and leaves the answer fields null. */
export type QuestionBooking = {
  answer_id: number | null;
  answer_text: string | null;
  attendee_id: number;
  created: string;
  free_text: string | null;
  listing_ids: number[];
  question_id: number;
};

/** The choice answer one booking gave, with the text that answer option
 *  holds. */
export type ChosenAnswer = { id: number; text: string };

/**
 * The row one booking must answer with, for a question read that answers the
 * booking of `attendeeId` at `created`, covering `listingIds`. A choice answer
 * fills the answer fields; a free-text answer fills `freeText` instead and
 * leaves them null.
 */
export const questionBookingRow = (
  questionId: number,
  attendeeId: number,
  created: string,
  listingIds: number[],
  answer: ChosenAnswer | null,
  freeText: string | null = null,
): QuestionBooking => ({
  answer_id: answer?.id ?? null,
  answer_text: answer?.text ?? null,
  attendee_id: attendeeId,
  created,
  free_text: freeText,
  listing_ids: listingIds,
  question_id: questionId,
});
