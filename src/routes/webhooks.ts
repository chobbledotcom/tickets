/**
 * Webhook routes - payment callbacks and Stripe webhooks
 *
 * Payment flow (race-condition safe with two-phase locking):
 * 1. User submits form -> Stripe session created with intent metadata (no attendee yet)
 * 2. User pays on Stripe -> redirected to /payment/success OR webhook fires
 * 3. First handler reserves session (DB lock), creates attendee, finalizes lock
 * 4. Subsequent handlers see reserved/finalized session and return existing attendee
 * 5. If capacity exceeded after payment, auto-refund and show error
 *
 * Security:
 * - Stripe webhooks are verified using HMAC-SHA256 signature
 * - Session ID alone cannot create attendees - Stripe API confirms payment status
 * - Two-phase locking prevents duplicate attendee creation from race conditions
 */

import type Stripe from "stripe";
import { createAttendeeAtomic, deleteAttendee } from "#lib/db/attendees.ts";
import { getEvent, getEventWithCount } from "#lib/db/events.ts";
import {
  finalizeSession,
  reserveSession,
} from "#lib/db/processed-payments.ts";
import { ErrorCode, logError } from "#lib/logger.ts";
import {
  type RegistrationIntent,
  refundPayment,
  retrieveCheckoutSession,
  type StripeWebhookEvent,
  verifyWebhookSignature,
} from "#lib/stripe.ts";
import type { Attendee, EventWithCount } from "#lib/types.ts";
import { logAndNotifyRegistration } from "#lib/webhook.ts";
import { createRouter, defineRoutes } from "#routes/router.ts";
import {
  getSearchParam,
  htmlResponse,
  paymentErrorResponse,
} from "#routes/utils.ts";
import { paymentCancelPage, paymentSuccessPage } from "#templates/payment.tsx";

/** Parsed multi-ticket item from metadata */
type MultiItem = { e: number; q: number };

/** Common metadata structure for Stripe checkout sessions */
type SessionMetadata = {
  event_id?: string;
  name: string;
  email: string;
  quantity?: string;
  multi?: string;
  items?: string;
};

/**
 * Validated Stripe checkout session with required fields for payment processing.
 * Uses strict types instead of Record<string, unknown>.
 */
type ValidatedCheckoutSession = {
  id: string;
  payment_status: "paid" | "unpaid" | "no_payment_required";
  payment_intent: string | null;
  metadata: SessionMetadata;
};

/** Check if session is a multi-ticket session */
const isMultiSession = (metadata: SessionMetadata): boolean =>
  metadata.multi === "1" && typeof metadata.items === "string";

/**
 * Type guard to validate a Stripe checkout session has required fields.
 * Returns a strictly-typed session or null if validation fails.
 * Supports both single-event and multi-event sessions.
 */
const validateCheckoutSession = (
  session: Stripe.Checkout.Session,
): ValidatedCheckoutSession | null => {
  const { id, payment_status, payment_intent, metadata } = session;

  if (typeof id !== "string" || typeof payment_status !== "string") {
    return null;
  }

  if (!metadata?.name || !metadata?.email) {
    return null;
  }

  // Multi-ticket sessions have items instead of event_id
  const isMulti = isMultiSession(metadata as SessionMetadata);
  if (!isMulti && !metadata?.event_id) {
    return null;
  }

  return {
    id,
    payment_status: payment_status as ValidatedCheckoutSession["payment_status"],
    payment_intent:
      typeof payment_intent === "string" ? payment_intent : null,
    metadata: {
      event_id: metadata.event_id,
      name: metadata.name,
      email: metadata.email,
      quantity: metadata.quantity,
      multi: metadata.multi,
      items: metadata.items,
    },
  };
};

/** Extract registration intent from validated session metadata (single-ticket only) */
const extractIntent = (
  session: ValidatedCheckoutSession,
): RegistrationIntent => ({
  eventId: Number.parseInt(session.metadata.event_id ?? "0", 10),
  name: session.metadata.name,
  email: session.metadata.email,
  quantity: Number.parseInt(session.metadata.quantity || "1", 10),
});

/** Wrap handler with session ID extraction */
const withSessionId =
  (handler: (sessionId: string) => Promise<Response>) =>
  (request: Request): Promise<Response> => {
    const sessionId = getSearchParam(request, "session_id");
    return sessionId
      ? handler(sessionId)
      : Promise.resolve(paymentErrorResponse("Invalid payment callback"));
  };

/** Validated session data - either single or multi */
type ValidatedSession =
  | { type: "single"; session: ValidatedCheckoutSession; intent: RegistrationIntent }
  | { type: "multi"; session: ValidatedCheckoutSession; intent: MultiIntent };

type SessionValidation =
  | { ok: true; data: ValidatedSession }
  | { ok: false; response: Response };

const validatePaidSession = async (
  sessionId: string,
): Promise<SessionValidation> => {
  const rawSession = await retrieveCheckoutSession(sessionId);
  if (!rawSession) {
    return {
      ok: false,
      response: paymentErrorResponse("Payment session not found"),
    };
  }

  const session = validateCheckoutSession(rawSession);
  if (!session) {
    return {
      ok: false,
      response: paymentErrorResponse("Invalid payment session data"),
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

  // Check if this is a multi-ticket session
  if (isMultiSession(session.metadata)) {
    const multiIntent = extractMultiIntent(session);
    if (!multiIntent) {
      return {
        ok: false,
        response: paymentErrorResponse("Invalid multi-ticket session data"),
      };
    }
    return { ok: true, data: { type: "multi", session, intent: multiIntent } };
  }

  const intent = extractIntent(session);
  return { ok: true, data: { type: "single", session, intent } };
};

/** Result type for processPaymentSession */
type PaymentResult =
  | { success: true; attendee: Attendee; event: EventWithCount }
  | { success: false; error: string; status?: number; refunded?: boolean };

/**
 * Attempt to refund a payment intent. Returns true if refund succeeded, false otherwise.
 * Logs an error if refund fails.
 */
const tryRefund = async (paymentIntentId: string | null): Promise<boolean> => {
  if (!paymentIntentId) return false;

  const refundResult = await refundPayment(paymentIntentId);
  const refunded = refundResult !== null;

  if (!refunded) {
    logError({
      code: ErrorCode.STRIPE_REFUND,
      detail: `Failed to refund payment intent ${paymentIntentId}`,
    });
  }

  return refunded;
};

/**
 * Attempt to refund payment and return failure result.
 * Reports refund status accurately based on API result.
 */
const refundAndFail = async (
  session: ValidatedCheckoutSession,
  error: string,
  status?: number,
): Promise<PaymentResult> => {
  const refunded = await tryRefund(session.payment_intent);
  return { success: false, error, status, refunded };
};

/** Return success result for an already-processed session */
const alreadyProcessedResult = async (
  eventId: number,
  attendeeId: number,
): Promise<PaymentResult> => {
  const event = await getEventWithCount(eventId);
  if (!event) return { success: false, error: "Event not found", status: 404 };
  return { success: true, attendee: { id: attendeeId } as Attendee, event };
};

/** Parse multi-ticket items from metadata */
const parseMultiItems = (itemsJson: string): MultiItem[] | null => {
  try {
    const parsed = JSON.parse(itemsJson);
    if (!Array.isArray(parsed)) return null;
    return parsed as MultiItem[];
  } catch {
    return null;
  }
};

/** Multi-ticket registration intent */
type MultiIntent = {
  name: string;
  email: string;
  items: MultiItem[];
};

/** Extract multi-ticket intent from session metadata */
const extractMultiIntent = (
  session: ValidatedCheckoutSession,
): MultiIntent | null => {
  const { metadata } = session;
  if (!metadata.items) return null;

  const items = parseMultiItems(metadata.items);
  if (!items || items.length === 0) return null;

  return {
    name: metadata.name,
    email: metadata.email,
    items,
  };
};

/**
 * Process multi-ticket payment session.
 * Creates attendees for all events atomically.
 * If any creation fails, deletes already-created attendees and refunds.
 */
const processMultiPaymentSession = async (
  sessionId: string,
  session: ValidatedCheckoutSession,
  intent: MultiIntent,
): Promise<PaymentResult> => {
  // Phase 1: Reserve the session
  const reservation = await reserveSession(sessionId);

  if (!reservation.reserved) {
    const { existing } = reservation;

    if (existing.attendee_id !== null) {
      const firstEventId = intent.items[0]?.e;
      if (!firstEventId) {
        return { success: false, error: "Invalid session data", status: 400 };
      }
      return alreadyProcessedResult(firstEventId, existing.attendee_id);
    }

    // Still being processed by another request
    return {
      success: false,
      error: "Payment is being processed. Please wait a moment and refresh.",
      status: 409,
    };
  }

  // Phase 2: Create attendees for all events
  const createdAttendees: { attendee: Attendee; event: EventWithCount }[] = [];
  let failedEvent: EventWithCount | null = null;
  let failureReason: "capacity_exceeded" | "encryption_error" | null = null;

  for (const item of intent.items) {
    const event = await getEventWithCount(item.e);
    if (!event) {
      // Event not found - rollback and refund
      for (const created of createdAttendees) {
        await deleteAttendee(created.attendee.id);
      }
      return refundAndFail(session, "Event not found", 404);
    }

    if (event.active !== 1) {
      // Event no longer active - rollback and refund
      for (const created of createdAttendees) {
        await deleteAttendee(created.attendee.id);
      }
      return refundAndFail(
        session,
        `${event.slug} is no longer accepting registrations.`,
      );
    }

    const result = await createAttendeeAtomic(
      item.e,
      intent.name,
      intent.email,
      session.payment_intent,
      item.q,
    );

    if (!result.success) {
      failedEvent = event;
      failureReason = result.reason;
      break;
    }

    createdAttendees.push({ attendee: result.attendee, event });
  }

  // If any creation failed, rollback all created attendees and refund
  if (failedEvent && failureReason) {
    for (const created of createdAttendees) {
      await deleteAttendee(created.attendee.id);
    }

    const refunded = await tryRefund(session.payment_intent);
    const errorMsg =
      failureReason === "capacity_exceeded"
        ? `Sorry, ${failedEvent.slug} sold out while you were completing payment.`
        : "Registration failed.";
    return { success: false, error: errorMsg, refunded };
  }

  // Phase 3: Finalize with first attendee ID (for idempotency tracking)
  const firstAttendee = createdAttendees[0];
  if (!firstAttendee) {
    return refundAndFail(session, "No attendees created", 500);
  }

  await finalizeSession(sessionId, firstAttendee.attendee.id);

  // Log and notify for all created attendees
  for (const { event, attendee } of createdAttendees) {
    await logAndNotifyRegistration(event, attendee);
  }

  return {
    success: true,
    attendee: firstAttendee.attendee,
    event: firstAttendee.event,
  };
};

/**
 * Core attendee creation logic shared between redirect and webhook handlers.
 * Uses two-phase locking to prevent duplicate attendee creation:
 * 1. Reserve session (claims the lock)
 * 2. Create attendee atomically
 * 3. Finalize session (records attendee ID)
 */
const processPaymentSession = async (
  sessionId: string,
  session: ValidatedCheckoutSession,
  intent: RegistrationIntent,
): Promise<PaymentResult> => {
  // Phase 1: Try to reserve the session (claim the lock)
  const reservation = await reserveSession(sessionId);

  if (!reservation.reserved) {
    // Session already claimed by another request
    const { existing } = reservation;

    if (existing.attendee_id !== null) {
      return alreadyProcessedResult(intent.eventId, existing.attendee_id);
    }

    // Session reserved but not finalized - another request is processing
    // This is a race condition where both arrived at nearly the same time
    // Return a conflict error (the other request will complete the work)
    return {
      success: false,
      error: "Payment is being processed. Please wait a moment and refresh.",
      status: 409,
    };
  }

  // We have the lock - proceed with attendee creation

  // Check if event exists
  const event = await getEventWithCount(intent.eventId);
  if (!event) {
    return refundAndFail(session, "Event not found", 404);
  }

  // Check if event is active
  if (event.active !== 1) {
    return refundAndFail(
      session,
      "This event is no longer accepting registrations.",
    );
  }

  // Phase 2: Create attendee atomically with capacity check
  const paymentIntentId = session.payment_intent;
  const result = await createAttendeeAtomic(
    intent.eventId,
    intent.name,
    intent.email,
    paymentIntentId,
    intent.quantity,
  );

  if (!result.success) {
    const refunded = await tryRefund(paymentIntentId);
    const errorMsg =
      result.reason === "capacity_exceeded"
        ? "Sorry, this event sold out while you were completing payment."
        : "Registration failed.";
    return { success: false, error: errorMsg, refunded };
  }

  // Phase 3: Finalize the session with the attendee ID
  await finalizeSession(sessionId, result.attendee.id);

  await logAndNotifyRegistration(event, result.attendee);
  return { success: true, attendee: result.attendee, event };
};

/**
 * Format error message based on refund status
 */
const formatPaymentError = (result: PaymentResult & { success: false }): string => {
  if (result.refunded === true) {
    return `${result.error} Your payment has been automatically refunded.`;
  }
  if (result.refunded === false) {
    return `${result.error} Please contact support for a refund.`;
  }
  return result.error;
};

/**
 * Handle GET /payment/success (Stripe redirect after successful payment)
 *
 * Atomically creates attendee with capacity check. If event is full after
 * payment completed, automatically refunds and shows error.
 * Uses two-phase locking to handle duplicate requests safely.
 */
const handlePaymentSuccess = withSessionId(async (sessionId) => {
  const validation = await validatePaidSession(sessionId);
  if (!validation.ok) return validation.response;

  const { data } = validation;
  const result =
    data.type === "multi"
      ? await processMultiPaymentSession(sessionId, data.session, data.intent)
      : await processPaymentSession(sessionId, data.session, data.intent);

  if (!result.success) {
    return paymentErrorResponse(formatPaymentError(result), result.status);
  }

  // For multi-ticket, don't redirect to thank_you_url (different events may have different URLs)
  const thankYouUrl =
    data.type === "single" ? result.event.thank_you_url : null;
  return htmlResponse(paymentSuccessPage(result.event, thankYouUrl));
});

/**
 * Handle GET /payment/cancel (Stripe redirect after cancelled payment)
 *
 * No attendee cleanup needed - attendee is only created after successful payment.
 */
const handlePaymentCancel = withSessionId(async (sid) => {
  const rawSession = await retrieveCheckoutSession(sid);
  if (!rawSession) {
    return paymentErrorResponse("Payment session not found");
  }

  const session = validateCheckoutSession(rawSession);
  if (!session) {
    return paymentErrorResponse("Invalid payment session data");
  }

  const intent = extractIntent(session);

  // Use getEvent (not getEventWithCount) - we only need slug for redirect
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

/**
 * Validated webhook session data with required fields.
 */
type WebhookSessionData = {
  id: string;
  payment_status: string;
  payment_intent: string | null;
  metadata: SessionMetadata;
};

/**
 * Validate webhook event data and extract session.
 * Returns null if event type doesn't match or data is invalid.
 * Supports both single-event and multi-event sessions.
 */
const extractSessionFromEvent = (
  event: StripeWebhookEvent,
): ValidatedCheckoutSession | null => {
  if (event.type !== "checkout.session.completed") {
    return null;
  }

  const obj = event.data.object as Partial<WebhookSessionData>;

  // Validate required fields with strict type checking
  if (
    typeof obj.id !== "string" ||
    typeof obj.payment_status !== "string" ||
    !obj.metadata ||
    typeof obj.metadata.name !== "string" ||
    typeof obj.metadata.email !== "string"
  ) {
    return null;
  }

  // Multi-ticket sessions have items instead of event_id
  const isMulti =
    obj.metadata.multi === "1" && typeof obj.metadata.items === "string";
  if (!isMulti && typeof obj.metadata.event_id !== "string") {
    return null;
  }

  return {
    id: obj.id,
    payment_status: obj.payment_status as ValidatedCheckoutSession["payment_status"],
    payment_intent:
      typeof obj.payment_intent === "string" ? obj.payment_intent : null,
    metadata: {
      event_id: obj.metadata.event_id,
      name: obj.metadata.name,
      email: obj.metadata.email,
      quantity: obj.metadata.quantity,
      multi: obj.metadata.multi,
      items: obj.metadata.items,
    },
  };
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

  // Determine if this is a multi-ticket session and process accordingly
  const isMulti = isMultiSession(session.metadata);
  let result: PaymentResult;

  let eventIdForLog: number | undefined;

  if (isMulti) {
    const multiIntent = extractMultiIntent(session);
    if (!multiIntent) {
      return new Response("Invalid multi-ticket session data", { status: 400 });
    }
    eventIdForLog = multiIntent.items[0]?.e;
    result = await processMultiPaymentSession(session.id, session, multiIntent);
  } else {
    const intent = extractIntent(session);
    eventIdForLog = intent.eventId;
    result = await processPaymentSession(session.id, session, intent);
  }

  if (!result.success) {
    // Log error but return 200 to prevent Stripe retries for business logic failures
    logError({
      code: ErrorCode.STRIPE_SESSION,
      eventId: eventIdForLog,
      detail: result.error,
    });
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
