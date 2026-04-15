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

import { unique } from "#fp";
import { calculateBookingFee } from "#lib/booking-fee.ts";
import { getBookingFee, getEffectiveDomain } from "#lib/config.ts";
import { logActivity } from "#lib/db/activityLog.ts";
import {
  createAttendeeAtomic,
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
import { saveEventAnswers } from "#lib/db/questions.ts";
import { ErrorCode, logDebug, logError } from "#lib/logger.ts";
import {
  type BookingItem,
  getActivePaymentProvider,
  type ValidatedPaymentSession,
} from "#lib/payments.ts";
import type { EventWithCount } from "#lib/types.ts";
import { logAndNotifyRegistration } from "#lib/webhook.ts";
import { ensureAllBookings } from "#routes/public/ticket-payment.ts";
import { getFromEmailIfConfigured } from "#routes/public/ticket-routes.ts";
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
import type {
  BookingIntent,
  EventPriceValidation,
  EventValidation,
  PaymentFailureResult,
  PaymentResult,
  SessionValidation,
  ValidatedSession,
} from "#routes/webhook-types.ts";
import { paymentCancelPage, successPage } from "#templates/payment.tsx";

/** User-facing message when the event price changed between checkout and payment */
const PRICE_CHANGED_MESSAGE =
  "The price for this event changed while you were completing payment.";

/** Parse per-event answer IDs from metadata JSON string.
 * Returns undefined for empty input. The JSON was serialized by our own
 * buildMetadata, so we trust the structure. */
const parseEventAnswerIds = (
  json: string,
): Record<string, number[]> | undefined =>
  json ? (JSON.parse(json) as Record<string, number[]>) : undefined;

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

  const intent = extractIntent(session);
  if (!intent) {
    logRedirectError(`Invalid session data (session=${sessionId})`);
    return {
      ok: false,
      response: paymentErrorResponse("Invalid session data"),
    };
  }
  return { data: { intent, session }, ok: true };
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
      detail: "No payment provider configured for refund",
      eventId,
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
      eventId,
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
      detail: `Post-payment event not found (session=${session.id})`,
      error: validation.error,
      status: 404,
      success: false,
    };
  }
  const refunded = await refundAndLog(session, validation.error, eventId);
  return {
    error: validation.error,
    refunded,
    status: validation.status,
    success: false,
  };
};

/** Load an event by ID or return a 404 "Event not found" error payload. */
const loadEventOr404 = async <Extra extends Record<string, unknown>>(
  eventId: number,
  extra: Extra,
): Promise<
  | {
      ok: true;
      event: NonNullable<Awaited<ReturnType<typeof getEventWithCount>>>;
    }
  | ({ ok: false; error: string; status: 404 } & Extra)
> => {
  const event = await getEventWithCount(eventId);
  if (!event)
    return { error: "Event not found", ok: false, status: 404, ...extra };
  return { event, ok: true };
};

const validateEventForPayment = async (
  eventId: number,
  includeEventName = false,
): Promise<EventValidation> => {
  const loaded = await loadEventOr404(eventId, {});
  if (!loaded.ok) return loaded;
  const event = loaded.event;
  const name = includeEventName ? event.name : undefined;
  if (!event.active) {
    return {
      error: name
        ? `${name} is no longer accepting registrations.`
        : "This event is no longer accepting registrations.",
      ok: false,
    };
  }
  if (isRegistrationClosed(event)) {
    return {
      error: name
        ? `Sorry, registration for ${name} closed while you were completing payment.`
        : "Sorry, registration closed while you were completing payment.",
      ok: false,
    };
  }
  return { event, ok: true };
};

const validateAndPrice = async (
  input: { eventId: number; quantity: number },
  includeEventName = false,
): Promise<EventPriceValidation> => {
  const validation = await validateEventForPayment(
    input.eventId,
    includeEventName,
  );
  if (!validation.ok) return validation;
  const expectedPrice = validation.event.unit_price * input.quantity;
  return { event: validation.event, expectedPrice, ok: true };
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
const formatPostPaymentError = (
  reason: "capacity_exceeded" | "encryption_error",
  eventName = "",
): string =>
  formatCreationError(
    "Sorry, this event sold out while you were completing payment.",
    (name) => `Sorry, ${name} sold out while you were completing payment.`,
    "Registration failed.",
    reason,
    eventName,
  );

/** Return success result for an already-processed session.
 * Accepts a finalized payment record where attendee_id is guaranteed non-null. */
const alreadyProcessedResult = async (
  eventId: number,
  existing: ProcessedPayment & { attendee_id: number },
): Promise<PaymentResult> => {
  const loaded = await loadEventOr404(eventId, { success: false as const });
  if (!loaded.ok) {
    const { ok: _ok, ...rest } = loaded;
    return rest;
  }
  const decrypted = await decryptSessionTokens(existing.ticket_tokens);
  const ticketTokens = decrypted ? decrypted.split("+") : [];
  return {
    attendee: { id: existing.attendee_id },
    event: loaded.event,
    success: true,
    ticketTokens,
  };
};

/**
 * Parse booking items from metadata JSON.
 *
 * Precondition: the session has passed _origin verification, so this JSON
 * was serialized by our own buildMetadata(). We parse with JSON.parse
 * (which is safe) and do a basic structural check. Returns null only if the
 * JSON is unparseable or the array is empty — a corrupt item (e.g. missing
 * field) throws so the bug surfaces immediately.
 */
const isBookingItem = (item: unknown): item is BookingItem =>
  typeof item === "object" &&
  item !== null &&
  "e" in item &&
  "q" in item &&
  "p" in item &&
  Number.isInteger((item as BookingItem).e) &&
  Number.isInteger((item as BookingItem).q) &&
  Number.isInteger((item as BookingItem).p);

const parseBookingItems = (itemsJson: string): BookingItem[] | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(itemsJson);
  } catch {
    return null;
  }

  if (!Array.isArray(parsed) || parsed.length === 0) return null;

  for (const item of parsed) {
    if (!isBookingItem(item)) {
      throw new Error(
        `Corrupt booking item in session metadata: ${JSON.stringify(item)}`,
      );
    }
  }

  // Every element validated by the type guard above
  return parsed as BookingItem[];
};

/**
 * Extract booking intent from session metadata.
 * Converts date from metadata's "" convention to null for domain use.
 */
const extractIntent = (
  session: ValidatedPaymentSession,
): BookingIntent | null => {
  const { metadata } = session;
  const items = parseBookingItems(metadata.items);
  if (!items || items.length === 0) return null;

  return {
    address: metadata.address,
    date: metadata.date || null,
    email: metadata.email,
    eventAnswerIds: parseEventAnswerIds(metadata.answer_ids),
    items,
    name: metadata.name,
    phone: metadata.phone,
    special_instructions: metadata.special_instructions,
  };
};

/** Log a price mismatch and refund the session */
const priceMismatchRefund = async (
  session: ValidatedPaymentSession,
  detail: string,
  eventId: number,
): Promise<PaymentResult> => {
  const refunded = await refundAndLog(session, PRICE_CHANGED_MESSAGE, eventId);
  return { detail, error: PRICE_CHANGED_MESSAGE, refunded, success: false };
};

type ValidatedItem = {
  item: BookingItem;
  event: EventWithCount;
  expectedPrice: number;
};

/** Handle the "already reserved" branch of reserveSession */
const handleReservationConflict = (
  intent: BookingIntent,
  existing: ProcessedPayment,
): Promise<PaymentResult> | PaymentResult => {
  if (existing.attendee_id !== null) {
    return alreadyProcessedResult(intent.items[0]!.e, {
      ...existing,
      attendee_id: existing.attendee_id,
    });
  }
  // Session reserved but not finalized — another request is processing
  return {
    error: "Payment is being processed. Please wait a moment and refresh.",
    status: 409,
    success: false,
  };
};

/** Validate all booking items and return per-item pricing info or a failure result. */
const validateAllItems = async (
  session: ValidatedPaymentSession,
  intent: BookingIntent,
): Promise<{ ok: true; items: ValidatedItem[] } | PaymentResult> => {
  const includeEventName = intent.items.length > 1;
  const validatedItems: ValidatedItem[] = [];
  for (const item of intent.items) {
    const vp = await validateAndPrice(
      { eventId: item.e, quantity: item.q },
      includeEventName,
    );
    if (!vp.ok) return validationFailure(session, vp, item.e);
    validatedItems.push({
      event: vp.event,
      expectedPrice: vp.expectedPrice,
      item,
    });
  }
  return { items: validatedItems, ok: true };
};

/** Verify per-item and total prices for paid sessions. Returns null on success. */
const verifyPaidPricing = async (
  session: ValidatedPaymentSession,
  intent: BookingIntent,
  validatedItems: ValidatedItem[],
): Promise<PaymentResult | null> => {
  const hasPaidItems = intent.items.some((item) => item.p > 0);
  if (!hasPaidItems) return null;

  // Per-item prices are ticket-only (no fee), so validate without booking fee
  for (const { item, event, expectedPrice } of validatedItems) {
    if (hasPriceMismatch(item.p, expectedPrice, event, 0, item.q)) {
      return await priceMismatchRefund(
        session,
        `Per-item price mismatch for event ${event.id}: metadata p=${item.p} but expected ${expectedPrice} (can_pay_more=${event.can_pay_more})`,
        event.id,
      );
    }
  }

  // Total must equal sum of per-item prices + booking fee
  const bookingFeePercent = getBookingFee();
  const metadataTotal = validatedItems.reduce(
    (sum, { item }) => sum + item.p,
    0,
  );
  const expectedTotal =
    metadataTotal + calculateBookingFee(metadataTotal, bookingFeePercent);
  if (session.amountTotal !== expectedTotal) {
    return await priceMismatchRefund(
      session,
      `Total mismatch: provider charged ${session.amountTotal} but expected ${expectedTotal}`,
      validatedItems[0]!.event.id,
    );
  }
  return null;
};

type CreatedAttendee = Extract<
  Awaited<ReturnType<typeof createAttendeeAtomic>>,
  { success: true }
>["attendees"][number];

type CreatedEntry = { attendee: CreatedAttendee; event: EventWithCount };

/** Create the attendee plus per-event bookings atomically. */
const createAttendeeForSession = async (
  session: ValidatedPaymentSession,
  intent: BookingIntent,
  validatedItems: ValidatedItem[],
): Promise<{ ok: true; entries: CreatedEntry[] } | PaymentResult> => {
  const bookings = validatedItems.map(({ item, event }) => ({
    date: event.event_type === "daily" ? intent.date : null,
    eventId: item.e,
    pricePaid: item.p,
    quantity: item.q,
  }));

  const result = await createAttendeeAtomic({
    address: intent.address,
    bookings,
    email: intent.email,
    name: intent.name,
    paymentId: session.paymentReference,
    phone: intent.phone,
    special_instructions: intent.special_instructions,
  });

  // For paid bookings, require all-or-nothing: partial success = rollback + refund
  const bookingCheck = await ensureAllBookings(result, bookings.length);
  if (!bookingCheck.ok) {
    const error = formatPostPaymentError(
      bookingCheck.reason,
      validatedItems[0]!.event.name,
    );
    return {
      error,
      refunded: await refundAndLog(session, error, validatedItems[0]!.event.id),
      success: false,
    };
  }
  const created = result as Extract<typeof result, { success: true }>;
  const entries = created.attendees.map((attendee, i) => ({
    attendee,
    event: validatedItems[i]!.event,
  }));
  return { entries, ok: true };
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
  data: ValidatedSession,
  options?: { storeTokens?: boolean },
): Promise<PaymentResult> => {
  const { session, intent } = data;
  // Phase 1: Reserve the session (claim the lock)
  const reservation = await reserveSession(sessionId);
  if (!reservation.reserved) {
    return handleReservationConflict(intent, reservation.existing);
  }

  // Phase 2: Validate events and create attendees atomically
  const validated = await validateAllItems(session, intent);
  if ("success" in validated) return validated;
  const validatedItems = validated.items;

  const pricingError = await verifyPaidPricing(session, intent, validatedItems);
  if (pricingError) return pricingError;

  const created = await createAttendeeForSession(
    session,
    intent,
    validatedItems,
  );
  if ("success" in created) return created;
  const createdEntries = created.entries;

  if (intent.eventAnswerIds) {
    await saveEventAnswers(createdEntries, intent.eventAnswerIds);
  }

  const firstAttendee = createdEntries[0]!;
  const ticketToken = firstAttendee.attendee.ticket_token;

  await finalizeSession(
    sessionId,
    firstAttendee.attendee.id,
    options?.storeTokens === false ? [] : [ticketToken],
  );

  await logAndNotifyRegistration(createdEntries);

  return {
    attendee: firstAttendee.attendee,
    event: firstAttendee.event,
    success: true,
    ticketTokens: [ticketToken],
  };
};

/**
 * Format error message based on refund status
 */
const formatPaymentError = (result: PaymentFailureResult): string => {
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

  // Skip persisting tokens — the redirect has them in memory and will put them in the URL.
  // This avoids tokens sitting in the DB forever when the redirect wins the race.
  const result = await processPaymentSession(sessionId, validation.data, {
    storeTokens: false,
  });

  if (!result.success) {
    // Log once at the redirect boundary
    const eventId = validation.data.intent.items[0]?.e;
    logError({
      code: ErrorCode.PAYMENT_SESSION,
      detail: `[redirect] ${result.detail ?? result.error}`,
      eventId,
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
    validation.data.intent.items.length === 1 ? result.event.thank_you_url : "";
  return htmlResponse(
    successPage({ paid: true, thankYouUrl, ticketUrl: null }),
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
    const awb = attendeeResults[i];
    if (awb) {
      verifiedTokens.push(tokens[i]!);
      // Collect all event IDs from all bookings
      for (const booking of awb.bookings) {
        eventIds.push(booking.event_id);
      }
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
    if (event) thankYouUrl = event.thank_you_url.trim();
  }

  const fromEmail = await getFromEmailIfConfigured();

  return htmlResponse(
    successPage({ fromEmail, paid: true, thankYouUrl, ticketUrl }),
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

  const intent = extractIntent(session);
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
    logDebug(
      "Webhook",
      `Ignoring webhook for unrecognized payment session: ${payload}`,
    );
    return webhookAckResponse();
  }

  const session = sessionResult;

  // Verify session originated from this instance. Sessions created by a
  // different application sharing the same payment provider account will not
  // carry our _origin marker.
  const origin = session.metadata._origin;
  if (origin !== getEffectiveDomain()) {
    logDebug(
      "Webhook",
      `Ignoring webhook for unrecognized payment session (origin=${origin}): ${payload}`,
    );
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

  const intent = extractIntent(session);
  if (!intent) {
    logError({
      code: ErrorCode.PAYMENT_SESSION,
      detail: `Invalid session data for ${session.id}`,
    });
    logDebug("Webhook", `Rejected payload: ${payload}`);
    return plainResponse("Invalid session data", 400);
  }

  const eventIdForLog = intent.items[0]?.e;
  const result = await processPaymentSession(session.id, {
    intent,
    session,
  });

  if (!result.success) {
    // Log once at the boundary — inner functions pass structured context via result.detail
    logError({
      code: ErrorCode.PAYMENT_SESSION,
      detail: result.detail ?? result.error,
      eventId: eventIdForLog,
    });
    logDebug("Webhook", `Failed payload: ${payload}`);
  }

  return webhookAckResponse({
    error: result.success ? undefined : result.error,
    processed: result.success,
  });
};

/** Payment routes definition */
const paymentRoutes = defineRoutes({
  "GET /payment/cancel": handlePaymentCancel,
  "GET /payment/success": handlePaymentSuccess,
  "POST /payment/webhook": handlePaymentWebhook,
});

/**
 * Route payment requests
 */
export const routePayment = createRouter(paymentRoutes);
