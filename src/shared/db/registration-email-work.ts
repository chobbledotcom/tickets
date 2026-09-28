import * as v from "valibot";
import {
  decryptCheckoutWork,
  encryptCheckoutWork,
} from "#crypto/checkout-work.ts";
import { sessionWorkIndex } from "#db/checkout-pending-answers.ts";
import { execute, resultRows } from "#db/client.ts";
import type { EmailMessage } from "#shared/email.ts";
import { nowIso } from "#shared/now.ts";
import { parseEmail } from "#shared/validation/email.ts";

export type RegistrationEmailRecipient = "buyer" | "business";
export type PreparedRegistrationEmail = {
  recipient: RegistrationEmailRecipient;
  message: EmailMessage;
};

/** A stored message decrypts into exactly the shape a provider accepts.
 * Validated at this boundary, never trusted from the ciphertext alone. */
const StoredEmailMessageSchema = v.object({
  attachments: v.optional(
    v.array(
      v.object({
        content: v.string(),
        contentType: v.string(),
        filename: v.string(),
      }),
    ),
  ),
  html: v.string(),
  replyTo: v.optional(v.string()),
  subject: v.string(),
  text: v.string(),
  to: v.string(),
});

const readEmailMessage = async (
  sealed: string,
  wrappedKey: string,
): Promise<EmailMessage> => {
  const value = v.parse(
    StoredEmailMessageSchema,
    JSON.parse(await decryptCheckoutWork({ sealed, wrappedKey })),
  );
  const to = parseEmail(value.to);
  if (!to) {
    throw new Error("A stored registration email has no valid recipient");
  }
  const replyTo =
    value.replyTo === undefined ? undefined : parseEmail(value.replyTo);
  if (value.replyTo !== undefined && !replyTo) {
    throw new Error("A stored registration email has no valid reply address");
  }
  const { replyTo: rawReplyTo, ...content } = value;
  return { ...content, to, ...(replyTo ? { replyTo } : {}) };
};

type StoredWork = {
  id: number;
  attendee_id: number;
  claim_token: string;
  sealed: string;
  wrapped_key: string;
};

export type ClaimedRegistrationEmail = {
  id: number;
  attendeeId: number;
  claimToken: string;
  message: EmailMessage;
};

/** Queue one durable send per recipient, keyed by the session. An exact
 * replay never re-opens a row, so the same booking cannot send twice. No
 * recipients still mark the session's email work complete. */
export const queueRegistrationEmails = async (
  sessionId: string,
  attendeeId: number,
  prepared: readonly PreparedRegistrationEmail[],
): Promise<void> => {
  const workId = await sessionWorkIndex(sessionId);
  const now = nowIso();
  const messages =
    prepared.length === 0
      ? [{ message: null, recipient: "none" as const }]
      : prepared;
  const rows = await Promise.all(
    messages.map(async ({ recipient, message }) => {
      const encrypted =
        message === null
          ? { sealed: "", wrappedKey: "" }
          : await encryptCheckoutWork(JSON.stringify(message));
      return {
        args: [
          workId,
          attendeeId,
          recipient,
          message === null ? "complete" : "due",
          encrypted.sealed,
          encrypted.wrappedKey,
          now,
          now,
        ],
        sql: "(?, ?, ?, ?, ?, ?, ?, ?)",
      };
    }),
  );
  await execute(
    `INSERT INTO registration_email_work
       (work_id, attendee_id, recipient, state, sealed, wrapped_key,
        next_attempt_at, created_at)
     VALUES ${rows.map((row) => row.sql).join(", ")}
     ON CONFLICT(work_id, recipient) DO NOTHING`,
    rows.flatMap((row) => row.args),
  );
};

/** Claim one due row with a lease. A second worker cannot send it together. */
export const claimRegistrationEmail =
  async (): Promise<ClaimedRegistrationEmail | null> => {
    const now = nowIso();
    const claimToken = crypto.randomUUID();
    const leaseUntil = new Date(Date.now() + 2 * 60_000).toISOString();
    const result = await execute(
      `UPDATE registration_email_work
        SET state = 'sending', claim_token = ?, lease_until = ?,
            attempts = attempts + 1
      WHERE id = (
        SELECT id FROM registration_email_work
         WHERE (state = 'due' AND next_attempt_at <= ?)
            OR (state = 'sending' AND lease_until <= ?)
         ORDER BY next_attempt_at, id LIMIT 1
      )
      RETURNING id, attendee_id, claim_token, sealed, wrapped_key`,
      [claimToken, leaseUntil, now, now],
    );
    const row = resultRows<StoredWork>(result)[0];
    if (!row) return null;
    return {
      attendeeId: row.attendee_id,
      claimToken: row.claim_token,
      id: row.id,
      message: await readEmailMessage(row.sealed, row.wrapped_key),
    };
  };

/** Record one claim's outcome. A failed send keeps its sealed message and
 * retries later; a delivered one drops the message, keeping only the marker
 * that stops a replay from queueing it again. */
export const finishRegistrationEmail = async (
  work: ClaimedRegistrationEmail,
  delivered: boolean,
): Promise<void> => {
  const retryAt = new Date(Date.now() + 5 * 60_000).toISOString();
  await execute(
    `UPDATE registration_email_work
        SET state = ?, next_attempt_at = ?, lease_until = '', claim_token = '',
            sealed = CASE WHEN ? = 1 THEN '' ELSE sealed END,
            wrapped_key = CASE WHEN ? = 1 THEN '' ELSE wrapped_key END
      WHERE id = ? AND state = 'sending' AND claim_token = ?`,
    [
      delivered ? "complete" : "due",
      delivered ? nowIso() : retryAt,
      delivered ? 1 : 0,
      delivered ? 1 : 0,
      work.id,
      work.claimToken,
    ],
  );
};
