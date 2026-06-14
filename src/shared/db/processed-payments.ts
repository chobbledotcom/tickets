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

import { decrypt, encrypt } from "#shared/crypto/encryption.ts";
import { getDb, insert, queryOne } from "#shared/db/client.ts";
import { STALE_RESERVATION_MS } from "#shared/limits.ts";
import { nowIso, nowMs } from "#shared/now.ts";

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

/** Execute a SQL statement parameterized by a single payment session ID */
const execWithSessionId = (sessionId: string, sql: string): Promise<unknown> =>
  getDb().execute({ args: [sessionId], sql });

/**
 * Delete a stale reservation to allow retry
 */
export const deleteStaleReservation = async (
  sessionId: string,
): Promise<void> => {
  await execWithSessionId(
    sessionId,
    "DELETE FROM processed_payments WHERE payment_session_id = ? AND attendee_id IS NULL",
  );
};

/**
 * Delete all stale reservations (unfinalized and older than STALE_RESERVATION_MS).
 * Called from admin listing views to clean up abandoned checkouts.
 */
export const deleteAllStaleReservations = async (): Promise<number> => {
  const cutoff = new Date(nowMs() - STALE_RESERVATION_MS).toISOString();
  const result = await getDb().execute({
    args: [cutoff],
    sql: "DELETE FROM processed_payments WHERE attendee_id IS NULL AND processed_at < ?",
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

      // Check if reservation is stale (abandoned by crashed process)
      if (
        existing.attendee_id === null &&
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
