/**
 * sms_messages table operations.
 *
 * A lean, PII-free map from the gateway's message id to the attendee a text
 * was sent to. Delivery and failure webhooks can then be attributed to the
 * right attendee. Message content and recipient numbers are NOT stored here —
 * they live only in the (encrypted) activity log. Rows are deleted on a
 * terminal status event and pruned by age as a backstop.
 */

import { execute, queryOne } from "#db/client.ts";
import { pruneRowsBefore } from "#db/record-table.ts";
import { tables } from "#db/select/tables.ts";
import { sql } from "#db/sql.ts";
import { insertInto } from "#db/write.ts";
import { nowIso } from "#shared/now.ts";

export interface SmsMessageRow {
  attendee_id: number;
  created: string;
  id: number;
  listing_id: number;
  provider_id: string;
}

const COLUMNS = sql`id, attendee_id, listing_id, provider_id, created`;

/** Record a sent message's gateway id against its attendee. */
export const recordSmsMessage = async (input: {
  attendeeId: number;
  listingId: number;
  providerId: string;
}): Promise<void> => {
  await execute(
    insertInto(tables.sms_messages, {
      attendeeId: input.attendeeId,
      created: nowIso(),
      listingId: input.listingId,
      providerId: input.providerId,
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
        sql`SELECT ${COLUMNS} FROM sms_messages WHERE provider_id = ${providerId} LIMIT 1`,
      );

/** Delete a row once its message reaches a terminal state. */

/** Prune rows older than the given ISO cutoff (backstop for missed webhooks). */
export const pruneSmsMessagesBefore = pruneRowsBefore(tables.sms_messages);
