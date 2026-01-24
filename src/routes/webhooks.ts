/**
 * Webhook routes - payment callbacks
 *
 * Payment flow (race-condition safe):
 * 1. User submits form -> Stripe session created with intent metadata (no attendee yet)
 * 2. User pays on Stripe -> redirected to /payment/success
 * 3. /payment/success atomically creates attendee with capacity check
 * 4. If capacity exceeded after payment, auto-refund and show error
 */

import {
  type CreateAttendeeResult,
  createAttendeeAtomic,
} from "#lib/db/attendees.ts";
import { getEvent } from "#lib/db/events.ts";
import {
  type RegistrationIntent,
  refundPayment,
  retrieveCheckoutSession,
} from "#lib/stripe.ts";
import type { Event } from "#lib/types.ts";
import { logAndNotifyRegistration } from "#lib/webhook.ts";
import { createRouter, defineRoutes } from "#routes/router.ts";
import {
  getSearchParam,
  htmlResponse,
  paymentErrorResponse,
} from "#routes/utils.ts";
import { paymentCancelPage, paymentSuccessPage } from "#templates/payment.tsx";

/** Stripe checkout session type */
type CheckoutSession = NonNullable<
  Awaited<ReturnType<typeof retrieveCheckoutSession>>
>;

/** Extract registration intent from Stripe session metadata */
const extractIntent = (session: CheckoutSession): RegistrationIntent | null => {
  const { metadata } = session;
  if (!metadata?.event_id || !metadata?.name || !metadata?.email) {
    return null;
  }
  return {
    eventId: Number.parseInt(metadata.event_id, 10),
    name: metadata.name,
    email: metadata.email,
    quantity: Number.parseInt(metadata.quantity || "1", 10),
  };
};

/** Wrap handler with session ID extraction */
const withSessionId =
  (handler: (sessionId: string) => Promise<Response>) =>
  (request: Request): Promise<Response> => {
    const sessionId = getSearchParam(request, "session_id");
    return sessionId
      ? handler(sessionId)
      : Promise.resolve(paymentErrorResponse("Invalid payment callback"));
  };

/** Validate session is retrieved and paid */
type ValidatedSession = {
  session: CheckoutSession;
  intent: RegistrationIntent;
};
type SessionValidation =
  | { ok: true; data: ValidatedSession }
  | { ok: false; response: Response };

const validatePaidSession = async (
  sessionId: string,
): Promise<SessionValidation> => {
  const session = await retrieveCheckoutSession(sessionId);
  if (!session) {
    return {
      ok: false,
      response: paymentErrorResponse("Payment session not found"),
    };
  }
  if (session.payment_status !== "paid") {
    return {
      ok: false,
      response: paymentErrorResponse(
        "Payment verification failed. Please contact support.",
      ),
    };
  }
  const intent = extractIntent(session);
  if (!intent) {
    return {
      ok: false,
      response: paymentErrorResponse("Invalid payment session data"),
    };
  }
  return { ok: true, data: { session, intent } };
};

/** Load and validate event for payment callback */
const loadEventForPayment = async (
  eventId: number,
): Promise<{ event: Event } | { error: Response }> => {
  const event = await getEvent(eventId);
  if (!event) {
    return { error: paymentErrorResponse("Event not found", 404) };
  }
  if (event.active !== 1) {
    return {
      error: paymentErrorResponse(
        "This event is no longer accepting registrations.",
      ),
    };
  }
  return { event };
};

/** Handle failed attendee creation with refund */
const handleFailedCreation = async (
  result: Extract<CreateAttendeeResult, { success: false }>,
  paymentIntentId: string,
): Promise<Response> => {
  await refundPayment(paymentIntentId);

  if (result.reason === "capacity_exceeded") {
    return paymentErrorResponse(
      "Sorry, this event sold out while you were completing payment. " +
        "Your payment has been automatically refunded.",
    );
  }
  return paymentErrorResponse(
    "Registration failed. Your payment has been refunded.",
  );
};

/**
 * Handle GET /payment/success (Stripe redirect after successful payment)
 *
 * Atomically creates attendee with capacity check. If event is full after
 * payment completed, automatically refunds and shows error.
 */
const handlePaymentSuccess = withSessionId(async (sessionId) => {
  const validation = await validatePaidSession(sessionId);
  if (!validation.ok) return validation.response;
  const { session, intent } = validation.data;

  const eventResult = await loadEventForPayment(intent.eventId);
  if ("error" in eventResult) {
    if (session.payment_intent) {
      await refundPayment(session.payment_intent as string);
    }
    return eventResult.error;
  }
  const { event } = eventResult;

  const paymentIntentId = session.payment_intent as string;
  const result = await createAttendeeAtomic(
    intent.eventId,
    intent.name,
    intent.email,
    paymentIntentId,
    intent.quantity,
  );

  if (!result.success) {
    return handleFailedCreation(result, paymentIntentId);
  }

  await logAndNotifyRegistration(event, result.attendee);
  return htmlResponse(paymentSuccessPage(event, event.thank_you_url));
});

/**
 * Handle GET /payment/cancel (Stripe redirect after cancelled payment)
 *
 * No attendee cleanup needed - attendee is only created after successful payment.
 */
const handlePaymentCancel = withSessionId(async (sid) => {
  const session = await retrieveCheckoutSession(sid);
  if (!session) {
    return paymentErrorResponse("Payment session not found");
  }

  const intent = extractIntent(session);
  if (!intent) {
    return paymentErrorResponse("Invalid payment session data");
  }

  const event = await getEvent(intent.eventId);
  if (!event) {
    return paymentErrorResponse("Event not found", 404);
  }

  return htmlResponse(paymentCancelPage(event, `/ticket/${event.slug}`));
});

/** Payment routes definition */
const paymentRoutes = defineRoutes({
  "GET /payment/success": (request) => handlePaymentSuccess(request),
  "GET /payment/cancel": (request) => handlePaymentCancel(request),
});

/**
 * Route payment requests
 */
export const routePayment = createRouter(paymentRoutes);
