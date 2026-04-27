/**
 * Types for webhook route handlers (payment callbacks and provider webhooks)
 */

import type {
  BookingIntent,
  ValidatedPaymentSession,
} from "#shared/payments.ts";
import type { Attendee, EventWithCount } from "#shared/types.ts";

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

/** Validate event is eligible for post-payment registration */
export type EventValidation =
  | { ok: true; event: EventWithCount }
  | { ok: false; error: string; status?: number };

/** Validate event and compute expected price for post-payment attendee creation */
export type EventPriceValidation =
  | { ok: true; event: EventWithCount; expectedPrice: number }
  | { ok: false; error: string; status?: number };

/** Successful payment result with created attendee details */
type PaymentSuccess = {
  success: true;
  attendee: Pick<Attendee, "id">;
  event: EventWithCount;
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
