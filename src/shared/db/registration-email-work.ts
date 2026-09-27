import * as v from "valibot";
import { hmacHash } from "#crypto/hashing.ts";
import {
  decryptCheckoutWork,
  encryptCheckoutWork,
} from "#crypto/checkout-work.ts";
import { execute, queryOne, resultRows } from "#db/client.ts";
import type { EmailMessage } from "#shared/email.ts";
import { nowIso } from "#shared/now.ts";
import { parseEmail } from "#shared/validation/email.ts";

export type RegistrationEmailRecipient = "buyer" | "business";
export type PreparedRegistrationEmail = {
  recipient: RegistrationEmailRecipient;
  message: EmailMessage;
};

const EmailMessageSchema = v.object({
  attachments: v.optional(v.array(v.object({
    content: v.string(),
    contentType: v.string(),
    filename: v.string(),
  }))),
  html: v.string(),
  replyTo: v.optional(v.string()),
  subject: v.string(),
  text: v.string(),
  to: v.string(),
});

const readEmailMessage = (sealed: string, wrappedKey: string) =>
  decryptCheckoutWork({ sealed, wrappedKey }).then((plaintext): EmailMessage => {
    const value = v.parse(EmailMessageSchema, JSON.parse(plaintext));
    const to = parseEmail(value.to);
    if (!to) throw new Error("Stored registration email has no valid recipient");
    const replyTo = value.replyTo === undefined
      ? undefined
      : parseEmail(value.replyTo);
    if (value.replyTo !== undefined && !replyTo) {
      throw new Error("Stored registration email has no valid reply address");
    }
    const { replyTo: _rawReplyTo, ...content } = value;
    return { ...content, to, ...(replyTo ? { replyTo } : {}) };
  });

type StoredWork = {
  id: number;
  attendee_id: number;
  claim_token: string;
  recipient: RegistrationEmailRecipient;
  sealed: string;
  wrapped_key: string;
};

export type ClaimedRegistrationEmail = {
  id: number;
  attendeeId: number;
  claimToken: string;
  recipient: RegistrationEmailRecipient;
  message: EmailMessage;
  messageCiphertext: { sealed: string; wrappedKey: string };
};

const workIndex = (sessionId: string): Promise<string> => hmacHash(sessionId);

export const hasRegistrationEmailWork = async (
  sessionId: string,
): Promise<boolean> =>
  (await queryOne<{ id: number }>(
    "SELECT id FROM registration_email_work WHERE work_id = ? LIMIT 1",
    [await workIndex(sessionId)],
  )) !== null;

/** Insert both recipients in one transaction. A replay never reopens a sent row. */
export const queueRegistrationEmails = async (
  sessionId: string,
  attendeeId: number,
  prepared: readonly PreparedRegistrationEmail[],
): Promise<void> => {
  const workId = await workIndex(sessionId);
  const now = nowIso();
  const messages = prepared.length === 0
    ? [{ recipient: "none" as const, message: null }]
    : prepared;
  const rows = await Promise.all(messages.map(async ({ recipient, message }) => {
    const encrypted = message === null
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
  }));
  await execute(
    `INSERT INTO registration_email_work
      (work_id, attendee_id, recipient, state, sealed, wrapped_key,
       next_attempt_at, created_at)
     VALUES ${rows.map((row) => row.sql).join(", ")}
     ON CONFLICT(work_id, recipient) DO NOTHING`,
    rows.flatMap((row) => row.args),
  );
};

/** Claim one due row with a lease. A second worker cannot send it concurrently. */
export const claimRegistrationEmail = async (): Promise<
  ClaimedRegistrationEmail | null
> => {
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
      RETURNING id, attendee_id, claim_token, recipient, sealed, wrapped_key`,
    [claimToken, leaseUntil, now, now],
  );
  const row = resultRows<StoredWork>(result)[0];
  if (!row) return null;
  return {
    id: row.id,
    attendeeId: row.attendee_id,
    claimToken: row.claim_token,
    recipient: row.recipient,
    message: await readEmailMessage(row.sealed, row.wrapped_key),
    messageCiphertext: { sealed: row.sealed, wrappedKey: row.wrapped_key },
  };
};

export const finishRegistrationEmail = async (
  work: ClaimedRegistrationEmail,
  delivered: boolean,
): Promise<void> => {
  const retryAt = new Date(Date.now() + 5 * 60_000).toISOString();
  await execute(
    `UPDATE registration_email_work
        SET state = ?, next_attempt_at = ?, lease_until = '',
            claim_token = '', sealed = ?, wrapped_key = ?
      WHERE id = ? AND state = 'sending' AND claim_token = ?`,
    [
      delivered ? "complete" : "due",
      delivered ? nowIso() : retryAt,
      delivered ? "" : work.messageCiphertext.sealed,
      delivered ? "" : work.messageCiphertext.wrappedKey,
      work.id,
      work.claimToken,
    ],
  );
};
