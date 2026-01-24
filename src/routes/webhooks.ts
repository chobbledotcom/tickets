/**
 * Webhook routes - payment callbacks and Stripe webhooks
 *
 * Payment flow (race-condition safe with idempotency):
 * 1. User submits form -> Stripe session created with intent metadata (no attendee yet)
 * 2. User pays on Stripe -> redirected to /payment/success OR webhook fires
 * 3. First handler (redirect or webhook) atomically creates attendee with capacity check
 * 4. Subsequent handlers check processed_payments table for idempotency
 * 5. If capacity exceeded after payment, auto-refund and show error
 *
 * Security:
 * - Stripe webhooks are verified using HMAC-SHA256 signature
 * - Session ID alone cannot create attendees - Stripe API confirms payment status
 * - Idempotency prevents duplicate attendee creation from retries/race conditions
 */

import { createAttendeeAtomic } from "#lib/db/attendees.ts";
import { getEvent } from "#lib/db/events.ts";
import {
  isSessionProcessed,
  markSessionProcessed,
} from "#lib/db/processed-payments.ts";
import {
  type RegistrationIntent,
  refundPayment,
  retrieveCheckoutSession,
  type StripeWebhookEvent,
  verifyWebhookSignature,
} from "#lib/stripe.ts";
import type { Attendee, Event } from "#lib/types.ts";
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

/** Result type for processPaymentSession */
type PaymentResult =
  | { success: true; attendee: Attendee; event: Event }
  | { success: false; error: string; status?: number; refunded?: boolean };

/** Refund payment if intent exists and return failure result */
const refundAndFail = async (
  session: CheckoutSession,
  error: string,
  status?: number,
): Promise<PaymentResult> => {
  if (session.payment_intent) {
    await refundPayment(session.payment_intent as string);
  }
  return { success: false, error, status, refunded: true };
};

/** Core attendee creation logic shared between redirect and webhook handlers */
const processPaymentSession = async (
  sessionId: string,
  session: CheckoutSession,
  intent: RegistrationIntent,
): Promise<PaymentResult> => {
  // Idempotency check: if session already processed, return success
  const existing = await isSessionProcessed(sessionId);
  if (existing) {
    const event = await getEvent(intent.eventId);
    if (!event) {
      return { success: false, error: "Event not found", status: 404 };
    }
    // Session was already processed - this is a retry/duplicate
    return {
      success: true,
      attendee: { id: existing.attendee_id } as Attendee,
      event,
    };
  }

  // Check if event exists
  const event = await getEvent(intent.eventId);
  if (!event) {
    return refundAndFail(session, "Event not found", 404);
  }

  // Check if event is active
  if (event.active !== 1) {
    return refundAndFail(session, "This event is no longer accepting registrations.");
  }

  const paymentIntentId = session.payment_intent as string;
  const result = await createAttendeeAtomic(
    intent.eventId,
    intent.name,
    intent.email,
    paymentIntentId,
    intent.quantity,
  );

  if (!result.success) {
    await refundPayment(paymentIntentId);
    const errorMsg =
      result.reason === "capacity_exceeded"
        ? "Sorry, this event sold out while you were completing payment."
        : "Registration failed.";
    return { success: false, error: errorMsg, refunded: true };
  }

  // Mark session as processed for idempotency
  await markSessionProcessed(sessionId, result.attendee.id);

  await logAndNotifyRegistration(event, result.attendee);
  return { success: true, attendee: result.attendee, event };
};

/**
 * Handle GET /payment/success (Stripe redirect after successful payment)
 *
 * Atomically creates attendee with capacity check. If event is full after
 * payment completed, automatically refunds and shows error.
 * Uses idempotency to handle duplicate requests safely.
 */
const handlePaymentSuccess = withSessionId(async (sessionId) => {
  const validation = await validatePaidSession(sessionId);
  if (!validation.ok) return validation.response;
  const { session, intent } = validation.data;

  const result = await processPaymentSession(sessionId, session, intent);

  if (!result.success) {
    const message = result.refunded
      ? `${result.error} Your payment has been automatically refunded.`
      : result.error;
    return paymentErrorResponse(message, result.status);
  }

  return htmlResponse(paymentSuccessPage(result.event, result.event.thank_you_url));
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

/**
 * =============================================================================
 * Stripe Webhook Endpoint
 * =============================================================================
 * Handles Stripe events directly from Stripe's servers.
 * Uses signature verification for security.
 */

/** Extract checkout session data from webhook event */
const extractSessionFromEvent = (
  event: StripeWebhookEvent,
): CheckoutSession | null => {
  if (event.type !== "checkout.session.completed") {
    return null;
  }
  const obj = event.data.object;
  // Validate required fields
  if (
    typeof obj.id !== "string" ||
    typeof obj.payment_status !== "string" ||
    !obj.metadata
  ) {
    return null;
  }
  return obj as unknown as CheckoutSession;
};

/**
 * Handle POST /payment/webhook (Stripe webhook endpoint)
 *
 * Receives events directly from Stripe with signature verification.
 * Primary handler for payment completion - more reliable than redirects.
 */
const handleStripeWebhook = async (request: Request): Promise<Response> => {
  // Get signature header
  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return new Response("Missing signature", { status: 400 });
  }

  // Read raw body for signature verification
  const payload = await request.text();

  // Verify signature
  const verification = await verifyWebhookSignature(payload, signature);
  if (!verification.valid) {
    return new Response(verification.error, { status: 400 });
  }

  const event = verification.event;

  // Only handle checkout.session.completed events
  if (event.type !== "checkout.session.completed") {
    // Acknowledge other events without processing
    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  const session = extractSessionFromEvent(event);
  if (!session) {
    return new Response("Invalid session data", { status: 400 });
  }

  // Verify payment is complete
  if (session.payment_status !== "paid") {
    return new Response(JSON.stringify({ received: true, status: "pending" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  // Extract intent from metadata
  const intent = extractIntent(session);
  if (!intent) {
    return new Response("Missing registration metadata", { status: 400 });
  }

  // Process the payment (with idempotency)
  const result = await processPaymentSession(session.id, session, intent);

  if (!result.success) {
    // Log error but return 200 to prevent Stripe retries for business logic failures
    // biome-ignore lint/suspicious/noConsole: Webhook error logging
    console.error(`[Webhook] Payment processing failed: ${result.error}`);
  }

  return new Response(
    JSON.stringify({
      received: true,
      processed: result.success,
      error: result.success ? undefined : result.error,
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );
};

/** Payment routes definition */
const paymentRoutes = defineRoutes({
  "GET /payment/success": (request) => handlePaymentSuccess(request),
  "GET /payment/cancel": (request) => handlePaymentCancel(request),
  "POST /payment/webhook": (request) => handleStripeWebhook(request),
});

/**
 * Route payment requests
 */
export const routePayment = createRouter(paymentRoutes);
