/**
 * Pure value types for the double-entry transfer ledger.
 *
 * The ledger is context-free: it knows accounts, transfers, balances, and
 * invariants — nothing about attendees, listings, or payment providers. The host
 * maps its domain onto these types (see accounting-plan.md). Time, ids, and
 * references are inputs supplied by the caller, never effects performed here.
 */

/**
 * An account is a (type, id) pair. Both are opaque strings to the ledger; the
 * host assigns meaning (`revenue:<listingId>`, `attendee:<id>`,
 * `external:world`, …). Row-backed accounts use the stringified row id;
 * singletons use a fixed id.
 */
export type AccountRef = { readonly type: string; readonly id: string };

/**
 * A positive integer amount in minor units (pence/cents). The ledger never
 * divides or formats — decimal places and rendering are the host's concern.
 */
export type MinorUnits = number;

/**
 * The data needed to post one transfer. `occurredAt`, `reference`, and
 * `eventGroup` are supplied by the caller — the ledger reads no clock and
 * generates no ids. `reference` is an opaque, non-reversible idempotency key (an
 * HMAC or UUID), never a payment-provider id.
 */
export type TransferInput = {
  readonly source: AccountRef;
  readonly destination: AccountRef;
  /** Positive minor units; direction is encoded by source/destination. */
  readonly amount: MinorUnits;
  /** ISO-4217 code, opaque to the ledger. */
  readonly currency: string;
  /** ISO timestamp — the business time the money moved. */
  readonly occurredAt: string;
  /** Opaque, non-reversible, per-leg idempotency key. */
  readonly reference: string;
  /** Shared across every leg of one business event (a booking/refund/…). */
  readonly eventGroup: string;
  /** Host-defined category, opaque to the ledger (e.g. "sale", "refund_cash"). */
  readonly kind?: string;
  /**
   * Optional human-readable reason. Kept PII-free by convention (prefer codes
   * and ids over names); if free text that could contain PII is stored, the host
   * MUST encrypt it with the owner key before persisting — the ledger treats it
   * as an opaque string, never parses it, and never logs it.
   */
  readonly memo?: string;
  /** The transfer this one reverses/corrects (admin void/correction only). */
  readonly reversesId?: number;
  /** Actor: "system" or an admin user id. */
  readonly postedBy?: string;
};

/**
 * A persisted transfer: an input plus the assigned surrogate id and record
 * time. Projections operate on this shape.
 */
export type Transfer = TransferInput & {
  readonly id: number;
  /** ISO timestamp the row was written (vs `occurredAt`, the business time). */
  readonly recordedAt: string;
};

/** Why a {@link TransferInput} was rejected by `validateTransfer`. */
export type LedgerError =
  | { readonly code: "non_positive_amount" }
  | { readonly code: "non_integer_amount" }
  | { readonly code: "unsafe_amount" }
  | { readonly code: "invalid_occurred_at" }
  | { readonly code: "self_transfer" }
  | { readonly code: "empty_account" }
  | { readonly code: "reserved_char_in_account" }
  | { readonly code: "empty_currency" }
  | { readonly code: "empty_reference" }
  | { readonly code: "empty_event_group" };

/** A validation result: the value, or every reason it was rejected. */
export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: LedgerError[] };
