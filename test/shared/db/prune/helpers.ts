import { attendeeAccount, WORLD } from "#accounting/accounts.ts";
import { KIND } from "#accounting/kinds.ts";
import { postTransfers } from "#accounting/store.ts";
import { hmacHash } from "#crypto/hashing.ts";
import type { EnvKeyEncrypted, OwnerKeyEncrypted } from "#crypto/sealed.ts";
import { executeBatch, getDb } from "#db/client.ts";
import { tables } from "#db/select/tables.ts";
import { sql } from "#db/sql.ts";
import { insertInto } from "#db/write.ts";
import { nowMs } from "#shared/now.ts";
import { CLAIM_MIRROR } from "#test-utils/payment-claim.ts";

export const insertFinalizedPayment = async (
  sessionId: string,
  processedAtIso: string,
  opts: { attendeeId?: number; paymentReference?: string } = {},
): Promise<void> => {
  await getDb().execute(
    insertInto(tables.processed_payments, {
      attendeeId: opts.attendeeId ?? 1,
      paymentReference: (opts.paymentReference ?? "") as OwnerKeyEncrypted | "",
      paymentSessionId: sessionId,
      processedAt: processedAtIso,
      ticketTokens: "",
    }),
  );
};

export const insertUnfinalizedPayment = async (
  sessionId: string,
  processedAtIso: string,
): Promise<void> => {
  await getDb().execute(
    insertInto(tables.processed_payments, {
      attendeeId: null,
      paymentSessionId: sessionId,
      processedAt: processedAtIso,
    }),
  );
};

export const insertFailedPayment = async (
  sessionId: string,
  processedAtIso: string,
): Promise<void> => {
  await getDb().execute(
    insertInto(tables.processed_payments, {
      attendeeId: null,
      failureData:
        '{"error":"sold out","status":409,"refunded":true}' as EnvKeyEncrypted,
      paymentSessionId: sessionId,
      processedAt: processedAtIso,
    }),
  );
};

/** An old row a refund run is holding: its work shows in the plaintext mirror
 *  the prune reads. */
export const insertClaimedPayment = async (
  sessionId: string,
  processedAtIso: string,
  attendeeId: number | null = null,
): Promise<void> => {
  await getDb().execute(
    insertInto(tables.processed_payments, {
      attendeeId: attendeeId,
      failureData:
        '{"error":"sold out","status":409,"refunded":true}' as EnvKeyEncrypted,
      paymentSessionId: sessionId,
      processedAt: processedAtIso,
      protectedState: CLAIM_MIRROR,
    }),
  );
};

export const paymentExists = async (sessionId: string): Promise<boolean> => {
  const { rows } = await getDb().execute(
    sql`SELECT 1 FROM processed_payments WHERE payment_session_id = ${sessionId}`,
  );
  return rows.length > 0;
};

export const postRefundCash = async (attendeeId: number): Promise<void> => {
  await postTransfers([
    {
      amount: 100,
      destination: WORLD,
      eventGroup: `prune-refund-${attendeeId}`,
      kind: KIND.refundCash,
      occurredAt: new Date(nowMs()).toISOString(),
      reference: `prune-refund-${attendeeId}`,
      source: attendeeAccount(attendeeId),
    },
  ]);
};

export const insertSumupCheckout = async (
  referenceIndex: string,
  createdAtIso: string,
): Promise<void> => {
  await getDb().execute(
    insertInto(tables.sumup_checkouts, {
      createdAt: createdAtIso,
      metadata: "ciphertext",
      referenceIndex: referenceIndex,
      wrappedKey: "wk",
    }),
  );
};

export const sumupCheckoutExists = async (
  referenceIndex: string,
): Promise<boolean> => {
  const { rows } = await getDb().execute(
    sql`SELECT 1 FROM sumup_checkouts WHERE reference_index = ${referenceIndex}`,
  );
  return rows.length > 0;
};

export const insertString = async (
  textIndex: string,
  created: string,
  usedCount: number,
): Promise<void> => {
  await getDb().execute(
    insertInto(tables.strings, {
      created,
      encryptedText: "ciphertext",
      textIndex: textIndex,
      usedCount: usedCount,
    }),
  );
};

export const insertStrings = (
  prefix: string,
  created: string,
  count: number,
): Promise<void> =>
  executeBatch(
    Array.from({ length: count }, (_, index) =>
      insertInto(tables.strings, {
        created,
        encryptedText: "ciphertext",
        textIndex: `${prefix}-${index}`,
        usedCount: 0,
      }),
    ),
  );

export const stringExists = async (textIndex: string): Promise<boolean> => {
  const { rows } = await getDb().execute(
    sql`SELECT 1 FROM strings WHERE text_index = ${textIndex}`,
  );
  return rows.length > 0;
};

export const insertLoginAttempt = async (
  ipPlain: string,
  attempts: number,
  lockedUntil: number | null,
  lastAttempt: number,
): Promise<string> => {
  const ipHash = await hmacHash(ipPlain);
  await getDb().execute(
    sql`INSERT INTO login_attempts (ip, attempts, locked_until, last_attempt) VALUES (${ipHash}, ${attempts}, ${lockedUntil}, ${lastAttempt})`,
  );
  return ipHash;
};

export const loginAttemptExists = async (ipHash: string): Promise<boolean> => {
  const { rows } = await getDb().execute(
    sql`SELECT 1 FROM login_attempts WHERE ip = ${ipHash}`,
  );
  return rows.length > 0;
};

export const insertTokenAttempt = async (
  ipPlain: string,
  lockedUntil: number | null,
  lastAttempt: number,
): Promise<string> => {
  const ipHash = await hmacHash(ipPlain);
  await getDb().execute(
    sql`INSERT INTO token_attempts (ip, recent_tokens, locked_until, window_start, last_attempt) VALUES (${ipHash}, ${"[]"}, ${lockedUntil}, ${lastAttempt}, ${lastAttempt})`,
  );
  return ipHash;
};

export const tokenAttemptExists = async (ipHash: string): Promise<boolean> => {
  const { rows } = await getDb().execute(
    sql`SELECT 1 FROM token_attempts WHERE ip = ${ipHash}`,
  );
  return rows.length > 0;
};

export const insertContactPreference = async (
  hash: string,
  unsubscribed: number,
  lastActivity: number,
): Promise<void> => {
  await getDb().execute(
    sql`INSERT INTO contact_preferences (contact_hash, unsubscribed, visits, stats_blob, last_activity) VALUES (${hash}, ${unsubscribed}, 1, '', ${lastActivity})`,
  );
};

export const contactPreferenceExists = async (
  hash: string,
): Promise<boolean> => {
  const { rows } = await getDb().execute(
    sql`SELECT 1 FROM contact_preferences WHERE contact_hash = ${hash}`,
  );
  return rows.length > 0;
};

export const insertOrphanAttendee = async (
  createdIso: string,
): Promise<number> => {
  const result = await getDb().execute(
    insertInto(tables.attendees, {
      created: createdIso,
      piiBlob: "",
      ticketTokenIndex: `prune-orphan-${crypto.randomUUID()}`,
    }),
  );
  return Number(result.lastInsertRowid);
};

export const attendeeExists = async (id: number): Promise<boolean> => {
  const { rows } = await getDb().execute(
    sql`SELECT 1 FROM attendees WHERE id = ${id}`,
  );
  return rows.length > 0;
};

export const oldOrphanIso = (): string =>
  new Date(nowMs() - 365 * 24 * 60 * 60 * 1000).toISOString();

export const insertScanOperation = async (
  operationId: string,
  createdIso: string,
): Promise<void> => {
  await getDb().execute(
    sql`INSERT INTO processed_scan_operations (operation_id, token_hash, listing_ids, quantity, created) VALUES (${operationId}, ${"a-token-digest"}, ${"[3]"}, ${1}, ${createdIso})`,
  );
};

export const scanOperationExists = async (
  operationId: string,
): Promise<boolean> => {
  const { rows } = await getDb().execute(
    sql`SELECT 1 FROM processed_scan_operations WHERE operation_id = ${operationId}`,
  );
  return rows.length > 0;
};
