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
import { calculateBookingFee } from "#lib/booking-fee.ts";
import { getBookingFee, getEffectiveDomain } from "#lib/config.ts";
import { logActivity } from "#lib/db/activityLog.ts";
import {
  createAttendeeAtomic,
  deleteAttendee,
  getAttendeesByTokens,
} from "#lib/db/attendees.ts";
import { getEvent, getEventWithCount } from "#lib/db/events.ts";
import {
  clearSessionTokens,
  decryptSessionTokens,
  finalizeSession,
  type ProcessedPayment,
  reserveSession,
} from "#lib/db/processed-payments.ts";
import { saveAttendeeAnswers } from "#lib/db/questions.ts";
import { ErrorCode, logDebug, logError } from "#lib/logger.ts";
import { errorMessage } from "#lib/payment-helpers.ts";
import {
  type BookingItem,
  getActivePaymentProvider,
  type SessionMetadata,
  type ValidatedPaymentSession,
} from "#lib/payments.ts";
import type { Attendee, ContactInfo, EventWithCount } from "#lib/types.ts";
import { logAndNotifyRegistration } from "#lib/webhook.ts";
import { getFromEmailIfConfigured } from "#routes/public.ts";
import { createRouter, defineRoutes } from "#routes/router.ts";
import { parseTokens } from "#routes/token-utils.ts";
import {
  formatCreationError,
  getSearchParam,
  htmlResponse,
  isRegistrationClosed,
  jsonResponse,
  paymentErrorResponse,
  plainResponse,
  redirectResponse,
} from "#routes/utils.ts";
import { paymentCancelPage, successPage } from "#templates/payment.tsx";

/** User-facing message when the event price changed between checkout and payment */
const PRICE_CHANGED_MESSAGE =
  "The price for this event changed while you were completing payment.";

/** Check if session uses cart (multi-item) metadata format */
const isCartSession = (metadata: SessionMetadata): boolean =>
  metadata.multi === "1" && metadata.items !== "";

/** Parse per-event answer IDs from metadata JSON string (object format) */
const parseEventAnswerIds = (
  json: string,
): Record<string, number[]> | undefined =>
  json ? JSON.parse(json) : undefined;

/**
 * Extract registration intent from validated session metadata (single-ticket).
 *
 * Precondition: hasRequiredSessionMetadata has verified event_id is present.
 * Converts from SessionMetadata's "" convention back to domain types:
 * - date: "" → null (BookingIntent uses null for "no date selected")
 *
 * Returns a BookingIntent with a single item so that single and multi bookings
 * share the same processing path.
 */
const extractIntent = (session: ValidatedPaymentSession): BookingIntent => {
  const eventId = Number.parseInt(session.metadata.event_id, 10);
  const quantity = Number.parseInt(session.metadata.quantity, 10);

  if (!Number.isFinite(eventId) || eventId <= 0) {
    throw new Error(
      `Invalid event_id in session metadata: "${session.metadata.event_id}"`,
    );
  }

  if (!Number.isFinite(quantity) || quantity < 0) {
    throw new Error(
      `Invalid quantity in session metadata: "${session.metadata.quantity}"`,
    );
  }

  return {
    name: session.metadata.name,
    email: session.metadata.email,
    phone: session.metadata.phone,
    address: session.metadata.address,
    special_instructions: session.metadata.special_instructions,
    date: session.metadata.date || null,
    items: [{ e: eventId, q: quantity, p: 0 }],
    eventAnswerIds: parseEventAnswerIds(session.metadata.answer_ids),
  };
};

/** Wrap handler with session ID extraction */
const withSessionId =
  (handler: (sessionId: string) => Promise<Response>) =>
  (request: Request): Promise<Response> => {
    const sessionId = getSearchParam(request, "session_id");
    if (!sessionId) {
      logError({
        code: ErrorCode.PAYMENT_SESSION,
        detail: "Payment callback missing session_id parameter",
      });
    }
    return sessionId
      ? handler(sessionId)
      : Promise.resolve(paymentErrorResponse("Invalid payment callback"));
  };

/** Validated session data */
type ValidatedSession = {
  session: ValidatedPaymentSession;
  intent: BookingIntent;
};

type SessionValidation =
  | { ok: true; data: ValidatedSession }
  | { ok: false; response: Response };

/** Log a payment session error with redirect context prefix */
const logRedirectError = (detail: string): void =>
  logError({ code: ErrorCode.PAYMENT_SESSION, detail: `[redirect] ${detail}` });

const validatePaidSession = async (
  sessionId: string,
): Promise<SessionValidation> => {
  const provider = await getActivePaymentProvider();
  if (!provider) {
    logRedirectError(`No payment provider configured (session=${sessionId})`);
    return {
      ok: false,
      response: paymentErrorResponse("Payment provider not configured"),
    };
  }

  const session = await provider.retrieveSession(sessionId);
  if (!session) {
    logRedirectError(`Session not found (session=${sessionId})`);
    return {
      ok: false,
      response: paymentErrorResponse("Payment session not found"),
    };
  }

  if (session.paymentStatus !== "paid") {
    logRedirectError(
      `Payment not verified as paid (session=${sessionId}, status=${session.paymentStatus})`,
    );
    return {
      ok: false,
      response: paymentErrorResponse(
        "Payment verification failed. Please contact support.",
      ),
    };
  }

  // Extract intent — cart sessions parse items metadata, single-item
  // sessions are wrapped into a one-item BookingIntent
  if (isCartSession(session.metadata)) {
    const intent = extractBookingIntent(session);
    if (!intent) {
      logRedirectError(`Invalid cart data (session=${sessionId})`);
      return {
        ok: false,
        response: paymentErrorResponse("Invalid cart session data"),
      };
    }
    return { ok: true, data: { session, intent } };
  }

  try {
    const intent = extractIntent(session);
    return { ok: true, data: { session, intent } };
  } catch (err) {
    logRedirectError(`${errorMessage(err)} (session=${sessionId})`);
    return {
      ok: false,
      response: paymentErrorResponse("Invalid session data"),
    };
  }
};

/** Result type for processPaymentSession */
type PaymentResult =
  | {
      success: true;
      attendee: Pick<Attendee, "id">;
      event: EventWithCount;
      ticketTokens: string[];
    }
  | {
      success: false;
      error: string;
      status?: number;
      refunded?: boolean;
      detail?: string;
    };

/**
 * Attempt to refund a payment. Returns true if refund succeeded, false otherwise.
 * Logs an error if refund fails.
 */
const tryRefund = async (
  paymentReference: string,
  eventId?: number,
): Promise<boolean> => {
  if (!paymentReference) return false;

  const provider = await getActivePaymentProvider();
  if (!provider) {
    logError({
      code: ErrorCode.PAYMENT_REFUND,
      eventId,
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
      eventId,
      detail: `Failed to refund payment ${paymentReference}`,
    });
  }

  return refunded;
};

/** Attempt refund and log activity if successful */
const refundAndLog = async (
  session: ValidatedPaymentSession,
  error: string,
  eventId: number,
): Promise<boolean> => {
  const refunded = await tryRefund(session.paymentReference, eventId);
  if (refunded) {
    await logActivity(`Automatic refund: ${error}`, eventId);
  }
  return refunded;
};

/**
 * Handle event validation failure: skip refund for unknown events (404)
 * since the webhook may be intended for a different instance sharing the same
 * payment provider account. For known-event failures (inactive, closed),
 * refund so the customer gets their money back.
 */
const validationFailure = async (
  session: ValidatedPaymentSession,
  validation: { error: string; status?: number },
  eventId: number,
): Promise<PaymentResult> => {
  if (validation.status === 404) {
    return {
      success: false,
      error: validation.error,
      status: 404,
      detail: `Post-payment event not found (session=${session.id})`,
    };
  }
  const refunded = await refundAndLog(session, validation.error, eventId);
  return {
    success: false,
    error: validation.error,
    status: validation.status,
    refunded,
  };
};

/** Rollback created attendees (booking failure recovery) */
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
  const validation = await validateEventForPayment(
    input.eventId,
    includeEventName,
  );
  if (!validation.ok) return validation;
  const { event } = validation;
  const expectedPrice = event.unit_price * input.quantity;
  return { ok: true, event, expectedPrice };
};

/** Check if the amount charged matches the current event price (including booking fee).
 * For pay-more events, the amount must be >= the expected minimum price and <= the max cap.
 * `quantity` scales max_price so purchases are validated against the correct total cap. */
const hasPriceMismatch = (
  amountTotal: number,
  expectedPrice: number,
  event: Pick<EventWithCount, "can_pay_more" | "max_price">,
  bookingFeePercent: number,
  quantity: number,
): boolean => {
  if (event.can_pay_more) {
    const minWithFee =
      expectedPrice + calculateBookingFee(expectedPrice, bookingFeePercent);
    const maxTicketTotal = event.max_price * quantity;
    const maxWithFee =
      maxTicketTotal + calculateBookingFee(maxTicketTotal, bookingFeePercent);
    return amountTotal < minWithFee || amountTotal > maxWithFee;
  }
  const expectedWithFee =
    expectedPrice + calculateBookingFee(expectedPrice, bookingFeePercent);
  return amountTotal !== expectedWithFee;
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
  existing: ProcessedPayment,
): Promise<PaymentResult> => {
  const event = await getEventWithCount(eventId);
  if (!event) return { success: false, error: "Event not found", status: 404 };
  const decrypted = await decryptSessionTokens(existing.ticket_tokens);
  const ticketTokens = decrypted ? decrypted.split("+") : [];
  return {
    success: true,
    attendee: { id: existing.attendee_id! },
    event,
    ticketTokens,
  };
};

/**
 * Parse booking items from metadata JSON.
 *
 * Precondition: the session has passed _origin verification, so this JSON
 * was serialized by our own serializeBookingItems(). We parse with JSON.parse
 * (which is safe) and do a basic structural check. Returns null only if the
 * JSON is unparseable or the array is empty — a corrupt item (e.g. missing
 * field) throws so the bug surfaces immediately.
 */
const parseBookingItems = (itemsJson: string): BookingItem[] | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(itemsJson);
  } catch {
    return null;
  }

  if (!Array.isArray(parsed) || parsed.length === 0) return null;

  for (const item of parsed) {
    const valid =
      typeof item === "object" &&
      item !== null &&
      Number.isInteger(item.e) &&
      Number.isInteger(item.q) &&
      Number.isInteger(item.p);
    if (!valid) {
      throw new Error(
        `Corrupt booking item in session metadata: ${JSON.stringify(item)}`,
      );
    }
  }

  return parsed as BookingItem[];
};

/** Booking intent with one or more line items */
type BookingIntent = ContactInfo & {
  date: string | null;
  items: BookingItem[];
  /** Per-event answer IDs: maps eventId → answerIds for that event's questions */
  eventAnswerIds?: Record<string, number[]>;
};

/**
 * Extract booking intent from cart-style session metadata.
 *
 * Converts date from SessionMetadata's "" convention to null for domain use.
 */
const extractBookingIntent = (
  session: ValidatedPaymentSession,
): BookingIntent | null => {
  const { metadata } = session;
  const items = parseBookingItems(metadata.items);
  if (!items || items.length === 0) return null;

  return {
    name: metadata.name,
    email: metadata.email,
    phone: metadata.phone,
    address: metadata.address,
    special_instructions: metadata.special_instructions,
    date: metadata.date || null,
    items,
    eventAnswerIds: parseEventAnswerIds(metadata.answer_ids),
  };
};

/** Log a price mismatch and refund the session */
const priceMismatchRefund = async (
  session: ValidatedPaymentSession,
  detail: string,
  eventId: number,
): Promise<PaymentResult> => {
  const refunded = await refundAndLog(session, PRICE_CHANGED_MESSAGE, eventId);
  return { success: false, error: PRICE_CHANGED_MESSAGE, refunded, detail };
};

/**
 * Core attendee creation logic shared between redirect and webhook handlers.
 * Handles all bookings uniformly — a single-item checkout is just an
 * items array with one entry.
 *
 * Uses two-phase locking to prevent duplicate attendee creation:
 * 1. Reserve session (claims the lock)
 * 2. Validate events and create attendees atomically (with rollback on failure)
 * 3. Finalize session (records attendee ID)
 */
const processPaymentSession = async (
  sessionId: string,
  data: { session: ValidatedPaymentSession; intent: BookingIntent },
  options?: { storeTokens?: boolean },
): Promise<PaymentResult> => {
  const { session, intent } = data;
  // Phase 1: Reserve the session (claim the lock)
  const reservation = await reserveSession(sessionId);

  if (!reservation.reserved) {
    const { existing } = reservation;

    if (existing.attendee_id !== null) {
      return alreadyProcessedResult(intent.items[0]!.e, existing);
    }

    // Session reserved but not finalized — another request is processing
    return {
      success: false,
      error: "Payment is being processed. Please wait a moment and refresh.",
      status: 409,
    };
  }

  // Phase 2: Validate events and create attendees atomically
  // A single-item checkout uses strict price validation (exact match / pay-more
  // range). A cart checkout uses per-item price validation when items have
  // non-zero prices, or lenient total validation for free-event carts.
  const isSingleItemCheckout = !isCartSession(session.metadata);
  const includeEventName = !isSingleItemCheckout;

  const validatedItems: {
    item: BookingItem;
    event: EventWithCount;
    expectedPrice: number;
  }[] = [];
  let _expectedTotal = 0;

  for (const item of intent.items) {
    const vp = await validateAndPrice(
      { eventId: item.e, quantity: item.q },
      includeEventName,
    );
    if (!vp.ok) return validationFailure(session, vp, item.e);
    validatedItems.push({
      item,
      event: vp.event,
      expectedPrice: vp.expectedPrice,
    });
    _expectedTotal += vp.expectedPrice;
  }

  // Price validation
  const hasPerItemPrices = intent.items.some((item) => item.p > 0);
  const bookingFeePercent = getBookingFee();

  if (hasPerItemPrices) {
    // Per-item prices are ticket-only (no fee), so validate without booking fee
    for (const { item, event, expectedPrice } of validatedItems) {
      if (hasPriceMismatch(item.p, expectedPrice, event, 0, item.q)) {
        return priceMismatchRefund(
          session,
          `Per-item price mismatch for event ${event.id}: metadata p=${item.p} but expected ${expectedPrice} (can_pay_more=${event.can_pay_more})`,
          event.id,
        );
      }
    }

    // Cart total must equal the sum of per-item prices + booking fee
    const metadataTotal = validatedItems.reduce(
      (sum, { item }) => sum + item.p,
      0,
    );
    const expectedCartTotal =
      metadataTotal + calculateBookingFee(metadataTotal, bookingFeePercent);
    if (session.amountTotal !== expectedCartTotal) {
      return priceMismatchRefund(
        session,
        `Total mismatch: provider charged ${session.amountTotal} but expected ${expectedCartTotal}`,
        validatedItems[0]!.event.id,
      );
    }
  } else if (isSingleItemCheckout) {
    // Single-ticket checkout: validate with hasPriceMismatch (exact match for
    // fixed-price, range check for pay-more events)
    const { event, expectedPrice } = validatedItems[0]!;
    if (
      hasPriceMismatch(
        session.amountTotal,
        expectedPrice,
        event,
        bookingFeePercent,
        intent.items[0]!.q,
      )
    ) {
      return priceMismatchRefund(
        session,
        `Price mismatch: provider charged ${session.amountTotal} but current event price yields ${expectedPrice}`,
        event.id,
      );
    }
  }
  // Free-event cart (all p=0, not single-item): no price validation needed

  // Create attendees
  const createdAttendees: { attendee: Attendee; event: EventWithCount }[] = [];
  let failedEvent: EventWithCount | null = null;
  let failureReason: "capacity_exceeded" | "encryption_error" | null = null;

  for (const { item, event, expectedPrice } of validatedItems) {
    // For single-ticket pay-more events, use the actual amount charged to capture
    // the customer's chosen price. Otherwise use per-item or expected price.
    const pricePaid = hasPerItemPrices
      ? item.p
      : isSingleItemCheckout && event.can_pay_more
        ? session.amountTotal
        : expectedPrice;

    const result = await createAttendeeAtomic({
      eventId: item.e,
      name: intent.name,
      email: intent.email,
      paymentId: session.paymentReference,
      quantity: item.q,
      phone: intent.phone,
      address: intent.address,
      special_instructions: intent.special_instructions,
      pricePaid,
      date: event.event_type === "daily" ? intent.date : null,
    });

    if (!result.success) {
      failedEvent = event;
      failureReason = result.reason;
      break;
    }

    createdAttendees.push({ attendee: result.attendee, event });
  }

  // If any creation failed, rollback already-created attendees and refund
  if (failedEvent && failureReason) {
    await rollbackAttendees(createdAttendees);
    const error = formatPostPaymentError(failureReason, failedEvent.name);
    const refunded = await refundAndLog(session, error, failedEvent.id);
    return { success: false, error, refunded };
  }

  // Save per-event question answers for each attendee
  if (intent.eventAnswerIds) {
    for (const { attendee, event } of createdAttendees) {
      const answers = intent.eventAnswerIds[String(event.id)];
      if (answers && answers.length > 0) {
        await saveAttendeeAnswers([attendee.id], answers);
      }
    }
  }

  // Phase 3: Finalize with first attendee ID (for idempotency tracking)
  // createdAttendees is guaranteed non-empty: the loop always runs (intent.items
  // is validated non-empty) and if any creation fails we return early above.
  const firstAttendee = createdAttendees[0]!;

  const ticketTokens: string[] = map(
    ({ attendee }: { attendee: Attendee }) => attendee.ticket_token,
  )(createdAttendees);

  await finalizeSession(
    sessionId,
    firstAttendee.attendee.id,
    options?.storeTokens === false ? [] : ticketTokens,
  );

  await logAndNotifyRegistration(createdAttendees);

  return {
    success: true,
    attendee: firstAttendee.attendee,
    event: firstAttendee.event,
    ticketTokens,
  };
};

/**
 * Format error message based on refund status
 */
const formatPaymentError = (
  result: PaymentResult & { success: false },
): string => {
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
const processSessionAndRedirect = async (
  sessionId: string,
): Promise<Response> => {
  const validation = await validatePaidSession(sessionId);
  if (!validation.ok) return validation.response;

  const { data } = validation;
  // Skip persisting tokens — the redirect has them in memory and will put them in the URL.
  // This avoids tokens sitting in the DB forever when the redirect wins the race.
  const result = await processPaymentSession(sessionId, data, {
    storeTokens: false,
  });

  if (!result.success) {
    // Log once at the redirect boundary
    const eventId = data.intent.items[0]?.e;
    logError({
      code: ErrorCode.PAYMENT_SESSION,
      eventId,
      detail: `[redirect] ${result.detail ?? result.error}`,
    });
    return paymentErrorResponse(formatPaymentError(result), result.status);
  }

  // Clear any tokens stored by a webhook that won the race (consumed now via redirect URL)
  if (result.ticketTokens.length > 0) {
    await clearSessionTokens(sessionId);
  }

  // Redirect to success page with verified tokens in URL
  // encodeURIComponent preserves + as %2B so URLSearchParams.get() decodes it back correctly
  if (result.ticketTokens.length > 0) {
    return redirectResponse(
      `/payment/success?tokens=${encodeURIComponent(result.ticketTokens.join("+"))}`,
    );
  }

  // Already-processed session (no tokens available) - render directly
  const thankYouUrl =
    data.intent.items.length === 1 ? result.event.thank_you_url : "";
  return htmlResponse(
    successPage({ ticketUrl: null, thankYouUrl, paid: true }),
  );
};

/**
 * Render success page from verified tokens param.
 */
const renderSuccessFromTokens = async (
  tokensParam: string,
): Promise<Response> => {
  const tokens = parseTokens(tokensParam);
  const attendeeResults =
    tokens.length > 0 ? await getAttendeesByTokens(tokens) : [];
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
  let thankYouUrl = "";
  if (uniqueEventIds.length === 1) {
    const event = await getEvent(uniqueEventIds[0]!);
    if (event) thankYouUrl = event.thank_you_url;
  }

  const fromEmail = await getFromEmailIfConfigured();

  return htmlResponse(
    successPage({ ticketUrl, thankYouUrl, paid: true, fromEmail }),
  );
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
  const sessionId =
    getSearchParam(request, "session_id") || getSearchParam(request, "orderId");
  if (sessionId) return processSessionAndRedirect(sessionId);

  const tokensParam = getSearchParam(request, "tokens");
  if (tokensParam) return renderSuccessFromTokens(tokensParam);

  const url = new URL(request.url);
  const paramKeys = [...url.searchParams.keys()].join(",") || "none";
  const referer = request.headers.get("referer") ?? "none";
  logError({
    code: ErrorCode.PAYMENT_SESSION,
    detail: `Payment success callback with no session_id or tokens | params=[${paramKeys}] referer=${referer}`,
  });
  return Promise.resolve(paymentErrorResponse("Invalid payment callback"));
};

/**
 * Handle GET /payment/cancel (redirect after cancelled payment)
 *
 * No attendee cleanup needed - attendee is only created after successful payment.
 */
/** Log a payment session error with cancel context prefix */
const logCancelError = (detail: string): void =>
  logError({ code: ErrorCode.PAYMENT_SESSION, detail: `[cancel] ${detail}` });

const handlePaymentCancel = withSessionId(async (sid) => {
  const provider = await getActivePaymentProvider();
  if (!provider) {
    logCancelError(`No provider configured (session=${sid})`);
    return paymentErrorResponse("Payment provider not configured");
  }

  const session = await provider.retrieveSession(sid);
  if (!session) {
    logCancelError(`Session not found (session=${sid})`);
    return paymentErrorResponse("Payment session not found");
  }

  // Extract first event ID for redirect (multi uses items metadata, single uses event_id)
  const intent = isCartSession(session.metadata)
    ? extractBookingIntent(session)
    : extractIntent(session);
  const eventId = intent?.items[0]?.e ?? 0;

  // Use getEvent (not getEventWithCount) - we only need slug for redirect
  const event = await getEvent(eventId);
  if (!event) {
    logCancelError(`Event not found (session=${sid}, eventId=${eventId})`);
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

/** JSON response acknowledging a webhook event without processing */
const webhookAckResponse = (extra?: Record<string, unknown>): Response =>
  jsonResponse({ received: true, ...extra });

/** Detect which provider sent the webhook based on request headers */
const getWebhookSignatureHeader = (request: Request): string | null =>
  request.headers.get("stripe-signature") ??
  request.headers.get("x-square-hmacsha256-signature") ??
  null;

/**
 * Handle POST /payment/webhook (payment provider webhook endpoint)
 *
 * Receives events directly from the payment provider with signature verification.
 * Primary handler for payment completion - more reliable than redirects.
 */
const handlePaymentWebhook = async (request: Request): Promise<Response> => {
  // Read raw body bytes FIRST, before any async work. The Bunny Edge runtime
  // can garbage-collect the underlying request body resource during awaits
  // (e.g. dynamic imports in getActivePaymentProvider), causing "BadResource:
  // Cannot read body as underlying resource unavailable" errors.
  const payloadBytes = new Uint8Array(await request.arrayBuffer());
  const payload = new TextDecoder().decode(payloadBytes);

  // Get signature header (sync — headers are always available)
  const signature = getWebhookSignatureHeader(request);
  if (!signature) {
    logError({
      code: ErrorCode.PAYMENT_SESSION,
      detail: "Webhook missing signature header",
    });
    logDebug("Webhook", `Rejected payload: ${payload}`);
    return plainResponse("Missing signature", 400);
  }

  const provider = await getActivePaymentProvider();
  if (!provider) {
    logError({
      code: ErrorCode.PAYMENT_SESSION,
      detail: "Webhook received but payment provider not configured",
    });
    logDebug("Webhook", `Rejected payload: ${payload}`);
    return plainResponse("Payment provider not configured", 400);
  }

  // Use the public-facing domain for signature verification. Square signs the
  // webhook using the exact notification URL from the subscription, which is the
  // public https:// URL. Deriving from request.url fails behind CDNs that
  // terminate TLS (the edge runtime sees http:// instead of https://).
  const webhookUrl = `https://${getEffectiveDomain()}/payment/webhook`;

  // Verify signature (pass raw bytes so HMAC is computed on exact received bytes)
  const verification = await provider.verifyWebhookSignature(
    payload,
    signature,
    webhookUrl,
    payloadBytes,
  );
  if (!verification.valid) {
    logError({
      code: ErrorCode.PAYMENT_SIGNATURE,
      detail: `Webhook signature verification failed: ${verification.error}`,
    });
    logDebug("Webhook", `Rejected payload: ${payload}`);
    return plainResponse(verification.error, 400);
  }

  const event = verification.event;

  // Only handle checkout completed events
  if (event.type !== provider.checkoutCompletedEventType) {
    // Acknowledge other events without processing
    return webhookAckResponse();
  }

  // Delegate session extraction to the provider — each provider knows how to
  // resolve a session from its own webhook event structure.
  const sessionResult = await provider.resolveWebhookSession(event);

  if (sessionResult === "skip") {
    return webhookAckResponse({ status: "pending" });
  }

  if (!sessionResult) {
    logError({
      code: ErrorCode.PAYMENT_SESSION,
      detail: "Ignoring webhook for unrecognized payment session",
    });
    logDebug("Webhook", `Ignored payload: ${payload}`);
    return webhookAckResponse();
  }

  const session = sessionResult;

  // Verify session originated from this instance. Sessions created by a
  // different application sharing the same payment provider account will not
  // carry our _origin marker.
  const origin = session.metadata._origin;
  if (origin !== getEffectiveDomain()) {
    logError({
      code: ErrorCode.PAYMENT_SESSION,
      detail: "Ignoring webhook for unrecognized payment session",
    });
    logDebug("Webhook", `Ignored payload: ${payload}`);
    return webhookAckResponse();
  }

  // Verify payment is complete
  if (session.paymentStatus !== "paid") {
    logError({
      code: ErrorCode.PAYMENT_SESSION,
      detail: `Webhook session not yet paid (session=${session.id}, status=${session.paymentStatus})`,
    });
    logDebug("Webhook", `Pending payload: ${payload}`);
    return webhookAckResponse({ status: "pending" });
  }

  // Extract intent — cart sessions parse items metadata, single-item
  // sessions are wrapped into a one-item BookingIntent
  const isCart = isCartSession(session.metadata);
  const intent = isCart
    ? extractBookingIntent(session)
    : extractIntent(session);

  if (!intent) {
    logError({
      code: ErrorCode.PAYMENT_SESSION,
      detail: `Invalid cart session data for ${session.id}`,
    });
    logDebug("Webhook", `Rejected payload: ${payload}`);
    return plainResponse("Invalid cart session data", 400);
  }

  const eventIdForLog = intent.items[0]?.e;
  const result = await processPaymentSession(session.id, {
    session,
    intent,
  });

  if (!result.success) {
    // Log once at the boundary — inner functions pass structured context via result.detail
    logError({
      code: ErrorCode.PAYMENT_SESSION,
      eventId: eventIdForLog,
      detail: result.detail ?? result.error,
    });
    logDebug("Webhook", `Failed payload: ${payload}`);
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
