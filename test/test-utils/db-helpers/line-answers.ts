/** Reads every answer stored for a booking line straight from the tables: one
 * for each row and ticket, with no merging of rows that say the same. */

import { decryptWithOwnerKey } from "#crypto/hybrid.ts";
import type { OwnerKeyEncrypted } from "#crypto/sealed.ts";
import { queryAll } from "#db/client.ts";
import { sql } from "#db/sql.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";

/** One stored answer: the question, the line and ticket it answers, and the
 * words. */
export type StoredLineAnswer = {
  listingId: number;
  packageGroupId: number;
  parentListingId: number;
  questionId: number;
  text: string;
  unit: number;
};

/** The attendee's line answers, one for each row and ticket, in question,
 * then line, then ticket order. */
export const readStoredLineAnswers = async (
  attendeeId: number,
): Promise<StoredLineAnswer[]> => {
  const rows = await queryAll<{
    encrypted_text: OwnerKeyEncrypted;
    listing_id: number;
    package_group_id: number;
    parent_listing_id: number;
    question_id: number;
    unit_index: number;
  }>(
    sql`SELECT row.listing_id, row.parent_listing_id, row.package_group_id,
           given.question_id, given.unit_index, text.encrypted_text
          FROM attendee_answers AS given
          JOIN listing_attendees AS row ON row.id = given.booking_row_id
          JOIN strings AS text ON text.id = given.string_id
         WHERE given.attendee_id = ${attendeeId}
         ORDER BY given.question_id, row.listing_id, row.id, given.unit_index`,
  );
  const key = await getTestPrivateKey();
  const stored: StoredLineAnswer[] = [];
  for (const row of rows) {
    stored.push({
      listingId: row.listing_id,
      packageGroupId: row.package_group_id,
      parentListingId: row.parent_listing_id,
      questionId: row.question_id,
      text: await decryptWithOwnerKey(row.encrypted_text, key),
      unit: row.unit_index,
    });
  }
  return stored;
};

/** How many answers each booking row of the attendee holds, by the date of
 * the row, in date order. */
export const countStoredAnswersByDate = async (
  attendeeId: number,
): Promise<number[]> =>
  (
    await queryAll<{ answers: number }>(
      sql`SELECT COUNT(*) AS answers
         FROM attendee_answers AS given
         JOIN listing_attendees AS row ON row.id = given.booking_row_id
        WHERE given.attendee_id = ${attendeeId}
        GROUP BY row.start_at
        ORDER BY row.start_at`,
    )
  ).map(({ answers }) => answers);
