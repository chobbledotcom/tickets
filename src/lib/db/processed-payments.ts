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

import { decrypt, encrypt } from "#lib/crypto.ts";
import { getDb, queryOne } from "#lib/db/client.ts";
import { STALE_RESERVATION_MS } from "#lib/limits.ts";
import { nowIso, nowMs } from "#lib/now.ts";

export { STALE_RESERVATION_MS };

/** Processed payment record */
export type ProcessedPayment = {
  payment_session_id: string;
  attendee_id: number | null;
  processed_at: string;
  ticket_tokens: string;
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
    "SELECT payment_session_id, attendee_id, processed_at, ticket_tokens FROM processed_payments WHERE payment_session_id = ?",
    [sessionId],
  );

/**
 * Check if a reservation is stale (abandoned by a crashed process)
 */
export const isReservationStale = (processedAt: string): boolean => {
  const reservedAt = new Date(processedAt).getTime();
  return nowMs() - reservedAt > STALE_RESERVATION_MS;
};

/**
 * Delete a stale reservation to allow retry
 */
export const deleteStaleReservation = async (
  sessionId: string,
): Promise<void> => {
  await getDb().execute({
    sql: "DELETE FROM processed_payments WHERE payment_session_id = ? AND attendee_id IS NULL",
    args: [sessionId],
  });
};

/**
 * Delete all stale reservations (unfinalized and older than STALE_RESERVATION_MS).
 * Called from admin event views to clean up abandoned checkouts.
 */
export const deleteAllStaleReservations = async (): Promise<number> => {
  const cutoff = new Date(nowMs() - STALE_RESERVATION_MS).toISOString();
  const result = await getDb().execute({
    sql: "DELETE FROM processed_payments WHERE attendee_id IS NULL AND processed_at < ?",
    args: [cutoff],
  });
  return result.rowsAffected;
};

/** Check if an error is a duplicate key constraint violation */
const isDuplicateKeyError = (e: unknown): boolean => {
  const msg = String(e);
  return (
    msg.includes("UNIQUE constraint") || msg.includes("PRIMARY KEY constraint")
  );
};

/** Handle a duplicate session reservation: retry if stale, return existing otherwise */
const handleExistingReservation = async (
  sessionId: string,
): Promise<ReserveSessionResult> => {
  const existing = await isSessionProcessed(sessionId);
  if (!existing) {
    // Race condition edge case: record existed but was deleted
    return reserveSession(sessionId);
  }
  // Check if reservation is stale (abandoned by crashed process)
  if (
    existing.attendee_id === null &&
    isReservationStale(existing.processed_at)
  ) {
    await deleteStaleReservation(sessionId);
    return reserveSession(sessionId);
  }
  return { reserved: false, existing };
};

/**
 * Reserve a payment session for processing (first phase of two-phase lock).
 * Inserts with NULL attendee_id to claim the session.
 * Handles abandoned reservations by deleting stale records and retrying.
 */
export const reserveSession = async (
  sessionId: string,
): Promise<ReserveSessionResult> => {
  try {
    await getDb().execute({
      sql: "INSERT INTO processed_payments (payment_session_id, attendee_id, processed_at) VALUES (?, NULL, ?)",
      args: [sessionId, nowIso()],
    });
    return { reserved: true };
  } catch (e) {
    if (isDuplicateKeyError(e)) return handleExistingReservation(sessionId);
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
    sql: "UPDATE processed_payments SET attendee_id = ?, ticket_tokens = ? WHERE payment_session_id = ?",
    args: [attendeeId, encryptedTokens, sessionId],
  });
};

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
  await getDb().execute({
    sql: "UPDATE processed_payments SET ticket_tokens = '' WHERE payment_session_id = ?",
    args: [sessionId],
  });
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
