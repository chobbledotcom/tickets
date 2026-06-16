/**
 * SMS outbox table operations.
 *
 * The outbox is the SMS gateway's send queue. Rows store ONLY end-to-end
 * encrypted values: `phone_enc` and `body_enc` are SMS Gate E2E ciphertext
 * (see #shared/sms/e2e.ts), opaque without the passphrase. Plaintext recipient
 * numbers and message text are never written here — the caller decrypts
 * attendee PII under the owner's key and re-encrypts under the E2E key first.
 */

import { getDb, insert, queryAll, queryOne } from "#shared/db/client.ts";
import { nowIso } from "#shared/now.ts";

/** Lifecycle of a queued message. */
export type SmsStatus = "queued" | "sent" | "delivered" | "failed";

export interface SmsOutboxRow {
  id: number;
  attendee_id: number;
  listing_id: number;
  /** SMS Gate E2E ciphertext of the recipient phone number. */
  phone_enc: string;
  /** SMS Gate E2E ciphertext of the message body. */
  body_enc: string;
  status: SmsStatus;
  /** Cloud message id once dispatched (empty until sent). */
  provider_id: string;
  error: string;
  attempts: number;
  created: string;
  updated: string;
}

const COLUMNS =
  "id, attendee_id, listing_id, phone_enc, body_enc, status, provider_id, error, attempts, created, updated";

/**
 * Enqueue a message. Inputs must already be E2E ciphertext.
 * Returns the new row id.
 */
export const enqueueSms = async (input: {
  attendeeId: number;
  listingId: number;
  phoneEnc: string;
  bodyEnc: string;
}): Promise<{ id: number }> => {
  const result = await getDb().execute(
    insert("sms_outbox", {
      attendee_id: input.attendeeId,
      body_enc: input.bodyEnc,
      created: nowIso(),
      listing_id: input.listingId,
      phone_enc: input.phoneEnc,
    }),
  );
  return { id: Number(result.lastInsertRowid) };
};

/** Find a row by the gateway's message id (for status webhooks). */
export const getSmsByProviderId = (
  providerId: string,
): Promise<SmsOutboxRow | null> =>
  queryOne<SmsOutboxRow>(
    `SELECT ${COLUMNS} FROM sms_outbox WHERE provider_id = ? LIMIT 1`,
    [providerId],
  );

/** All messages for an attendee, newest first (for the contact history view). */
export const getSmsOutboxForAttendee = (
  attendeeId: number,
): Promise<SmsOutboxRow[]> =>
  queryAll<SmsOutboxRow>(
    `SELECT ${COLUMNS} FROM sms_outbox WHERE attendee_id = ? ORDER BY id DESC`,
    [attendeeId],
  );

/** Mark a row sent and record the cloud message id (counts an attempt). */
export const markSmsSent = async (
  id: number,
  providerId: string,
): Promise<void> => {
  await getDb().execute({
    args: [providerId, nowIso(), id],
    sql: "UPDATE sms_outbox SET status = 'sent', provider_id = ?, attempts = attempts + 1, updated = ? WHERE id = ?",
  });
};

/** Mark a row failed and record the error (counts an attempt). */
export const markSmsFailed = async (
  id: number,
  error: string,
): Promise<void> => {
  await getDb().execute({
    args: [error, nowIso(), id],
    sql: "UPDATE sms_outbox SET status = 'failed', error = ?, attempts = attempts + 1, updated = ? WHERE id = ?",
  });
};

/** Mark a row delivered (driven by a delivery webhook). */
export const markSmsDelivered = async (id: number): Promise<void> => {
  await getDb().execute({
    args: [nowIso(), id],
    sql: "UPDATE sms_outbox SET status = 'delivered', updated = ? WHERE id = ?",
  });
};
