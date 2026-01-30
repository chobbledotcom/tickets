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

import { getDb, queryOne } from "#lib/db/client.ts";

/** Threshold for considering an unfinalized reservation abandoned (5 minutes) */
export const STALE_RESERVATION_MS = 5 * 60 * 1000;

/** Processed payment record */
export type ProcessedPayment = {
  payment_session_id: string;
  attendee_id: number | null;
  processed_at: string;
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
    "SELECT payment_session_id, attendee_id, processed_at FROM processed_payments WHERE payment_session_id = ?",
    [sessionId],
  );

/**
 * Check if a reservation is stale (abandoned by a crashed process)
 */
export const isReservationStale = (processedAt: string): boolean => {
  const reservedAt = new Date(processedAt).getTime();
  return Date.now() - reservedAt > STALE_RESERVATION_MS;
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
    await getDb().execute({
      sql: "INSERT INTO processed_payments (payment_session_id, attendee_id, processed_at) VALUES (?, NULL, ?)",
      args: [sessionId, new Date().toISOString()],
    });
    return { reserved: true };
  } catch (e) {
    const errorMsg = String(e);
    if (
      errorMsg.includes("UNIQUE constraint") ||
      errorMsg.includes("PRIMARY KEY constraint")
    ) {
      // Session already claimed - get existing record
      const existing = await isSessionProcessed(sessionId);
      if (!existing) {
        // Race condition edge case: record existed but was deleted
        // Shouldn't happen in practice, treat as reservable
        return reserveSession(sessionId);
      }

      // Check if reservation is stale (abandoned by crashed process)
      if (existing.attendee_id === null && isReservationStale(existing.processed_at)) {
        await deleteStaleReservation(sessionId);
        return reserveSession(sessionId);
      }

      return { reserved: false, existing };
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
): Promise<void> => {
  await getDb().execute({
    sql: "UPDATE processed_payments SET attendee_id = ? WHERE payment_session_id = ?",
    args: [attendeeId, sessionId],
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
