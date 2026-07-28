/**
 * The words a payment record is allowed to use.
 *
 * Both the tables and the checks the code runs are built from these, so the
 * database and the code can never disagree about what a payment may say. This
 * module deliberately imports nothing: the tables are read while a site is
 * migrating, and nothing else should be dragged along with them.
 */

/** Where a payment has got to. */
export const PAYMENT_STATES = [
  "created",
  "pending",
  "ready",
  "processing",
  "completed",
  "failed",
  "refunding",
  "fully_refunded",
  "needs_action",
] as const;

/** Where a problem for the owner has got to. */
export const CASE_STATES = ["retrying", "needs_action", "resolved"] as const;

/** Where a refund has got to. "unknown" belongs only to money copied from an
 *  older version, whose record never said what became of its refund. */
export const REFUND_STATES = [
  "none",
  "requested",
  "pending",
  "partial",
  "completed",
  "failed",
  "unknown",
] as const;

/** Where the owner's decision has got to. */
export const DECISION_STATES = [
  "accepted",
  "running",
  "retrying",
  "completed",
] as const;

/** How a payment turned out. */
export const RESULT_STATES = ["none", "succeeded", "failed"] as const;

/** Whether tickets are ready, and whether they have been used. */
export const TICKET_STATES = ["none", "ready", "consumed"] as const;

/** Whether the work after payment is still going. */
export const COMPLETION_STATES = [
  "none",
  "pending",
  "completed",
  "legacy_unknown",
] as const;

/** Whether a record was made here or copied across when the site upgraded. */
export const RECORD_ORIGINS = ["current", "legacy"] as const;

/** Whether a payment was real money or a test. */
export const PAYMENT_MODES = ["test", "live"] as const;

/** What each provider calls the money it took. */
export const RESOURCE_KINDS = [
  "stripe_payment_intent",
  "square_payment",
  "sumup_transaction",
] as const;

/** Which old table a copied charge came from. */
export const LEGACY_SOURCES = [
  "processed_payments",
  "attendees.pii_blob",
  "attendee_merge",
] as const;

/** The states a payment has finished in, however it got there. */
export const SETTLED_STATES = [
  "completed",
  "failed",
  "fully_refunded",
] as const;
