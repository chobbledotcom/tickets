/**
 * Processed payments table operations (idempotency for webhook handling)
 *
 * Uses a two-phase locking pattern to prevent duplicate attendee creation:
 * 1. reserveSession() - Claims the session with NULL attendee_id
 * 2. createBookingAtomic() with batchFinalizeStatements() inside the same batch
 *    - Creates the attendee and sets attendee_id atomically, closing the crash
 *    window between creation and a separate finalize call.
 *
 * reserveSession() claims missing and stale unresolved rows with one conditional
 * upsert. A lookup in the same batch returns any existing outcome.
 */

import * as v from "valibot";
import { decrypt, encrypt } from "#shared/crypto/encryption.ts";
import type {
  EnvKeyEncrypted,
  OwnerKeyEncrypted,
} from "#shared/crypto/sealed.ts";
import {
  execute,
  executeBatchWithResults,
  resultRows,
} from "#shared/db/client.ts";
import { encryptPaymentReference } from "#shared/db/payment-references.ts";
import { STALE_RESERVATION_MS } from "#shared/limits.ts";
import { isoBefore, nowIso } from "#shared/now.ts";
import { defineStoredJson } from "#shared/validation/stored-json.ts";

export { STALE_RESERVATION_MS };

/**
 * A processed_payments row is in exactly one of three lifecycle states, encoded
 * across two columns: **reserved** (in-progress: attendee_id NULL, no
 * failure_data), **finalized** (success: attendee_id set), **failed** (terminal
 * handled failure: attendee_id NULL, failure_data set). This predicate is the
 * single source of truth for the unresolved shape, so the encoding can't drift
 * between call sites.
 */
export const UNRESOLVED_RESERVATION =
  "attendee_id IS NULL AND failure_data = ''";

/** Processed payment record */
export type ProcessedPayment = {
  payment_session_id: string;
  attendee_id: number | null;
  processed_at: string;
  /** Encrypted "+"-joined ticket tokens; "" while none are stored. */
  ticket_tokens: EnvKeyEncrypted | "";
  /** Encrypted JSON-encoded {@link StoredPaymentFailure} once a session reaches a
   * handled terminal failure (refund issued, sold out, price changed, …); "" while
   * a row is in-progress or finalized. Encrypted at rest (like ticket_tokens)
   * because the stored message can embed an encrypted-at-rest listing name. Lets a
   * later redirect/webhook replay the same outcome instead of re-running refund
   * logic. */
  failure_data: EnvKeyEncrypted | "";
  /** Provider-specific refundable payment reference (e.g. Stripe pi_...). */
  payment_reference: OwnerKeyEncrypted | "";
  /** Non-empty once this charge has been returned at the provider. */
  provider_refunded_at: string;
};

/**
 * The subset of a handled payment failure we persist so a later redirect or
 * webhook retry replays the same terminal result (user-facing message, HTTP
 * status, and whether a refund was already issued) without re-validating the
 * listing or re-attempting the refund.
 *
 * Persisted encrypted (see {@link markSessionFailed} / failure_data): `error`
 * can embed an encrypted-at-rest listing name, so it must never be stored in the
 * clear. Keep this shape free of any field that shouldn't round-trip through the
 * DB encryption key.
 */
const StoredPaymentFailureSchema = v.strictObject({
  error: v.string(),
  refunded: v.optional(v.boolean()),
  status: v.optional(v.pipe(v.number(), v.safeInteger())),
});
export type StoredPaymentFailure = v.InferOutput<
  typeof StoredPaymentFailureSchema
>;
const paymentFailureJson = defineStoredJson(StoredPaymentFailureSchema);

/** Result of session reservation attempt */
export type ReserveSessionResult =
  | { reserved: true }
  | { reserved: false; existing: ProcessedPayment };

/** Execute a SQL statement parameterized by a single payment session ID */
const execWithSessionId = (sessionId: string, sql: string): Promise<unknown> =>
  execute(sql, [sessionId]);

/** A void write parameterized by a single payment session ID: curries the SQL,
 * returns a function that runs it for one session. */
const sessionIdWrite =
  (sql: string) =>
  async (sessionId: string): Promise<void> => {
    await execWithSessionId(sessionId, sql);
  };

/**
 * Release an in-progress reservation so the very next delivery can re-claim it.
 * Deletes only a still-unresolved row, so it never clobbers a finalized success
 * or a recorded terminal failure that a racing delivery may have written.
 *
 * The webhook releases a *fresh* reservation whose refund of a real payment
 * just failed: recording no outcome but holding the lock would make the next
 * redelivery collide and return 409 until the row goes stale (~5 min), gating
 * refund recovery on a local timer instead of provider redelivery.
 */
export const releaseReservation: (sessionId: string) => Promise<void> =
  sessionIdWrite(
    `DELETE FROM processed_payments WHERE payment_session_id = ? AND ${UNRESOLVED_RESERVATION}`,
  );

/**
 * Delete all stale reservations (unfinalized, outcome-less, and older than
 * STALE_RESERVATION_MS). Called from admin listing views to clean up abandoned
 * checkouts. Rows carrying a recorded terminal failure are kept so a late
 * redirect/webhook replays the handled outcome rather than re-refunding.
 */
export const deleteAllStaleReservations = async (): Promise<number> => {
  const cutoff = isoBefore(STALE_RESERVATION_MS);
  const result = await execute(
    `DELETE FROM processed_payments WHERE ${UNRESOLVED_RESERVATION} AND processed_at < ?`,
    [cutoff],
  );
  return result.rowsAffected;
};

/**
 * Reserve a payment session for processing (first phase of two-phase lock).
 * Missing and stale unresolved rows are claimed atomically. Existing fresh,
 * finalized, and failed rows are returned without changing them.
 */
export const reserveSession = async (
  sessionId: string,
): Promise<ReserveSessionResult> => {
  const claimedAt = nowIso();
  const staleBefore = new Date(
    new Date(claimedAt).getTime() - STALE_RESERVATION_MS,
  ).toISOString();
  const [claimResult, lookupResult] = await executeBatchWithResults([
    {
      args: [sessionId, claimedAt, staleBefore],
      sql: `INSERT INTO processed_payments (payment_session_id, attendee_id, processed_at)
            VALUES (?, NULL, ?)
            ON CONFLICT(payment_session_id) DO UPDATE SET
              attendee_id = NULL,
              processed_at = excluded.processed_at,
              ticket_tokens = '',
              failure_data = '',
              payment_reference = '',
              provider_refunded_at = ''
            WHERE ${UNRESOLVED_RESERVATION}
              AND processed_payments.processed_at < ?
            RETURNING payment_session_id`,
    },
    {
      args: [sessionId],
      sql: "SELECT payment_session_id, attendee_id, processed_at, ticket_tokens, failure_data, payment_reference, provider_refunded_at FROM processed_payments WHERE payment_session_id = ?",
    },
  ]);
  if (resultRows(claimResult!)[0] !== undefined) return { reserved: true };
  const existing = resultRows<ProcessedPayment>(lookupResult!)[0];
  if (!existing) {
    throw new Error(`Reserved payment session is missing: ${sessionId}`);
  }
  return { existing, reserved: false };
};

/** Encrypt ticket tokens for the atomic payment finalize. */
export const encryptTicketTokens = (
  ticketTokens: string[],
): Promise<EnvKeyEncrypted> => encrypt(ticketTokens.join("+"));

/**
 * Heal a still-unresolved reservation by stamping `attendee_id`, leaving
 * `ticket_tokens` untouched. The ledger-replay path uses this: when a late
 * delivery finds the booking already recorded in the ledger, it points its fresh
 * reservation row at the existing attendee so the next delivery takes the fast
 * already-processed path — but ONLY while the row is unresolved, so it never
 * overwrites the `attendee_id` or blanks the `ticket_tokens` a racing delivery
 * may have just finalized and stored. Guarded on {@link UNRESOLVED_RESERVATION}
 * (the first outcome wins), and a no-op if the row was pruned away.
 *
 * When the replayed session carries a provider `paymentReference`, it is stored
 * too, so a replay that recreated the idempotency row (after a prune) restores
 * the refundable charge reference rather than leaving it empty — the only
 * refundable id for a provider-less/admin-added attendee's balance charge.
 */
export const finalizeSessionIfUnresolved = async (
  sessionId: string,
  attendeeId: number,
  paymentReference = "",
): Promise<void> => {
  const refClause = paymentReference ? ", payment_reference = ?" : "";
  const refParams = paymentReference
    ? [await encryptPaymentReference(paymentReference)]
    : [];
  await execute(
    `UPDATE processed_payments SET attendee_id = ?${refClause} WHERE payment_session_id = ? AND ${UNRESOLVED_RESERVATION}`,
    [attendeeId, ...refParams, sessionId],
  );
};

/**
 * Record a handled terminal failure on a still-unresolved session. A later
 * redirect/webhook for the same session reads this back via
 * {@link parseSessionFailure} and returns the same outcome, so refunds and
 * validation never run twice. Guarded on {@link UNRESOLVED_RESERVATION}, so it
 * never clobbers a finalized success and never overwrites an already-recorded
 * failure (the first outcome wins); a no-op if the row was pruned away.
 */
export const markSessionFailed = async (
  sessionId: string,
  failure: StoredPaymentFailure,
): Promise<void> => {
  await execute(
    `UPDATE processed_payments SET failure_data = ? WHERE payment_session_id = ? AND ${UNRESOLVED_RESERVATION}`,
    [
      await encrypt(
        paymentFailureJson.write(failure, "processed_payments.failure_data"),
      ),
      sessionId,
    ],
  );
};

/** Generic terminal failure used when stored failure_data can't be parsed. */
const CORRUPT_FAILURE: StoredPaymentFailure = {
  error: "This payment could not be completed. Please contact support.",
  status: 500,
};

/**
 * Parse a stored terminal failure, or null when the row carries none. We only
 * ever write valid encrypted JSON (via {@link markSessionFailed}), but a value
 * that won't decrypt or parse (restore, manual edit, rotated key) must not crash
 * the replay path — it degrades to a generic terminal failure so the session
 * still resolves instead of looping.
 */
export const parseSessionFailure = async (
  failureData: EnvKeyEncrypted | "",
): Promise<StoredPaymentFailure | null> => {
  if (!failureData) return null;
  try {
    return paymentFailureJson.read(
      await decrypt(failureData),
      "processed_payments.failure_data",
    );
  } catch {
    return CORRUPT_FAILURE;
  }
};

/**
 * Decrypt the ticket_tokens field from a processed payment record.
 * Returns the plaintext token string (e.g. "tok1+tok2") or empty string.
 */
export const decryptSessionTokens = async (
  encryptedTokens: EnvKeyEncrypted | "",
): Promise<string> => {
  if (!encryptedTokens) return "";
  return await decrypt(encryptedTokens);
};

/**
 * Clear stored ticket tokens for a session (after redirect has consumed them)
 */
export const clearSessionTokens: (sessionId: string) => Promise<void> =
  sessionIdWrite(
    "UPDATE processed_payments SET ticket_tokens = '' WHERE payment_session_id = ?",
  );
