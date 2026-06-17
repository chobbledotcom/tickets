/**
 * sms_messages table operations.
 *
 * A lean, PII-free map from the gateway's message id to the attendee a text was
 * sent to, so delivery/failure webhooks can be attributed to the right
 * attendee. Message content and recipient numbers are NOT stored here — they
 * live only in the (encrypted) activity log. Rows are deleted on a terminal
 * status event and pruned by age as a backstop.
 */

import { deleteByField, getDb, insert, queryOne } from "#shared/db/client.ts";
import { nowIso } from "#shared/now.ts";

export interface SmsMessageRow {
  id: number;
  attendee_id: number;
  listing_id: number;
  provider_id: string;
  created: string;
}

const COLUMNS = "id, attendee_id, listing_id, provider_id, created";

/** Record a sent message's gateway id against its attendee. */
export const recordSmsMessage = async (input: {
  attendeeId: number;
  listingId: number;
  providerId: string;
}): Promise<void> => {
  await getDb().execute(
    insert("sms_messages", {
      attendee_id: input.attendeeId,
      created: nowIso(),
      listing_id: input.listingId,
      provider_id: input.providerId,
    }),
  );
};

/** Find the message a status event refers to, by the gateway's message id. */
export const getSmsMessageByProviderId = (
  providerId: string,
): Promise<SmsMessageRow | null> =>
  providerId === ""
    ? Promise.resolve(null)
    : queryOne<SmsMessageRow>(
        `SELECT ${COLUMNS} FROM sms_messages WHERE provider_id = ? LIMIT 1`,
        [providerId],
      );

/** Count messages still in flight (sent, awaiting a delivery/failure webhook). */
export const countSmsMessages = async (): Promise<number> => {
  // COUNT(*) always returns exactly one row, so the result is never null.
  const row = await queryOne<{ c: number }>(
    "SELECT COUNT(*) AS c FROM sms_messages",
    [],
  );
  return Number(row!.c);
};

/** Delete a row once its message reaches a terminal state. */
export const deleteSmsMessage = (id: number): Promise<void> =>
  deleteByField("sms_messages", "id", id);

/** Prune rows older than the given ISO cutoff (backstop for missed webhooks). */
export const pruneSmsMessagesBefore = async (
  cutoffIso: string,
): Promise<void> => {
  await getDb().execute({
    args: [cutoffIso],
    sql: "DELETE FROM sms_messages WHERE created < ?",
  });
};
