/**
 * The bookings that answered a question: the read side of the
 * `attendee_answers` link. One row per booking, newest booking first, with the
 * answer that booking gave. A choice answer names its answer row. A free-text
 * answer carries the decrypted words the buyer typed.
 */

import { decryptWithOwnerKey } from "#crypto/hybrid.ts";

import type { OwnerKeyEncrypted } from "#crypto/sealed.ts";
import { queryAll } from "#db/client.ts";
import { answersTable } from "#db/questions/tables.ts";
import { mapParallel } from "#fp";
import { ascending } from "#types";
import { sql } from "#db/sql.ts";

/** The fields a stored answer row and its API answer share: the booking, the
 *  chosen answer row, and the answer's stored text. */
type BookingAnswerFields = {
  answer_id: number | null;
  answer_text: string | null;
  attendee_id: number;
  created: string;
};

/** One stored answer row, joined onto its booking and its answer text. */
type QuestionBookingRow = BookingAnswerFields & {
  encrypted_text: OwnerKeyEncrypted | null;
  listing_ids: string | null;
};

/** One booking that answered a question, as the admin API answers with it.
 *  A choice answer fills `answer_id` and `answer_text`. A free-text answer
 *  fills `free_text`. The route serialises this shape, so the type stays here
 *  beside the read that makes it. */
type QuestionBooking = BookingAnswerFields & {
  free_text: string | null;
  listing_ids: number[];
  question_id: number;
};

/**
 * Every booking that answered a question, newest booking first. Free text is
 * decrypted with the request's owner key, so the answer holds the words the
 * buyer typed. Owner-only callers hold that key.
 */
export const getQuestionBookings = async (
  questionId: number,
  privateKey: CryptoKey,
): Promise<QuestionBooking[]> => {
  const rows = await queryAll<QuestionBookingRow>(
    sql`SELECT attendee_answer.attendee_id,
            attendee_answer.answer_id,
            answer.text AS answer_text,
            string.encrypted_text,
            attendee.created,
            (SELECT GROUP_CONCAT(DISTINCT listingAttendee.listing_id)
               FROM listing_attendees AS listingAttendee
              WHERE listingAttendee.attendee_id = attendee_answer.attendee_id)
              AS listing_ids
       FROM attendee_answers AS attendee_answer
       JOIN attendees AS attendee
         ON attendee.id = attendee_answer.attendee_id
       LEFT JOIN answers AS answer
         ON answer.id = attendee_answer.answer_id
       LEFT JOIN strings AS string
         ON string.id = attendee_answer.string_id
      WHERE attendee_answer.question_id = ${questionId}
      ORDER BY attendee.created DESC, attendee_answer.attendee_id DESC`,
  );
  return mapParallel(async (row: QuestionBookingRow) => {
    // The booking's listing ids read back from the comma-separated
    // GROUP_CONCAT column, in ascending order.
    const listingIds =
      row.listing_ids === null
        ? []
        : row.listing_ids.split(",").map(Number).sort(ascending);
    return {
      answer_id: row.answer_id,
      answer_text:
        row.answer_text === null
          ? null
          : await answersTable.readColumn("text", row.answer_text),
      attendee_id: row.attendee_id,
      created: row.created,
      free_text:
        row.encrypted_text === null
          ? null
          : await decryptWithOwnerKey(row.encrypted_text, privateKey),
      listing_ids: listingIds,
      question_id: questionId,
    };
  })(rows);
};
