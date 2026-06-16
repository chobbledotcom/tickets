/**
 * Processed payments table operations (idempotency for webhook handling)
 *
 * Uses a two-phase locking pattern to prevent duplicate attendee creation:
 * 1. reserveSession() - Claims the session with NULL attendee_id
 * 2. createAttendeeAtomic() - Creates the attendee
 * 3. finalizeSession() - Updates with the real attendee_id
 *
 * If reserveSession fails (session already claimed), we check if it's:
 * - Finalized (attendee_id set) → return success with existing attendee
 * - Still processing (attendee_id NULL) → check staleness
 *   - Stale (>5min old) → delete and retry (process likely crashed)
 *   - Fresh → return conflict error (still being processed)
 */

import type { InValue } from "@libsql/client";
import { decrypt, encrypt } from "#shared/crypto/encryption.ts";
import { getDb, insert, queryOne } from "#shared/db/client.ts";
import { STALE_RESERVATION_MS } from "#shared/limits.ts";
import { nowIso, nowMs } from "#shared/now.ts";

export { STALE_RESERVATION_MS };

/**
 * A processed_payments row is in one of three lifecycle states across two
 * columns: **reserved** (in-progress: attendee_id NULL, failure_data ''),
 * **finalized** (success: attendee_id set), **failed** (terminal handled
 * failure: attendee_id NULL, failure_data set). Queries spell out the relevant
 * predicate inline; this note is the shared reference for what they mean.
 */

/** Processed payment record */
export type ProcessedPayment = {
  payment_session_id: string;
  attendee_id: number | null;
  processed_at: string;
  ticket_tokens: string;
  /** JSON-encoded {@link StoredPaymentFailure} once a session reaches a handled
   * terminal failure (refund issued, sold out, price changed, …); "" while a
   * row is in-progress or finalized. Lets a later redirect/webhook replay the
   * same outcome instead of re-running refund logic. */
  failure_data: string;
};

/**
 * The subset of a handled payment failure we persist so a later redirect or
 * webhook retry replays the same terminal result (user-facing message, HTTP
 * status, and whether a refund was already issued) without re-validating the
 * listing or re-attempting the refund.
 */
export type StoredPaymentFailure = {
  error: string;
  status?: number;
  refunded?: boolean;
};

/** Result of session reservation attempt */
export type ReserveSessionResult =
  | { reserved: true }
  | { reserved: false; existing: ProcessedPayment };

/**
 * Check if a payment session has already been processed
 */
export const isSessionProcessed = (
  sessionId: string,
): Promise<ProcessedPayment | null> =>
  queryOne<ProcessedPayment>(
    "SELECT payment_session_id, attendee_id, processed_at, ticket_tokens, failure_data FROM processed_payments WHERE payment_session_id = ?",
    [sessionId],
  );

/**
 * Check if a reservation is stale (abandoned by a crashed process)
 */
export const isReservationStale = (processedAt: string): boolean => {
  const reservedAt = new Date(processedAt).getTime();
  return nowMs() - reservedAt > STALE_RESERVATION_MS;
};

/** Execute a SQL statement parameterized by a single payment session ID */
const execWithSessionId = (sessionId: string, sql: string): Promise<unknown> =>
  getDb().execute({ args: [sessionId], sql });

/**
 * Delete a stale reservation to allow retry. Only abandoned, outcome-less rows
 * qualify — a recorded terminal failure (failure_data set) is an outcome, not
 * an in-progress reservation, so it is left for idempotent replay.
 */
export const deleteStaleReservation = async (
  sessionId: string,
): Promise<void> => {
  await execWithSessionId(
    sessionId,
    "DELETE FROM processed_payments WHERE payment_session_id = ? AND attendee_id IS NULL AND failure_data = ''",
  );
};

/**
 * Delete all stale reservations (unfinalized, outcome-less, and older than
 * STALE_RESERVATION_MS). Called from admin listing views to clean up abandoned
 * checkouts. Rows carrying a recorded terminal failure are kept so a late
 * redirect/webhook replays the handled outcome rather than re-refunding.
 */
export const deleteAllStaleReservations = async (): Promise<number> => {
  const cutoff = new Date(nowMs() - STALE_RESERVATION_MS).toISOString();
  const result = await getDb().execute({
    args: [cutoff],
    sql: "DELETE FROM processed_payments WHERE attendee_id IS NULL AND failure_data = '' AND processed_at < ?",
  });
  return result.rowsAffected;
};

/**
 * Reserve a payment session for processing (first phase of two-phase lock)
 * Inserts with NULL attendee_id to claim the session.
 * Returns { reserved: true } if we claimed it, or { reserved: false, existing } if already claimed.
 *
 * Handles abandoned reservations: if an existing reservation has NULL attendee_id
 * and is older than STALE_RESERVATION_MS, we assume the process crashed and
 * delete the stale record to allow retry.
 */
export const reserveSession = async (
  sessionId: string,
): Promise<ReserveSessionResult> => {
  try {
    await getDb().execute(
      insert("processed_payments", {
        attendee_id: null,
        payment_session_id: sessionId,
        processed_at: nowIso(),
      }),
    );
    return { reserved: true };
  } catch (e) {
    const errorMsg = String(e);
    if (
      errorMsg.includes("UNIQUE constraint") ||
      errorMsg.includes("PRIMARY KEY constraint")
    ) {
      // Session already claimed - get existing record (must exist: UNIQUE error proves it)
      const existing = (await isSessionProcessed(sessionId))!;

      // Check if reservation is stale (abandoned by crashed process). A row
      // carrying a recorded terminal failure is never stale — it is replayed
      // by the caller instead of being deleted and re-processed.
      if (
        existing.attendee_id === null &&
        existing.failure_data === "" &&
        isReservationStale(existing.processed_at)
      ) {
        await deleteStaleReservation(sessionId);
        return reserveSession(sessionId);
      }

      return { existing, reserved: false };
    }
    throw e;
  }
};

/**
 * Finalize a reserved session with the created attendee ID (second phase)
 */
export const finalizeSession = async (
  sessionId: string,
  attendeeId: number,
  ticketTokens: string[] = [],
): Promise<void> => {
  const joined = ticketTokens.join("+");
  const encryptedTokens = joined ? await encrypt(joined) : "";
  await getDb().execute({
    args: [attendeeId, encryptedTokens, sessionId],
    sql: "UPDATE processed_payments SET attendee_id = ?, ticket_tokens = ? WHERE payment_session_id = ?",
  });
};

/**
 * Record a handled terminal failure on a still-unresolved session. A later
 * redirect/webhook for the same session reads this back via
 * {@link parseSessionFailure} and returns the same outcome, so refunds and
 * validation never run twice. The `attendee_id IS NULL AND failure_data = ''`
 * guard means it never clobbers a finalized success and never overwrites an
 * already-recorded failure (the first outcome wins); a no-op if the row was
 * pruned away.
 */
export const markSessionFailed = async (
  sessionId: string,
  failure: StoredPaymentFailure,
): Promise<void> => {
  await getDb().execute({
    args: [JSON.stringify(failure), sessionId],
    sql: "UPDATE processed_payments SET failure_data = ? WHERE payment_session_id = ? AND attendee_id IS NULL AND failure_data = ''",
  });
};

/** Generic terminal failure used when stored failure_data can't be parsed. */
const CORRUPT_FAILURE: StoredPaymentFailure = {
  error: "This payment could not be completed. Please contact support.",
  status: 500,
};

/**
 * Parse a stored terminal failure, or null when the row carries none. We only
 * ever write valid JSON (via {@link markSessionFailed}), but a corrupt value
 * (restore, manual edit) must not crash the replay path — it degrades to a
 * generic terminal failure so the session still resolves instead of looping.
 */
export const parseSessionFailure = (
  failureData: string,
): StoredPaymentFailure | null => {
  if (!failureData) return null;
  try {
    return JSON.parse(failureData) as StoredPaymentFailure;
  } catch {
    return CORRUPT_FAILURE;
  }
};

/**
 * Build the finalize UPDATE for a balance-payment session, guarded so it only
 * applies while the attendee's balance still equals the amount being settled.
 * Returned rather than executed so the caller can commit it in the SAME batch as
 * the balance settle — closing the crash window between settle and finalize that
 * would otherwise leave a paid-but-unfinalized row (which a stale-replay could
 * then wrongly refund). Balance sessions carry no ticket tokens.
 */
export const balanceFinalizeStatement = (
  sessionId: string,
  attendeeId: number,
  expectedAmount: number,
): { sql: string; args: InValue[] } => ({
  args: [attendeeId, sessionId, attendeeId, expectedAmount],
  sql: "UPDATE processed_payments SET attendee_id = ?, ticket_tokens = '' WHERE payment_session_id = ? AND (SELECT remaining_balance FROM attendees WHERE id = ?) = ?",
});

/**
 * Decrypt the ticket_tokens field from a processed payment record.
 * Returns the plaintext token string (e.g. "tok1+tok2") or empty string.
 */
export const decryptSessionTokens = async (
  encryptedTokens: string,
): Promise<string> => {
  if (!encryptedTokens) return "";
  return await decrypt(encryptedTokens);
};

/**
 * Clear stored ticket tokens for a session (after redirect has consumed them)
 */
export const clearSessionTokens = async (sessionId: string): Promise<void> => {
  await execWithSessionId(
    sessionId,
    "UPDATE processed_payments SET ticket_tokens = '' WHERE payment_session_id = ?",
  );
};

/**
 * Get the attendee ID for an already-processed session
 * Used to return success for idempotent webhook retries
 */
export const getProcessedAttendeeId = async (
  sessionId: string,
): Promise<number | null> => {
  const result = await isSessionProcessed(sessionId);
  return result?.attendee_id ?? null;
};
