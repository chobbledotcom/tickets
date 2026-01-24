/**
 * Processed payments table operations (idempotency for webhook handling)
 *
 * Tracks Stripe session IDs that have been processed to prevent:
 * - Duplicate attendee creation from webhook retries
 * - Race conditions between redirect and webhook handlers
 */

import { getDb, queryOne } from "#lib/db/client.ts";

/** Processed payment record */
export type ProcessedPayment = {
  stripe_session_id: string;
  attendee_id: number;
  processed_at: string;
};

/**
 * Check if a Stripe session has already been processed
 */
export const isSessionProcessed = async (
  stripeSessionId: string,
): Promise<ProcessedPayment | null> => {
  return queryOne<ProcessedPayment>(
    "SELECT stripe_session_id, attendee_id, processed_at FROM processed_payments WHERE stripe_session_id = ?",
    [stripeSessionId],
  );
};

/**
 * Mark a Stripe session as processed (atomically with attendee creation)
 * Returns false if session was already processed (idempotency check)
 */
export const markSessionProcessed = async (
  stripeSessionId: string,
  attendeeId: number,
): Promise<boolean> => {
  try {
    await getDb().execute({
      sql: "INSERT INTO processed_payments (stripe_session_id, attendee_id, processed_at) VALUES (?, ?, ?)",
      args: [stripeSessionId, attendeeId, new Date().toISOString()],
    });
    return true;
  } catch {
    // Unique constraint violation - session already processed
    return false;
  }
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
