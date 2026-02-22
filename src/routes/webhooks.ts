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

import { map, unique } from "#fp";
import { logActivity } from "#lib/db/activityLog.ts";
import {
  createAttendeeAtomic,
  deleteAttendee,
  getAttendeesByTokens,
} from "#lib/db/attendees.ts";
import { getEvent, getEventWithCount } from "#lib/db/events.ts";
import {
  finalizeSession,
  reserveSession,
} from "#lib/db/processed-payments.ts";
import { ErrorCode, logDebug, logError } from "#lib/logger.ts";
import {
  getActivePaymentProvider,
  isPaymentStatus,
  type RegistrationIntent,
  type SessionMetadata,
  type ValidatedPaymentSession,
  type WebhookEvent,
} from "#lib/payments.ts";
import type { Attendee, ContactInfo, EventWithCount } from "#lib/types.ts";
import { getAllowedDomain, getCurrencyCode } from "#lib/config.ts";
import { logAndNotifyMultiRegistration, logAndNotifyRegistration } from "#lib/webhook.ts";
import { createRouter, defineRoutes } from "#routes/router.ts";
import { parseTokens } from "#routes/token-utils.ts";
import {
  formatCreationError,
  getSearchParam,
  htmlResponse,
  isRegistrationClosed,
  paymentErrorResponse,
  redirect,
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
  address: session.metadata.address ?? "",
  special_instructions: session.metadata.special_instructions ?? "",
  quantity: Number.parseInt(session.metadata.quantity || "1", 10),
  date: session.metadata.date ?? null,
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
  | { success: true; attendee: Pick<Attendee, "id">; event: EventWithCount; ticketTokens: string[] }
  | { success: false; error: string; status?: number; refunded?: boolean };

/**
 * Attempt to refund a payment. Returns true if refund succeeded, false otherwise.
 * Logs an error if refund fails.
 */
const tryRefund = async (paymentReference: string): Promise<boolean> => {
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

  if (refunded) {
    logDebug("Payment", "Refund issued");
  } else {
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
 * Logs a refund entry to the activity log for admin visibility.
 *
 * @param eventId - Explicit event ID for multi-ticket refunds. For single-ticket,
 *   the event ID is derived from session metadata.
 */
const refundAndFail = async (
  session: ValidatedPaymentSession,
  error: string,
  status?: number,
  eventId?: number | null,
): Promise<PaymentResult> => {
  const refunded = await tryRefund(session.paymentReference);
  if (refunded) {
    const metadataEventId = session.metadata.event_id ? Number.parseInt(session.metadata.event_id, 10) : null;
    await logActivity(`Automatic refund: ${error}`, eventId ?? metadataEventId);
  }
  return { success: false, error, status, refunded };
};

/**
 * Handle event validation failure: skip refund for unknown events (404)
 * since the webhook may be intended for a different instance sharing the same
 * payment provider account. For known-event failures (inactive, closed),
 * refund so the customer gets their money back.
 */
const validationFailure = (
  session: ValidatedPaymentSession,
  validation: { error: string; status?: number },
  eventId?: number,
): Promise<PaymentResult> =>
  validation.status === 404
    ? Promise.resolve({ success: false, error: validation.error, status: 404 })
    : refundAndFail(session, validation.error, validation.status, eventId);

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
  if (!event.active) {
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

/** Validate event and compute expected price for post-payment attendee creation */
type EventPriceValidation =
  | { ok: true; event: EventWithCount; expectedPrice: number }
  | { ok: false; error: string; status?: number };

const validateAndPrice = async (
  input: { eventId: number; quantity: number },
  includeEventName = false,
): Promise<EventPriceValidation> => {
  const validation = await validateEventForPayment(input.eventId, includeEventName);
  if (!validation.ok) return validation;
  const { event } = validation;
  const expectedPrice = (event.unit_price ?? 0) * input.quantity;
  return { ok: true, event, expectedPrice };
};

/** Check if the amount charged matches the current event price */
const hasPriceMismatch = (amountTotal: number, expectedPrice: number): boolean =>
  amountTotal !== expectedPrice;

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
  return { success: true, attendee: { id: attendeeId }, event, ticketTokens: [] };
};

/** Validate that a parsed value has the shape of a MultiItem */
const isMultiItem = (v: unknown): v is MultiItem =>
  typeof v === "object" && v !== null &&
  typeof (v as Record<string, unknown>).e === "number" &&
  typeof (v as Record<string, unknown>).q === "number";

/** Parse multi-ticket items from metadata */
const parseMultiItems = (itemsJson: string): MultiItem[] | null => {
  try {
    const parsed: unknown = JSON.parse(itemsJson);
    if (!Array.isArray(parsed) || !parsed.every(isMultiItem)) return null;
    return parsed;
  } catch {
    return null;
  }
};

/** Multi-ticket registration intent */
type MultiIntent = ContactInfo & {
  date: string | null;
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
    address: metadata.address ?? "",
    special_instructions: metadata.special_instructions ?? "",
    date: metadata.date ?? null,
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
  data: { session: ValidatedPaymentSession; intent: MultiIntent },
): Promise<PaymentResult> => {
  const { session, intent } = data;
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
  // First pass: validate all events and compute expected prices
  const validatedItems: { item: MultiItem; event: EventWithCount; expectedPrice: number }[] = [];
  let expectedTotal = 0;

  for (const item of intent.items) {
    const vp = await validateAndPrice({ eventId: item.e, quantity: item.q }, true);
    if (!vp.ok) return validationFailure(session, vp, item.e);
    validatedItems.push({ item, event: vp.event, expectedPrice: vp.expectedPrice });
    expectedTotal += vp.expectedPrice;
  }

  // Reject if event prices changed since checkout was created
  if (hasPriceMismatch(session.amountTotal, expectedTotal)) {
    logError({
      code: ErrorCode.PAYMENT_SESSION,
      detail: `Multi-ticket price mismatch: provider charged ${session.amountTotal} but current event prices yield ${expectedTotal}`,
    });
    return refundAndFail(
      session,
      "The price for one or more events changed while you were completing payment.",
      undefined,
      validatedItems[0]?.event.id,
    );
  }

  const createdAttendees: { attendee: Attendee; event: EventWithCount }[] = [];
  let failedEvent: EventWithCount | null = null;
  let failureReason: "capacity_exceeded" | "encryption_error" | null = null;

  for (const { item, event, expectedPrice } of validatedItems) {
    const result = await createAttendeeAtomic({
      eventId: item.e,
      name: intent.name,
      email: intent.email,
      paymentId: session.paymentReference,
      quantity: item.q,
      phone: intent.phone,
      address: intent.address,
      special_instructions: intent.special_instructions,
      pricePaid: expectedPrice,
      date: event.event_type === "daily" ? intent.date : null,
    });

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
      undefined,
      failedEvent.id,
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
    ticketTokens: map(({ attendee }: { attendee: Attendee }) => attendee.ticket_token)(createdAttendees),
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
  data: { session: ValidatedPaymentSession; intent: RegistrationIntent },
): Promise<PaymentResult> => {
  const { session, intent } = data;
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

  // Phase 2: Validate event and create attendee atomically with capacity check
  const vp = await validateAndPrice(intent);
  if (!vp.ok) return validationFailure(session, vp);

  const { event, expectedPrice } = vp;

  // Reject if event price changed since checkout was created
  if (hasPriceMismatch(session.amountTotal, expectedPrice)) {
    logError({
      code: ErrorCode.PAYMENT_SESSION,
      eventId: intent.eventId,
      detail: `Price mismatch: provider charged ${session.amountTotal} but current event price yields ${expectedPrice}`,
    });
    return refundAndFail(
      session,
      "The price for this event changed while you were completing payment.",
    );
  }

  const result = await createAttendeeAtomic({
    ...intent,
    paymentId: session.paymentReference,
    pricePaid: expectedPrice,
  });

  if (!result.success) {
    return refundAndFail(session, formatPostPaymentError(result.reason));
  }

  // Phase 3: Finalize the session with the attendee ID
  await finalizeSession(sessionId, result.attendee.id);

  await logAndNotifyRegistration(event, result.attendee, await getCurrencyCode());
  return { success: true, attendee: result.attendee, event, ticketTokens: [result.attendee.ticket_token] };
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
 * Process session_id param: validate, create attendee, redirect with tokens.
 */
const processSessionAndRedirect = async (sessionId: string): Promise<Response> => {
  const validation = await validatePaidSession(sessionId);
  if (!validation.ok) return validation.response;

  const { data } = validation;
  const result =
    data.type === "multi"
      ? await processMultiPaymentSession(sessionId, data)
      : await processPaymentSession(sessionId, data);

  if (!result.success) {
    return paymentErrorResponse(formatPaymentError(result), result.status);
  }

  // Redirect to success page with verified tokens in URL
  // encodeURIComponent preserves + as %2B so URLSearchParams.get() decodes it back correctly
  if (result.ticketTokens.length > 0) {
    return redirect(`/payment/success?tokens=${encodeURIComponent(result.ticketTokens.join("+"))}`);
  }

  // Already-processed session (no tokens available) - render directly
  const thankYouUrl =
    data.type === "single" ? result.event.thank_you_url : null;
  return htmlResponse(paymentSuccessPage(thankYouUrl, null));
};

/**
 * Render success page from verified tokens param.
 */
const renderSuccessFromTokens = async (tokensParam: string): Promise<Response> => {
  const tokens = parseTokens(tokensParam);
  const attendeeResults = tokens.length > 0
    ? await getAttendeesByTokens(tokens) : [];
  const verifiedTokens: string[] = [];
  const eventIds: number[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const attendee = attendeeResults[i];
    if (attendee) {
      verifiedTokens.push(tokens[i]!);
      eventIds.push(attendee.event_id);
    }
  }

  if (verifiedTokens.length === 0) {
    return paymentErrorResponse("Invalid payment callback");
  }

  const ticketUrl = `/t/${verifiedTokens.join("+")}`;

  // Only use thank_you_url for single-event purchases
  const uniqueEventIds = unique(eventIds);
  let thankYouUrl: string | null = null;
  if (uniqueEventIds.length === 1) {
    const event = await getEvent(uniqueEventIds[0]!);
    if (event) thankYouUrl = event.thank_you_url;
  }

  return htmlResponse(paymentSuccessPage(thankYouUrl, ticketUrl));
};

/**
 * Handle GET /payment/success (redirect after successful payment)
 *
 * Two-phase flow:
 * 1. With session_id: process payment, create attendee, redirect with tokens
 * 2. With tokens: verify tokens against DB, render success page with ticket link
 */
const handlePaymentSuccess = (request: Request): Promise<Response> => {
  // Stripe uses session_id via {CHECKOUT_SESSION_ID} template variable;
  // Square appends orderId as a query parameter to the redirect URL
  const sessionId = getSearchParam(request, "session_id") ||
    getSearchParam(request, "orderId");
  if (sessionId) return processSessionAndRedirect(sessionId);

  const tokensParam = getSearchParam(request, "tokens");
  if (tokensParam) return renderSuccessFromTokens(tokensParam);

  return Promise.resolve(paymentErrorResponse("Invalid payment callback"));
};

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
 * Validate webhook event data and extract session.
 * Returns null if data is invalid.
 * Supports both single-event and multi-event sessions.
 * Caller must verify event.type matches before calling.
 */
const extractSessionFromEvent = (
  event: WebhookEvent,
): ValidatedPaymentSession | null => {
  const obj = event.data.object;
  const metadata = obj.metadata as Record<string, unknown> | undefined;

  // Validate required fields with strict type checking
  if (
    typeof obj.id !== "string" ||
    typeof obj.payment_status !== "string" ||
    typeof obj.amount_total !== "number" ||
    !metadata ||
    typeof metadata.name !== "string" ||
    typeof metadata.email !== "string"
  ) {
    return null;
  }

  return {
    id: obj.id,
    paymentStatus: isPaymentStatus(obj.payment_status) ? obj.payment_status : "unpaid",
    paymentReference:
      typeof obj.payment_intent === "string" ? obj.payment_intent : "",
    amountTotal: obj.amount_total,
    metadata: {
      _origin: typeof metadata._origin === "string" ? metadata._origin : undefined,
      event_id: metadata.event_id as string | undefined,
      name: metadata.name,
      email: metadata.email,
      phone: metadata.phone as string | undefined,
      quantity: metadata.quantity as string | undefined,
      multi: metadata.multi as string | undefined,
      items: metadata.items as string | undefined,
      date: metadata.date as string | undefined,
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

  // Read raw body bytes for signature verification. Using arrayBuffer() and
  // passing raw bytes to the HMAC avoids a text decoding/encoding round-trip
  // that can silently alter the payload in CDN edge runtimes.
  const payloadBytes = new Uint8Array(await request.arrayBuffer());
  const payload = new TextDecoder().decode(payloadBytes);

  // Use the public-facing domain for signature verification. Square signs the
  // webhook using the exact notification URL from the subscription, which is the
  // public https:// URL. Deriving from request.url fails behind CDNs that
  // terminate TLS (the edge runtime sees http:// instead of https://).
  const webhookUrl = `https://${getAllowedDomain()}/payment/webhook`;

  // Verify signature (pass raw bytes so HMAC is computed on exact received bytes)
  const verification = await provider.verifyWebhookSignature(payload, signature, webhookUrl, payloadBytes);
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
    const obj = event.data.object;
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

  // Verify session originated from this instance. Sessions created by a
  // different application sharing the same payment provider account will not
  // carry our _origin marker.
  if (session.metadata._origin !== getAllowedDomain()) {
    logError({
      code: ErrorCode.PAYMENT_SESSION,
      detail: "Ignoring webhook for unrecognized payment session",
    });
    return webhookAckResponse();
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
    result = await processMultiPaymentSession(session.id, { session, intent: multiIntent });
  } else {
    const intent = extractIntent(session);
    eventIdForLog = intent.eventId;
    result = await processPaymentSession(session.id, { session, intent });
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
  "GET /payment/success": handlePaymentSuccess,
  "GET /payment/cancel": handlePaymentCancel,
  "POST /payment/webhook": handlePaymentWebhook,
});

/**
 * Route payment requests
 */
export const routePayment = createRouter(paymentRoutes);
