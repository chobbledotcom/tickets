/**
 * Types for attendee merge operations.
 *
 * The merge flow is two-step:
 * 1. Analyze: buildAttendeeMergeDiff computes a diff between target and source.
 * 2. Apply: the admin submits explicit decisions for each conflict.
 */

import type { ListingAttendeeRow } from "#shared/db/attendee-types.ts";
import type { ContactInfo } from "#shared/types.ts";

// ---------------------------------------------------------------------------
// Choice enums
// ---------------------------------------------------------------------------

/** Which attendee's value to keep for a PII field */
export type MergeValueChoice = "target" | "source";

/** Which attendee's answer to keep for a custom question */
export type MergeAnswerChoice = "target" | "source" | "clear";

/** How to handle a source booking conflict */
export type MergeBookingChoice = "keep_target" | "take_source" | "skip_source";

/**
 * What happens to a CONFLICTING booking's money when its row is discarded by the
 * booking choice (decision 17 — a required operator choice, never a silent
 * default). The losing booking's `sale` is always un-billed (so the listing's
 * income counts the kept ticket once); the choice decides the over-collected
 * cash:
 * - `credit` — keep it as the merged person's credit (they show a negative owed).
 * - `writeoff` — park it in the `writeoff` contra account (they owe nothing; the
 *   cash is written off transparently).
 */
export type MergeMoneyChoice = "credit" | "writeoff";

// ---------------------------------------------------------------------------
// Diff (output of analyze step)
// ---------------------------------------------------------------------------

/** A single PII field comparison between target and source */
export type AttendeeMergeDiffPiiField = {
  field: string;
  label: string;
  targetValue: string;
  sourceValue: string;
  same: boolean;
  multiline: boolean;
};

/** A single custom question answer comparison */
export type AttendeeMergeDiffAnswerItem = {
  questionId: number;
  questionText: string;
  targetAnswerId: number | null;
  targetAnswerText: string | null;
  sourceAnswerId: number | null;
  sourceAnswerText: string | null;
  conflict: boolean;
};

/** Booking conflict classification */
export type BookingConflictClass =
  | "moveable"
  | "duplicate"
  | "conflicting_metadata";

/** A single listing booking comparison */
export type AttendeeMergeDiffBookingItem = {
  listingId: number;
  startAt: string | null;
  parentListingId: number;
  sourceBooking: ListingAttendeeRow;
  targetBooking: ListingAttendeeRow | null;
  conflictClass: BookingConflictClass;
  /** The source booking's recognised `sale` amount (gross ticket price) in the
   *  ledger, 0 when it carries no money. Decision 17 requires a money choice when
   *  the booking the operator discards has an amount > 0. */
  sourceSaleAmount: number;
  /** The conflicting target booking's `sale` amount; 0 for a moveable source
   *  booking (no target) or a free target. (`targetBooking === null` is the
   *  signal for "no target", so this stays a plain number.) */
  targetSaleAmount: number;
};

/** Full diff result from analyze step */
export type AttendeeMergeDiff = {
  targetId: number;
  sourceId: number;
  piiFields: AttendeeMergeDiffPiiField[];
  answerItems: AttendeeMergeDiffAnswerItem[];
  bookingItems: AttendeeMergeDiffBookingItem[];
  /** Version hash for stale-preview detection */
  version: string;
};

// ---------------------------------------------------------------------------
// Decision input (submitted by admin)
// ---------------------------------------------------------------------------

/** Per-PII-field decision */
export type AttendeeMergeDecisionPii = Record<string, MergeValueChoice>;

/** Per-question decision */
export type AttendeeMergeDecisionAnswers = Record<string, MergeAnswerChoice>;

/** Per-booking decision (keyed by "listingId:startAt:parentListingId") */
export type AttendeeMergeDecisionBookings = Record<string, MergeBookingChoice>;

/** Per-conflict money decision (keyed by "listingId:startAt:parentListingId"), required when the
 *  booking the operator discards carries money (decision 17). */
export type AttendeeMergeDecisionMoney = Record<string, MergeMoneyChoice>;

/** Full decision payload from the form */
export type AttendeeMergeDecisionInput = {
  pii: AttendeeMergeDecisionPii;
  answers: AttendeeMergeDecisionAnswers;
  bookings: AttendeeMergeDecisionBookings;
  money: AttendeeMergeDecisionMoney;
  version: string;
};

// ---------------------------------------------------------------------------
// Validation result
// ---------------------------------------------------------------------------

export type AttendeeMergeValidationResult =
  | { valid: true }
  | { valid: false; errors: string[] };

// ---------------------------------------------------------------------------
// Apply result
// ---------------------------------------------------------------------------

/** Summary of what the merge did */
export type AttendeeMergeApplySummary = {
  piiFieldsFromSource: string[];
  answersKept: number;
  answersTakenFromSource: number;
  answersCleared: number;
  bookingsMoved: number;
  bookingsSkipped: number;
  bookingsReplacedTarget: number;
  /** Conflicting bookings whose money was kept as the person's credit. */
  bookingsCredited: number;
  /** Conflicting bookings whose money was written off (decision 17). */
  bookingsWrittenOff: number;
};

/** Result of applying a merge */
export type AttendeeMergeApplyResult = {
  success: true;
  summary: AttendeeMergeApplySummary;
};

// ---------------------------------------------------------------------------
// Service function input types
// ---------------------------------------------------------------------------

export type BuildAttendeeMergeDiffInput = {
  targetId: number;
  sourceId: number;
  targetPii: ContactInfo;
  sourcePii: ContactInfo;
  targetBookings: ListingAttendeeRow[];
  sourceBookings: ListingAttendeeRow[];
};

export type ApplyAttendeeMergeInput = {
  targetId: number;
  sourceId: number;
  targetPii: ContactInfo & { payment_id: string; ticket_token: string };
  sourcePii: ContactInfo;
  diff: AttendeeMergeDiff;
  decision: AttendeeMergeDecisionInput;
  /** Owner private key, used to decrypt the target's free-text answers so they
   * survive the answer re-save. */
  privateKey: CryptoKey;
};
