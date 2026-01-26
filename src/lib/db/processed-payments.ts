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
 * - Still processing (attendee_id NULL) → return conflict error
 */

import { getDb, queryOne } from "#lib/db/client.ts";

/** Processed payment record */
export type ProcessedPayment = {
  stripe_session_id: string;
  attendee_id: number | null;
  processed_at: string;
};

/** Result of session reservation attempt */
export type ReserveSessionResult =
  | { reserved: true }
  | { reserved: false; existing: ProcessedPayment };

/**
 * Check if a Stripe session has already been processed
 */
export const isSessionProcessed = (
  stripeSessionId: string,
): Promise<ProcessedPayment | null> =>
  queryOne<ProcessedPayment>(
    "SELECT stripe_session_id, attendee_id, processed_at FROM processed_payments WHERE stripe_session_id = ?",
    [stripeSessionId],
  );

/**
 * Reserve a Stripe session for processing (first phase of two-phase lock)
 * Inserts with NULL attendee_id to claim the session.
 * Returns { reserved: true } if we claimed it, or { reserved: false, existing } if already claimed.
 */
export const reserveSession = async (
  stripeSessionId: string,
): Promise<ReserveSessionResult> => {
  try {
    await getDb().execute({
      sql: "INSERT INTO processed_payments (stripe_session_id, attendee_id, processed_at) VALUES (?, NULL, ?)",
      args: [stripeSessionId, new Date().toISOString()],
    });
    return { reserved: true };
  } catch (e) {
    const errorMsg = String(e);
    if (
      errorMsg.includes("UNIQUE constraint") ||
      errorMsg.includes("PRIMARY KEY constraint")
    ) {
      // Session already claimed - get existing record
      const existing = await isSessionProcessed(stripeSessionId);
      if (!existing) {
        // Race condition edge case: record existed but was deleted
        // Shouldn't happen in practice, treat as reservable
        return reserveSession(stripeSessionId);
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
  stripeSessionId: string,
  attendeeId: number,
): Promise<void> => {
  await getDb().execute({
    sql: "UPDATE processed_payments SET attendee_id = ? WHERE stripe_session_id = ?",
    args: [attendeeId, stripeSessionId],
  });
};

/**
 * Get the attendee ID for an already-processed session
 * Used to return success for idempotent webhook retries
 */
export const getProcessedAttendeeId = async (
  stripeSessionId: string,
): Promise<number | null> => {
  const result = await isSessionProcessed(stripeSessionId);
  return result?.attendee_id ?? null;
};
