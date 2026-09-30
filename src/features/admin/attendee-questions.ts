/** The custom questions an attendee's listings ask, and its answers. */

import type { ExistingLine } from "#db/attendees/atomic-update.ts";
import type { SelectedQuestionAnswers } from "#db/question-types.ts";
import { getBookedAnswers } from "#db/questions/attendee-answers/at-booking.ts";
import {
  getAttendeeTextAnswers,
  loadAttendeeQuestionData,
} from "#db/questions/attendee-answers/reads.ts";
import { unique } from "#fp";
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";

/** The empty question/answer set: no questions and nothing picked. A fresh
 * object each call, so callers can safely hold their own copy. */
export const emptySelectedQuestionAnswers = (): SelectedQuestionAnswers => ({
  atBooking: [],
  questions: [],
  selectedAnswerIds: [],
  selectedTextAnswers: new Map(),
});

/** Load custom questions + currently-selected answers across ALL of the
 * attendee's booked listings, and its answers at booking. The request's
 * private key is only derived when there is free text to decrypt. */
export const loadQuestionsForExisting = async (
  attendeeId: number,
  existing: ExistingLine[],
): Promise<SelectedQuestionAnswers> => {
  const listingIds = unique(existing.map((e) => e.booking.listing_id));
  const [data, atBooking] = await Promise.all([
    loadAttendeeQuestionData(listingIds, [attendeeId]),
    getBookedAnswers(attendeeId, requireRequestPrivateKey),
  ]);
  if (!data) return { ...emptySelectedQuestionAnswers(), atBooking };
  return {
    atBooking,
    questions: data.questions,
    selectedAnswerIds: data.attendeeAnswerMap.get(attendeeId) ?? [],
    selectedTextAnswers: await getAttendeeTextAnswers(
      attendeeId,
      await requireRequestPrivateKey(),
    ),
  };
};
