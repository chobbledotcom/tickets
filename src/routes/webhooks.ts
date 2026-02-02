/**
 * Webhook routes - payment callbacks and provider webhooks
 *
 * Payment flow (race-condition safe with two-phase locking):
 * 1. User submits form -> checkout session created with intent metadata (no attendee yet)
 * 2. User pays -> redirected to /payment/success OR webhook fires
 * 3. First handler reserves session (DB lock), creates attendee, finalizes lock
 * 4. Subsequent handlers see reserved/finalized session and return existing attendee
 * 5. If capacity exceeded after payment, auto-refund and show error
 *
 * Security:
 * - Webhooks are verified using provider-specific signature verification
 * - Session ID alone cannot create attendees - provider API confirms payment status
 * - Two-phase locking prevents duplicate attendee creation from race conditions
 */

import { createAttendeeAtomic, deleteAttendee } from "#lib/db/attendees.ts";
import { getEvent, getEventWithCount } from "#lib/db/events.ts";
import {
  finalizeSession,
  reserveSession,
} from "#lib/db/processed-payments.ts";
import { ErrorCode, logError } from "#lib/logger.ts";
import {
  getActivePaymentProvider,
  type RegistrationIntent,
  type SessionMetadata,
  type ValidatedPaymentSession,
  type WebhookEvent,
} from "#lib/payments.ts";
import type { Attendee, EventWithCount } from "#lib/types.ts";
import { getCurrencyCode } from "#lib/config.ts";
import { logAndNotifyMultiRegistration, logAndNotifyRegistration } from "#lib/webhook.ts";
import { createRouter, defineRoutes } from "#routes/router.ts";
import {
  formatCreationError,
  getSearchParam,
  htmlResponse,
  isRegistrationClosed,
  paymentErrorResponse,
} from "#routes/utils.ts";
import { paymentCancelPage, paymentSuccessPage } from "#templates/payment.tsx";

/** Parsed multi-ticket item from metadata */
type MultiItem = { e: number; q: number };

/** Check if session is a multi-ticket session */
const isMultiSession = (metadata: SessionMetadata): boolean =>
  metadata.multi === "1" && typeof metadata.items === "string";

/** Extract registration intent from validated session metadata (single-ticket only) */
const extractIntent = (
  session: ValidatedPaymentSession,
): RegistrationIntent => ({
  eventId: Number.parseInt(session.metadata.event_id ?? "0", 10),
  name: session.metadata.name,
  email: session.metadata.email,
  phone: session.metadata.phone ?? "",
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
  | { type: "single"; session: ValidatedPaymentSession; intent: RegistrationIntent }
  | { type: "multi"; session: ValidatedPaymentSession; intent: MultiIntent };

type SessionValidation =
  | { ok: true; data: ValidatedSession }
  | { ok: false; response: Response };

const validatePaidSession = async (
  sessionId: string,
): Promise<SessionValidation> => {
  const provider = await getActivePaymentProvider();
  if (!provider) {
    return {
      ok: false,
      response: paymentErrorResponse("Payment provider not configured"),
    };
  }

  const session = await provider.retrieveSession(sessionId);
  if (!session) {
    return {
      ok: false,
      response: paymentErrorResponse("Payment session not found"),
    };
  }

  if (session.paymentStatus !== "paid") {
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
 * Attempt to refund a payment. Returns true if refund succeeded, false otherwise.
 * Logs an error if refund fails.
 */
const tryRefund = async (paymentReference: string | null): Promise<boolean> => {
  if (!paymentReference) return false;

  const provider = await getActivePaymentProvider();
  if (!provider) {
    logError({
      code: ErrorCode.PAYMENT_REFUND,
      detail: "No payment provider configured for refund",
    });
    return false;
  }

  const refunded = await provider.refundPayment(paymentReference);

  if (!refunded) {
    logError({
      code: ErrorCode.PAYMENT_REFUND,
      detail: `Failed to refund payment ${paymentReference}`,
    });
  }

  return refunded;
};

/**
 * Attempt to refund payment and return failure result.
 * Reports refund status accurately based on API result.
 */
const refundAndFail = async (
  session: ValidatedPaymentSession,
  error: string,
  status?: number,
): Promise<PaymentResult> => {
  const refunded = await tryRefund(session.paymentReference);
  return { success: false, error, status, refunded };
};

/** Rollback created attendees (multi-ticket failure recovery) */
const rollbackAttendees = async (
  attendees: { attendee: Attendee }[],
): Promise<void> => {
  for (const { attendee } of attendees) {
    await deleteAttendee(attendee.id);
  }
};

/** Validate event is eligible for post-payment registration */
type EventValidation =
  | { ok: true; event: EventWithCount }
  | { ok: false; error: string; status?: number };

const validateEventForPayment = async (
  eventId: number,
  includeEventName = false,
): Promise<EventValidation> => {
  const event = await getEventWithCount(eventId);
  if (!event) return { ok: false, error: "Event not found", status: 404 };
  const name = includeEventName ? event.name : undefined;
  if (event.active !== 1) {
    return {
      ok: false,
      error: name
        ? `${name} is no longer accepting registrations.`
        : "This event is no longer accepting registrations.",
    };
  }
  if (isRegistrationClosed(event)) {
    return {
      ok: false,
      error: name
        ? `Sorry, registration for ${name} closed while you were completing payment.`
        : "Sorry, registration closed while you were completing payment.",
    };
  }
  return { ok: true, event };
};

/** Validate event and compute price for post-payment attendee creation */
type EventPriceValidation =
  | { ok: true; event: EventWithCount; pricePaid: number | null }
  | { ok: false; error: string; status?: number };

const validateAndPrice = async (
  eventId: number,
  quantity: number,
  includeEventName = false,
): Promise<EventPriceValidation> => {
  const validation = await validateEventForPayment(eventId, includeEventName);
  if (!validation.ok) return validation;
  const { event } = validation;
  const pricePaid = event.unit_price !== null ? event.unit_price * quantity : null;
  return { ok: true, event, pricePaid };
};

/** Format error for post-payment attendee creation failure */
const formatPostPaymentError = formatCreationError(
  "Sorry, this event sold out while you were completing payment.",
  (name) => `Sorry, ${name} sold out while you were completing payment.`,
  "Registration failed.",
);

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
  phone: string;
  items: MultiItem[];
};

/** Extract multi-ticket intent from session metadata */
const extractMultiIntent = (
  session: ValidatedPaymentSession,
): MultiIntent | null => {
  const { metadata } = session;
  if (!metadata.items) return null;

  const items = parseMultiItems(metadata.items);
  if (!items || items.length === 0) return null;

  return {
    name: metadata.name,
    email: metadata.email,
    phone: metadata.phone ?? "",
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
  session: ValidatedPaymentSession,
  intent: MultiIntent,
): Promise<PaymentResult> => {
  // Phase 1: Reserve the session
  const reservation = await reserveSession(sessionId);

  if (!reservation.reserved) {
    const { existing } = reservation;

    if (existing.attendee_id !== null) {
      return alreadyProcessedResult(intent.items[0]!.e, existing.attendee_id);
    }

    // Still being processed by another request
    return {
      success: false,
      error: "Payment is being processed. Please wait a moment and refresh.",
      status: 409,
    };
  }

  // Phase 2: Validate events and create attendees atomically
  const createdAttendees: { attendee: Attendee; event: EventWithCount }[] = [];
  let failedEvent: EventWithCount | null = null;
  let failureReason: "capacity_exceeded" | "encryption_error" | null = null;

  for (const item of intent.items) {
    const vp = await validateAndPrice(item.e, item.q, true);
    if (!vp.ok) {
      await rollbackAttendees(createdAttendees);
      return refundAndFail(session, vp.error, vp.status);
    }

    const { event, pricePaid } = vp;
    const result = await createAttendeeAtomic(
      item.e,
      intent.name,
      intent.email,
      session.paymentReference,
      item.q,
      intent.phone,
      pricePaid,
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
    await rollbackAttendees(createdAttendees);
    return refundAndFail(
      session,
      formatPostPaymentError(failureReason, failedEvent.name),
    );
  }

  // Phase 3: Finalize with first attendee ID (for idempotency tracking)
  // createdAttendees is guaranteed non-empty: the loop always runs (intent.items
  // is validated non-empty) and if any creation fails we return early above.
  const firstAttendee = createdAttendees[0]!;

  await finalizeSession(sessionId, firstAttendee.attendee.id);

  // Log and send consolidated webhook for all created attendees
  await logAndNotifyMultiRegistration(createdAttendees, await getCurrencyCode());

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
  session: ValidatedPaymentSession,
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

  // Phase 2: Validate event and create attendee atomically with capacity check
  const vp = await validateAndPrice(intent.eventId, intent.quantity);
  if (!vp.ok) return refundAndFail(session, vp.error, vp.status);

  const { event, pricePaid } = vp;
  const result = await createAttendeeAtomic(
    intent.eventId,
    intent.name,
    intent.email,
    session.paymentReference,
    intent.quantity,
    intent.phone,
    pricePaid,
  );

  if (!result.success) {
    return refundAndFail(session, formatPostPaymentError(result.reason));
  }

  // Phase 3: Finalize the session with the attendee ID
  await finalizeSession(sessionId, result.attendee.id);

  await logAndNotifyRegistration(event, result.attendee, await getCurrencyCode());
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
 * Handle GET /payment/success (redirect after successful payment)
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
 * Handle GET /payment/cancel (redirect after cancelled payment)
 *
 * No attendee cleanup needed - attendee is only created after successful payment.
 */
const handlePaymentCancel = withSessionId(async (sid) => {
  const provider = await getActivePaymentProvider();
  if (!provider) {
    return paymentErrorResponse("Payment provider not configured");
  }

  const session = await provider.retrieveSession(sid);
  if (!session) {
    return paymentErrorResponse("Payment session not found");
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
 * Payment Webhook Endpoint
 * =============================================================================
 * Handles events directly from payment providers with signature verification.
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
 * Returns null if data is invalid.
 * Supports both single-event and multi-event sessions.
 * Caller must verify event.type matches before calling.
 */
const extractSessionFromEvent = (
  event: WebhookEvent,
): ValidatedPaymentSession | null => {
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

  return {
    id: obj.id,
    paymentStatus: obj.payment_status as ValidatedPaymentSession["paymentStatus"],
    paymentReference:
      typeof obj.payment_intent === "string" ? obj.payment_intent : null,
    metadata: {
      event_id: obj.metadata.event_id,
      name: obj.metadata.name,
      email: obj.metadata.email,
      phone: obj.metadata.phone,
      quantity: obj.metadata.quantity,
      multi: obj.metadata.multi,
      items: obj.metadata.items,
    },
  };
};

/** JSON response acknowledging a webhook event without processing */
const webhookAckResponse = (extra?: Record<string, unknown>): Response =>
  new Response(JSON.stringify({ received: true, ...extra }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

/** Detect which provider sent the webhook based on request headers */
const getWebhookSignatureHeader = (
  request: Request,
): string | null =>
  request.headers.get("stripe-signature") ??
  request.headers.get("x-square-hmacsha256-signature") ??
  null;

/** Extract order/session ID from webhook event object (used for Square fallback) */
const extractSessionIdFromObject = (obj: Record<string, unknown>): string | null => {
  if (typeof obj.order_id === "string") return obj.order_id;
  if (typeof obj.id === "string") return obj.id;
  return null;
};

/**
 * Handle POST /payment/webhook (payment provider webhook endpoint)
 *
 * Receives events directly from the payment provider with signature verification.
 * Primary handler for payment completion - more reliable than redirects.
 */
const handlePaymentWebhook = async (request: Request): Promise<Response> => {
  const provider = await getActivePaymentProvider();
  if (!provider) {
    return new Response("Payment provider not configured", { status: 400 });
  }

  // Get signature header
  const signature = getWebhookSignatureHeader(request);
  if (!signature) {
    return new Response("Missing signature", { status: 400 });
  }

  // Read raw body for signature verification
  const payload = await request.text();

  // Verify signature
  const verification = await provider.verifyWebhookSignature(payload, signature);
  if (!verification.valid) {
    return new Response(verification.error, { status: 400 });
  }

  const event = verification.event;

  // Only handle checkout completed events
  if (event.type !== provider.checkoutCompletedEventType) {
    // Acknowledge other events without processing
    return webhookAckResponse();
  }

  // Try to extract session directly from event data (works for Stripe).
  // For providers like Square where webhook payload is a payment object
  // (not the order with metadata), fall back to retrieveSession.
  let session = extractSessionFromEvent(event);

  if (!session) {
    // Attempt provider-specific retrieval using order/session ID from event data
    const obj = event.data.object as Record<string, unknown>;
    const sessionId = extractSessionIdFromObject(obj);

    if (!sessionId) {
      return new Response("Invalid session data", { status: 400 });
    }

    // For Square payment.updated: check payment status before retrieving order
    if (typeof obj.status === "string" && obj.status !== "COMPLETED") {
      return webhookAckResponse({ status: "pending" });
    }

    session = await provider.retrieveSession(sessionId);
    if (!session) {
      return new Response("Invalid session data", { status: 400 });
    }
  }

  // Verify payment is complete
  if (session.paymentStatus !== "paid") {
    return webhookAckResponse({ status: "pending" });
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
    // Log error but return 200 to prevent provider retries for business logic failures
    logError({
      code: ErrorCode.PAYMENT_SESSION,
      eventId: eventIdForLog,
      detail: result.error,
    });
  }

  return webhookAckResponse({
    processed: result.success,
    error: result.success ? undefined : result.error,
  });
};

/** Payment routes definition */
const paymentRoutes = defineRoutes({
  "GET /payment/success": (request) => handlePaymentSuccess(request),
  "GET /payment/cancel": (request) => handlePaymentCancel(request),
  "POST /payment/webhook": (request) => handlePaymentWebhook(request),
});

/**
 * Route payment requests
 */
export const routePayment = createRouter(paymentRoutes);
