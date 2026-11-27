/**
 * The bookings that answered a question: the read side of the
 * `attendee_answers` link. One row per stored answer, newest booking first. A
 * booking answer gives one row for the booking. A line question gives one row
 * for each line or ticket that it asks, and the row names its line. A choice
 * answer names its answer row. A free-text answer carries the decrypted words
 * the buyer typed.
 */

import { decryptWithOwnerKey } from "#crypto/hybrid.ts";

import type { OwnerKeyEncrypted } from "#crypto/sealed.ts";
import { queryAll } from "#db/client.ts";
import { pickedColumns } from "#db/picked-columns.ts";
import { tableNode } from "#db/select/query.ts";
import { tables } from "#db/select/tables.ts";
import { sql } from "#db/sql.ts";
import { mapParallel } from "#fp";
import { ascending } from "#types";

/** The fields a stored answer row and its API answer share: the booking, the
 *  chosen answer row, and the answer's stored text. */
type BookingAnswerFields = {
  answer_id: number | null;
  answer_text: string | null;
  attendee_id: number;
  created: string;
};

/** The booking line that holds a line answer, and which ticket of it. */
type AnswerLine = {
  listing_id: number;
  package_group_id: number;
  parent_listing_id: number;
  start_at: string | null;
  ticket: number;
};

/** One stored answer row, joined onto its booking and its answer text. The
 *  line columns are null for an answer that belongs to the booking. */
type QuestionBookingRow = BookingAnswerFields & {
  encrypted_text: OwnerKeyEncrypted | null;
  line_listing_id: number | null;
  line_package_group_id: number | null;
  line_parent_listing_id: number | null;
  line_start_at: string | null;
  listing_ids: string | null;
  unit_index: number;
};

/** One booking that answered a question, as the admin API answers with it.
 *  A choice answer fills `answer_id` and `answer_text`. A free-text answer
 *  fills `free_text`. `line` names the booking line of a line answer, and is
 *  null for an answer to the booking. The route serialises this shape, so the
 *  type stays here beside the read that makes it. */
type QuestionBooking = BookingAnswerFields & {
  free_text: string | null;
  line: AnswerLine | null;
  listing_ids: number[];
  question_id: number;
};

/** The line that a stored answer belongs to, or null for a booking answer. */
const lineOfRow = (row: QuestionBookingRow): AnswerLine | null =>
  row.line_listing_id === null
    ? null
    : {
        listing_id: row.line_listing_id,
        package_group_id: row.line_package_group_id!,
        parent_listing_id: row.line_parent_listing_id!,
        start_at: row.line_start_at,
        ticket: row.unit_index,
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
  const answer = pickedColumns({
    answer_text: tableNode(tables.answers, "answer").text,
  });
  const rows = await queryAll<QuestionBookingRow>(
    answer.decoded(
      sql`SELECT attendee_answer.attendee_id,
            attendee_answer.answer_id,
            ${answer.list},
            string.encrypted_text,
            line.listing_id AS line_listing_id,
            line.package_group_id AS line_package_group_id,
            line.parent_listing_id AS line_parent_listing_id,
            line.start_at AS line_start_at,
            attendee_answer.unit_index,
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
       LEFT JOIN listing_attendees AS line
         ON line.id = attendee_answer.booking_row_id
      WHERE attendee_answer.question_id = ${questionId}
      ORDER BY attendee.created DESC, attendee_answer.attendee_id DESC,
        line.id, attendee_answer.unit_index`,
    ),
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
      answer_text: row.answer_text,
      attendee_id: row.attendee_id,
      created: row.created,
      free_text:
        row.encrypted_text === null
          ? null
          : await decryptWithOwnerKey(row.encrypted_text, privateKey),
      line: lineOfRow(row),
      listing_ids: listingIds,
      question_id: questionId,
    };
  })(rows);
};
