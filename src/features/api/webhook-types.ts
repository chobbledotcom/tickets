/**
 * Types for webhook route handlers (payment callbacks and provider webhooks)
 */

import type {
  BookingIntent,
  ValidatedPaymentSession,
} from "#shared/payments.ts";
import type { Attendee, ListingWithCount } from "#shared/types.ts";

export type { BookingIntent };

/**
 * A paid session that carries a cryptographically valid price proof, so it is
 * provably ours. The two outcomes a valid proof can have:
 *  - `trusted`: the provider charged exactly the signed total — process it,
 *    using `agreed` as the price oracle.
 *  - `mismatch`: the provider charged a different amount than we signed —
 *    refund it. (Defensive: we create the checkout with the exact total, so this
 *    only fires if the provider charged wrong.)
 *
 * A session with no valid proof never reaches this type — it classifies as
 * `ignore` and is acknowledged without processing or refunding (see
 * classifySession). So every ValidatedSession is one we have proven is ours.
 */
export type SignedVerdict =
  | { verdict: "trusted"; agreed: number }
  | { verdict: "mismatch"; agreed: number };

/** Validated session data ready for processing */
export type ValidatedSession = {
  session: ValidatedPaymentSession;
  intent: BookingIntent;
  verdict: SignedVerdict;
};

/** Result of session validation: either valid data or an error response */
export type SessionValidation =
  | { ok: true; data: ValidatedSession }
  | { ok: false; response: Response };

/** Validate listing is eligible for post-payment registration */
export type ListingValidation =
  | { ok: true; listing: ListingWithCount }
  | { ok: false; error: string; status?: number };

/** Validate listing and compute expected price for post-payment attendee creation */
export type ListingPriceValidation =
  | { ok: true; listing: ListingWithCount; expectedPrice: number }
  | { ok: false; error: string; status?: number };

/** Successful payment result with created attendee details.
 * Carries the listing id rather than the loaded listing — the redirect resolves
 * it lazily only when it needs a thank-you URL, and the listing may since have
 * been deleted (e.g. a settled balance line for a removed listing) without
 * changing the fact that the attendee exists and the payment succeeded. */
type PaymentSuccess = {
  success: true;
  attendee: Pick<Attendee, "id">;
  listingId: number;
  ticketTokens: string[];
};

/** Failed payment result — refund status clarifies next steps for the user */
type PaymentFailure = {
  success: false;
  error: string;
  status?: number | undefined;
  refunded?: boolean | undefined;
  /** Internal diagnostic detail (not shown to users) */
  detail?: string | undefined;
};

/** Result of processing a payment session */
export type PaymentResult = PaymentSuccess | PaymentFailure;

/** Narrowed failure type for formatPaymentError */
export type PaymentFailureResult = PaymentResult & { success: false };
