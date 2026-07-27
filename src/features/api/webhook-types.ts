/**
 * Types for webhook route handlers (payment callbacks and provider webhooks)
 */

import type { PaymentSessionClaim } from "#shared/db/payments/claims.ts";
import type { PaymentSession } from "#shared/db/payments/types.ts";
import type { PaymentClientResult } from "#shared/payment-completion.ts";
import type { PaymentResolution } from "#shared/payment-state/lifecycle.ts";
import type { BookingIntent } from "#shared/payments.ts";
import type { ListingWithCount } from "#shared/types.ts";

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
 * The reconciler only creates this work after ownership and money resolve ready.
 */
export type BookingPayment = {
  amountTotal: number;
  createdAt: string;
  id: string;
  paymentReference: string | null;
};

export type PaymentWork = {
  claim: PaymentSessionClaim;
  intent: BookingIntent;
  payment: PaymentSession;
  resolution: Extract<PaymentResolution, { status: "ready" }>;
  session: BookingPayment;
};

/** Validate listing is eligible for post-payment registration */
export type ListingValidation =
  | { ok: true; listing: ListingWithCount }
  | { ok: false; error: string; status?: number };

/** Successful payment result with created attendee details.
 * Carries the listing id rather than the loaded listing — the redirect resolves
 * it lazily only when it needs a thank-you URL, and the listing may since have
 * been deleted (e.g. a settled balance line for a removed listing) without
 * changing the fact that the attendee exists and the payment succeeded. */
/** Result of processing a payment session */
export type PaymentResult = PaymentClientResult;

/** Narrowed failure type for formatPaymentError */
export type PaymentFailureResult = PaymentResult & { success: false };
