import type { PaymentProviderType } from "#shared/types.ts";

/**
 * The words a payment record is allowed to use.
 *
 * Both the tables and the checks the code runs are built from these, so the
 * database and the code can never disagree about what a payment may say. This
 * module takes only a type, which costs nothing at run time: the tables are
 * read while a site is migrating, and nothing else should be dragged along
 * with them.
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
export type ResultState = (typeof RESULT_STATES)[number];

/** Whether tickets are ready, and whether they have been used. */
export const TICKET_STATES = ["none", "ready", "consumed"] as const;
export type TicketState = (typeof TICKET_STATES)[number];

/** Whether the work after payment is still going. */
export const COMPLETION_STATES = [
  "none",
  "pending",
  "completed",
  "legacy_unknown",
] as const;
export type CompletionState = (typeof COMPLETION_STATES)[number];

/** Whether a record was made here or copied across when the site upgraded. */
export const RECORD_ORIGINS = ["current", "legacy"] as const;
export type RecordOrigin = (typeof RECORD_ORIGINS)[number];

/** Whether a payment was real money or a test. */
export const PAYMENT_MODES = ["test", "live"] as const;

/** What each provider calls the money it took. Keyed by provider rather than
 *  lined up beside it, so adding a provider without saying what it calls its
 *  money is a compile error rather than a silently mismatched pair. */
export const RESOURCE_KIND_BY_PROVIDER = {
  square: "square_payment",
  stripe: "stripe_payment_intent",
  sumup: "sumup_transaction",
} as const satisfies Record<PaymentProviderType, string>;

/** Which old table a copied charge came from. */
export const LEGACY_SOURCES = [
  "processed_payments",
  "attendees.pii_blob",
  "attendee_merge",
] as const;
