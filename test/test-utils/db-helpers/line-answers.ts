/** Reads the answers stored for each booked listing straight from the tables,
 * so a test does not lean on the production read it checks. */

import { decryptWithOwnerKey } from "#crypto/hybrid.ts";
import type { OwnerKeyEncrypted } from "#crypto/sealed.ts";
import { queryAll } from "#db/client.ts";
import { sql } from "#db/sql.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";

/** One stored answer: the question, the listing it answers, and the words. */
export type StoredLineAnswer = {
  listingId: number;
  questionId: number;
  text: string;
};

/** The attendee's listing answers, each pair once, in question order. */
export const readStoredLineAnswers = async (
  attendeeId: number,
): Promise<StoredLineAnswer[]> => {
  const rows = await queryAll<{
    encrypted_text: OwnerKeyEncrypted;
    listing_id: number;
    question_id: number;
  }>(
    sql`SELECT DISTINCT row.listing_id, given.question_id, text.encrypted_text
          FROM attendee_answers AS given
          JOIN listing_attendees AS row ON row.id = given.booking_row_id
          JOIN strings AS text ON text.id = given.string_id
         WHERE given.attendee_id = ${attendeeId}
         ORDER BY given.question_id, row.listing_id`,
  );
  const key = await getTestPrivateKey();
  const stored: StoredLineAnswer[] = [];
  for (const row of rows) {
    stored.push({
      listingId: row.listing_id,
      questionId: row.question_id,
      text: await decryptWithOwnerKey(row.encrypted_text, key),
    });
  }
  return stored;
};
