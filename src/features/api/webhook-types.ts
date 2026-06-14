/**
 * Types for webhook route handlers (payment callbacks and provider webhooks)
 */

import type {
  BookingIntent,
  ValidatedPaymentSession,
} from "#shared/payments.ts";
import type { Attendee, ListingWithCount } from "#shared/types.ts";

export type { BookingIntent };

/** Validated session data ready for processing */
export type ValidatedSession = {
  session: ValidatedPaymentSession;
  intent: BookingIntent;
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

/** Successful payment result with created attendee details */
type PaymentSuccess = {
  success: true;
  attendee: Pick<Attendee, "id">;
  listing: ListingWithCount;
  ticketTokens: string[];
};

/** Failed payment result — refund status clarifies next steps for the user */
type PaymentFailure = {
  success: false;
  error: string;
  status?: number;
  refunded?: boolean;
  /** Internal diagnostic detail (not shown to users) */
  detail?: string;
};

/** Result of processing a payment session */
export type PaymentResult = PaymentSuccess | PaymentFailure;

/** Narrowed failure type for formatPaymentError */
export type PaymentFailureResult = PaymentResult & { success: false };
