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

import { sumOf, unique } from "#fp";
import type {
  BookingIntent,
  ListingPriceValidation,
  ListingValidation,
  PaymentFailureResult,
  PaymentResult,
  SessionValidation,
  SignedVerdict,
  ValidatedSession,
} from "#routes/api/webhook-types.ts";
import {
  capacityErrorFormatter,
  isRegistrationClosed,
} from "#routes/format.ts";
import { bookingDateFields } from "#routes/public/ticket-payment.ts";
import { getFromEmailIfConfigured } from "#routes/public/ticket-routes.ts";
import {
  htmlResponse,
  jsonResponse,
  paymentErrorResponse,
  plainResponse,
  redirectResponse,
} from "#routes/response.ts";
import { createRouter, defineRoutes } from "#routes/router.ts";
import { parseTokens } from "#routes/tickets/token-utils.ts";
import { getSearchParam } from "#routes/url.ts";
import { attendeeAccount, WORLD } from "#shared/accounting/accounts.ts";
import { transfersByAccount } from "#shared/accounting/queries.ts";
import { eventGroup, legReference } from "#shared/accounting/refs.ts";
import { guardedInsertStatement } from "#shared/accounting/rows.ts";
import { calculateBookingFee } from "#shared/booking-fee.ts";
import {
  bookingLedgerPoster,
  createOrSoldOut,
} from "#shared/checkout-complete.ts";
import {
  type ModifierApplication,
  type PricedOrder,
  priceCheckout,
} from "#shared/checkout-pricing.ts";
import { getEffectiveDomain } from "#shared/config.ts";
import { formatCurrency } from "#shared/currency.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import { getPublicStatusId } from "#shared/db/attendee-statuses.ts";
import { settleAttendeeBalance } from "#shared/db/attendees/balance.ts";
import {
  type createAttendeeAtomic,
  ensureAllBookings,
  getAttendeesByTokens,
} from "#shared/db/attendees.ts";
import { getListing, getListingWithCount } from "#shared/db/listings.ts";
import { buyerVisits, specsFromRefs } from "#shared/db/modifier-resolve.ts";
import {
  balanceFinalizeStatement,
  clearSessionTokens,
  decryptSessionTokens,
  finalizeSession,
  markSessionFailed,
  type ProcessedPayment,
  parseSessionFailure,
  releaseReservation,
  reserveSession,
} from "#shared/db/processed-payments.ts";
import {
  groupListingAnswers,
  saveAttendeeAnswers,
} from "#shared/db/questions.ts";
import { settings } from "#shared/db/settings.ts";
import { ErrorCode, logDebug, logError } from "#shared/logger.ts";
import { nowIso } from "#shared/now.ts";
import { sendNtfyError } from "#shared/ntfy.ts";
import { verifyPrice } from "#shared/payment-signature.ts";
import {
  type BookingItem,
  type CheckoutIntent,
  getActivePaymentProvider,
  type ModifierRef,
  type ModifierSpec,
  type TextAnswerRef,
  type ValidatedPaymentSession,
  type WebhookEvent,
} from "#shared/payments.ts";
import { addPendingWork } from "#shared/pending-work.ts";
import { dayPriceFor, type ListingWithCount } from "#shared/types.ts";
import { logAndNotifyRegistration } from "#shared/webhook.ts";
import { paymentCancelPage, successPage } from "#templates/payment.tsx";

/** User-facing message when the listing price changed between checkout and payment */
const PRICE_CHANGED_MESSAGE =
  "The price for this listing changed while you were completing payment.";

/** User-facing message when a chosen add-on/discount sold out during payment. */
const MODIFIER_SOLD_OUT_MESSAGE =
  "An extra you selected sold out while you were completing payment.";

/**
 * The ledger occurredAt for a payment: the provider's checkout time — the
 * customer's business time — so a late webhook (or an old redirect, or a stale
 * retry) still books on the day they paid. Falls back to the processing clock
 * only when the provider gave no timestamp.
 */
const businessTime = (session: ValidatedPaymentSession): string =>
  session.createdAt ?? nowIso();

/** Parse per-listing answer IDs from metadata JSON string.
 * Returns undefined for empty input. The JSON was serialized by our own
 * buildMetadata, so we trust the structure. */
const parseListingAnswerIds = (
  json: string,
): Record<string, number[]> | undefined =>
  json ? (JSON.parse(json) as Record<string, number[]>) : undefined;

const parseListingTextAnswerIds = (
  json: string,
): Record<string, TextAnswerRef[]> | undefined =>
  json ? (JSON.parse(json) as Record<string, TextAnswerRef[]>) : undefined;

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

/** Render the payment-cancelled page for a session's first listing. */
const cancelPageResponse = async (
  session: ValidatedPaymentSession,
  logFailure: (detail: string) => void,
): Promise<Response> => {
  const intent = extractIntent(session);
  const listingId = intent?.items[0]?.e ?? 0;
  // Use getListing (not getListingWithCount) - we only need slug for the link
  const listing = await getListing(listingId);
  if (!listing) {
    logFailure(
      `Listing not found (session=${session.id}, listingId=${listingId})`,
    );
    return paymentErrorResponse("Listing not found", 404);
  }
  return htmlResponse(paymentCancelPage(listing, `/ticket/${listing.slug}`));
};

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

  // Declined or expired checkout: SumUp's hosted page has a single redirect
  // URL for every outcome, so a card decline lands here. Show the friendly
  // cancel/try-again page, not a "contact support" error.
  if (session.paymentStatus === "failed") {
    return {
      ok: false,
      response: await cancelPageResponse(session, logRedirectError),
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

  // Only a session carrying a valid price proof is provably ours. Without one we
  // cannot prove ownership (foreign instance sharing the provider, replayed or
  // corrupt data), so we neither process nor refund it — refunding an
  // unverifiable session could refund another instance's payment.
  const verdict = await classifySession(session);
  if (verdict.verdict === "ignore") {
    logRedirectError(`Unrecognized payment session (session=${sessionId})`);
    return {
      ok: false,
      response: paymentErrorResponse("Payment session not recognized"),
    };
  }
  // A valid proof means the metadata is byte-for-byte what we signed, so the
  // intent always parses — extractIntent only returns null on metadata we never
  // produced.
  const intent = extractIntent(session)!;
  return { data: { intent, session, verdict }, ok: true };
};

/**
 * Attempt to refund a payment. Returns true if refund succeeded, false otherwise.
 * Logs an error if refund fails.
 */
const tryRefund = async (
  paymentReference: string,
  listingId?: number,
): Promise<boolean> => {
  if (!paymentReference) return false;

  const provider = await getActivePaymentProvider();
  if (!provider) {
    logError({
      code: ErrorCode.PAYMENT_REFUND,
      detail: "No payment provider configured for refund",
      listingId,
    });
    return false;
  }

  if (await provider.refundPayment(paymentReference)) {
    logDebug("Payment", "Refund issued");
    return true;
  }

  // A false return can simply mean the payment was ALREADY fully refunded: each
  // provider rejects a second full refund (Stripe errors on an already-refunded
  // intent; Square and SumUp reject a re-refund), and that rejection surfaces
  // here as false. That is success, not failure — the money is back with the
  // customer — so confirm via the provider's refund-status query before
  // reporting failure. Without this, a redelivery after a recovered refund would
  // loop on a 503 retry for money already returned.
  if (await provider.isPaymentRefunded(paymentReference)) {
    logDebug("Payment", "Payment already fully refunded");
    return true;
  }

  logError({
    code: ErrorCode.PAYMENT_REFUND,
    detail: `Failed to refund payment ${paymentReference}`,
    listingId,
  });
  return false;
};

/** Attempt refund and log activity if successful */
const refundAndLog = async (
  session: ValidatedPaymentSession,
  error: string,
  listingId: number,
): Promise<boolean> => {
  const refunded = await tryRefund(session.paymentReference, listingId);
  if (refunded) {
    await logActivity(`Automatic refund: ${error}`, listingId);
  }
  return refunded;
};

/**
 * Refund the session and return a handled-failure PaymentResult. The single
 * refund-and-fail shape shared by post-payment failures (validation, price
 * mismatch, balance mismatch) so the refundAndLog + 409/410 result block isn't
 * re-spelled at each site.
 */
const refundAndFail = async (
  session: ValidatedPaymentSession,
  message: string,
  listingId: number,
  status: number | undefined,
  detail?: string,
): Promise<PaymentFailureResult> => {
  const refunded = await refundAndLog(session, message, listingId);
  return { detail, error: message, refunded, status, success: false };
};

/**
 * Handle listing validation failure: skip refund for unknown listings (404)
 * since the webhook may be intended for a different instance sharing the same
 * payment provider account. For known-listing failures (inactive, closed),
 * refund so the customer gets their money back.
 */
const validationFailure = (
  session: ValidatedPaymentSession,
  validation: { error: string; status?: number },
  listingId: number,
): Promise<PaymentFailureResult> | PaymentFailureResult => {
  if (validation.status === 404) {
    return {
      detail: `Post-payment listing not found (session=${session.id})`,
      error: validation.error,
      status: 404,
      success: false,
    };
  }
  return refundAndFail(session, validation.error, listingId, validation.status);
};

/** Load a listing by ID or return a 404 "Listing not found" error payload. */
const loadListingOr404 = async (
  listingId: number,
): Promise<
  | {
      ok: true;
      listing: NonNullable<Awaited<ReturnType<typeof getListingWithCount>>>;
    }
  | { ok: false; error: string; status: 404 }
> => {
  const listing = await getListingWithCount(listingId);
  if (!listing) {
    return { error: "Listing not found", ok: false, status: 404 };
  }
  return { listing, ok: true };
};

const validateListingForPayment = async (
  listingId: number,
  includeListingName = false,
): Promise<ListingValidation> => {
  const loaded = await loadListingOr404(listingId);
  if (!loaded.ok) return loaded;
  const listing = loaded.listing;
  const name = includeListingName ? listing.name : undefined;
  if (!listing.active) {
    return {
      error: name
        ? `${name} is no longer accepting registrations.`
        : "This listing is no longer accepting registrations.",
      ok: false,
      status: 410,
    };
  }
  if (isRegistrationClosed(listing)) {
    return {
      error: name
        ? `Sorry, registration for ${name} closed while you were completing payment.`
        : "Sorry, registration closed while you were completing payment.",
      ok: false,
      status: 410,
    };
  }
  return { listing, ok: true };
};

const validateAndPrice = async (
  input: { listingId: number; quantity: number },
  includeListingName = false,
  dayCount?: number,
): Promise<ListingPriceValidation> => {
  const validation = await validateListingForPayment(
    input.listingId,
    includeListingName,
  );
  if (!validation.ok) return validation;
  // Customisable-days listings are priced by the chosen day count, not by the
  // flat unit_price, so the per-item amount must be re-derived the same way the
  // checkout computed it.
  const perTicket = validation.listing.customisable_days
    ? (dayPriceFor(validation.listing, dayCount ?? 1) ?? 0)
    : validation.listing.unit_price;
  const expectedPrice = perTicket * input.quantity;
  return { expectedPrice, listing: validation.listing, ok: true };
};

/** Check if the amount charged matches the current listing price (including booking fee).
 * For pay-more listings, the amount must be >= the expected minimum price and <= the max cap.
 * `quantity` scales max_price so purchases are validated against the correct total cap. */
const hasPriceMismatch = (
  amountTotal: number,
  expectedPrice: number,
  listing: Pick<ListingWithCount, "can_pay_more" | "max_price">,
  bookingFeePercent: number,
  quantity: number,
): boolean => {
  if (listing.can_pay_more) {
    const minWithFee =
      expectedPrice + calculateBookingFee(expectedPrice, bookingFeePercent);
    const maxTicketTotal = listing.max_price * quantity;
    const maxWithFee =
      maxTicketTotal + calculateBookingFee(maxTicketTotal, bookingFeePercent);
    return amountTotal < minWithFee || amountTotal > maxWithFee;
  }
  const expectedWithFee =
    expectedPrice + calculateBookingFee(expectedPrice, bookingFeePercent);
  return amountTotal !== expectedWithFee;
};

/** Format error for post-payment attendee creation failure */
const formatPostPaymentError = capacityErrorFormatter({
  fallback: "Registration failed.",
  generic: "Sorry, this listing sold out while you were completing payment.",
  withName: (name) =>
    `Sorry, ${name} sold out while you were completing payment.`,
});

/** Return success result for an already-processed session.
 * Accepts a finalized payment record where attendee_id is guaranteed non-null.
 * Carries the listing id (not the loaded listing): the redirect resolves it
 * lazily only when it needs a thank-you URL, and a since-deleted listing is
 * still a success replay because the attendee already exists. */
const alreadyProcessedResult = async (
  listingId: number,
  existing: ProcessedPayment & { attendee_id: number },
): Promise<PaymentResult> => {
  const decrypted = await decryptSessionTokens(existing.ticket_tokens);
  const ticketTokens = decrypted ? decrypted.split("+") : [];
  return {
    attendee: { id: existing.attendee_id },
    listingId,
    success: true,
    ticketTokens,
  };
};

/**
 * Parse booking items from metadata JSON. Returns null when the JSON is
 * unparseable, not an array, or empty.
 *
 * Every fulfilment caller reaches this only for a session carrying a valid price
 * proof, so the items are exactly what our checkout serialized — a non-empty
 * array of well-formed items. The cancel page also parses here, but only on a
 * best-effort basis to find a listing id for its back-link, so a session that
 * never came through our checkout degrades to null rather than throwing.
 */
const parseBookingItems = (itemsJson: string): BookingItem[] | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(itemsJson);
  } catch {
    return null;
  }

  if (!Array.isArray(parsed) || parsed.length === 0) return null;

  return parsed as BookingItem[];
};

/** Parse the compact modifier references from session metadata. Our own JSON,
 * round-tripped through the provider; absent (empty) means no modifiers. */
const parseModifierRefs = (json: string): ModifierRef[] =>
  json ? (JSON.parse(json) as ModifierRef[]) : [];

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

  const parsedDayCount = Number.parseInt(metadata.day_count, 10);
  return {
    address: metadata.address,
    balanceAttendeeId: metadata.balance_attendee_id
      ? Number(metadata.balance_attendee_id)
      : undefined,
    date: metadata.date || null,
    dayCount:
      Number.isInteger(parsedDayCount) && parsedDayCount > 0
        ? parsedDayCount
        : undefined,
    email: metadata.email,
    items,
    listingAnswerIds: parseListingAnswerIds(metadata.answer_ids),
    listingTextAnswerIds: parseListingTextAnswerIds(metadata.text_answer_ids),
    modifiers: parseModifierRefs(metadata.modifiers),
    name: metadata.name,
    phone: metadata.phone,
    reservationAmount: metadata.reservation_amount || undefined,
    siteTokenIndex: metadata.site_token_index || undefined,
    special_instructions: metadata.special_instructions,
  };
};

/** Log a price mismatch and refund the session */
const priceMismatchRefund = (
  session: ValidatedPaymentSession,
  detail: string,
  listingId: number,
): Promise<PaymentResult> =>
  refundAndFail(session, PRICE_CHANGED_MESSAGE, listingId, 409, detail);

type ValidatedItem = {
  item: BookingItem;
  listing: ListingWithCount;
  expectedPrice: number;
};

/** Handle the "already reserved" branch of reserveSession */
const handleReservationConflict = async (
  intent: BookingIntent,
  existing: ProcessedPayment,
): Promise<PaymentResult> => {
  if (existing.attendee_id !== null) {
    return alreadyProcessedResult(intent.items[0]!.e, {
      ...existing,
      attendee_id: existing.attendee_id,
    });
  }
  // A recorded terminal failure replays the same handled outcome (refund
  // already issued, sold out, price changed) without re-validating or
  // re-refunding. failure_data is encrypted, so this read is async.
  const failure = await parseSessionFailure(existing.failure_data);
  if (failure) return { ...failure, success: false };
  // Otherwise reserved but not finalized — another request is mid-flight.
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
): Promise<{ ok: true; items: ValidatedItem[] } | PaymentFailureResult> => {
  const includeListingName = intent.items.length > 1;
  const validatedItems: ValidatedItem[] = [];
  for (const item of intent.items) {
    const vp = await validateAndPrice(
      { listingId: item.e, quantity: item.q },
      includeListingName,
      intent.dayCount,
    );
    if (!vp.ok) return validationFailure(session, vp, item.e);
    validatedItems.push({
      expectedPrice: vp.expectedPrice,
      item,
      listing: vp.listing,
    });
  }
  return { items: validatedItems, ok: true };
};

const checkoutIntentForSession = (
  intent: BookingIntent,
  validatedItems: ValidatedItem[],
  modifierSpecs: ModifierSpec[],
): CheckoutIntent => ({
  address: intent.address,
  date: intent.date,
  email: intent.email,
  items: validatedItems.map((v) => ({
    listingId: v.item.e,
    name: v.listing.name,
    quantity: v.item.q,
    slug: v.listing.slug,
    unitPrice: v.item.p / v.item.q,
  })),
  modifiers: modifierSpecs,
  name: intent.name,
  phone: intent.phone,
  special_instructions: intent.special_instructions,
  ...(intent.dayCount ? { dayCount: intent.dayCount } : {}),
  ...(intent.reservationAmount
    ? { reservationAmount: intent.reservationAmount }
    : {}),
});

const orderLineTotal = (order: PricedOrder): number =>
  sumOf(
    (line: PricedOrder["lines"][number]) =>
      line.chargedUnitAmount * line.quantity,
  )(order.lines);

const paidByListing = (order: PricedOrder): Map<number, number> => {
  const paid = new Map<number, number>();
  for (const line of order.lines) {
    const current = paid.get(line.item.listingId) ?? 0;
    paid.set(
      line.item.listingId,
      current + line.chargedUnitAmount * line.quantity,
    );
  }
  return paid;
};

/** Split the `total.sig` price proof into a non-negative integer total and a
 * non-empty signature, or null when the field is absent or malformed. */
const parsePriceProof = (
  proof: string,
): { total: number; sig: string } | null => {
  const match = /^(\d+)\.(.+)$/.exec(proof);
  return match ? { sig: match[2]!, total: Number(match[1]) } : null;
};

/**
 * Evaluate a session's price proof against its metadata:
 *  - `null`: no proof at all.
 *  - `{ valid: false }`: a proof is present but doesn't verify (tampered
 *    metadata, or a foreign instance that signed with its own key).
 *  - `{ valid: true, total }`: a genuine proof binding `total`.
 *
 * Only the third case proves the session is ours; the first two both classify as
 * `ignore` (see {@link classifySession}).
 */
const evaluatePriceProof = async (
  session: ValidatedPaymentSession,
): Promise<null | { valid: false } | { valid: true; total: number }> => {
  const proof = session.metadata.price_proof;
  if (!proof) return null;
  const parsed = parsePriceProof(proof);
  if (
    parsed === null ||
    !(await verifyPrice(session.metadata, parsed.total, parsed.sig))
  ) {
    return { valid: false };
  }
  return { total: parsed.total, valid: true };
};

/**
 * The single classification of a paid session — the one place the trust matrix
 * lives, so every downstream decision reads one verdict. A valid price proof is
 * the *only* signal that a session is ours: it cannot be forged without our key,
 * and our checkout always attaches one, so the `_origin` marker plays no part in
 * the decision (it is unsigned and forgeable).
 *
 *  - `trusted` — valid proof and the charge matches the signed total: process,
 *    using `agreed` as the price oracle.
 *  - `mismatch` — valid proof but the provider charged a different amount than we
 *    signed: refund (defensive — we create the checkout with the exact total).
 *  - `ignore` — no valid proof (absent, malformed, tampered, or signed by another
 *    instance). We cannot prove it is ours, so we neither process nor refund it:
 *    refunding an unverifiable session could refund another instance's payment,
 *    and a corrupted one of ours is a support case, not an automatic refund.
 */
type SessionClass = SignedVerdict | { verdict: "ignore" };

const classifySession = async (
  session: ValidatedPaymentSession,
): Promise<SessionClass> => {
  const evaluation = await evaluatePriceProof(session);
  if (evaluation === null || !evaluation.valid) return { verdict: "ignore" };
  return session.amountTotal === evaluation.total
    ? { agreed: evaluation.total, verdict: "trusted" }
    : { agreed: evaluation.total, verdict: "mismatch" };
};

/**
 * Refund a session the provider charged for an amount other than our signed
 * total. Defers the alert so a slow ntfy never delays the money.
 */
const refuseMismatch = (
  session: ValidatedPaymentSession,
  agreed: number,
  listingId: number,
): Promise<PaymentResult> => {
  addPendingWork(sendNtfyError(ErrorCode.WEBHOOK_PRICE_SIGNATURE));
  return priceMismatchRefund(
    session,
    `Provider charged ${session.amountTotal} but signed total was ${agreed}`,
    listingId,
  );
};

/**
 * Verify a trusted session's prices against the live listing data. Returns null
 * on success, or a refund result.
 *
 * `agreed` is the signed total carried by the trusted verdict. The proof already
 * pins every pricing input (items, modifier refs, answer ids, reservation
 * snapshot) and the charge already equals `agreed`, so the only thing that can
 * still differ is the *current* database price — a listing/modifier/answer price
 * edited between checkout and this webhook. Both checks below catch that
 * legitimate mid-checkout price change and refund. Pricing-code divergence on
 * identical inputs is caught at dev time by the property-based consistency test,
 * so this runtime path refunds without paging.
 */
const verifyPaidPricing = async (
  session: ValidatedPaymentSession,
  intent: BookingIntent,
  validatedItems: ValidatedItem[],
  pricedOrder: PricedOrder,
  agreed: number,
): Promise<PaymentResult | null> => {
  const listingId = validatedItems[0]!.listing.id;
  const hasPaidItems = intent.items.some((item) => item.p > 0);

  // Per-item prices are ticket-only (no fee), so validate without booking fee
  if (hasPaidItems) {
    for (const { item, listing, expectedPrice } of validatedItems) {
      if (hasPriceMismatch(item.p, expectedPrice, listing, 0, item.q)) {
        return await priceMismatchRefund(
          session,
          `Per-item price mismatch for listing ${listing.id}: metadata p=${item.p} but expected ${expectedPrice} (can_pay_more=${listing.can_pay_more})`,
          listing.id,
        );
      }
    }
  }

  if (pricedOrder.total !== agreed) {
    return priceMismatchRefund(
      session,
      `Re-derived total ${pricedOrder.total} differs from signed total ${agreed}`,
      listingId,
    );
  }
  return null;
};

type CreatedAttendee = Extract<
  Awaited<ReturnType<typeof createAttendeeAtomic>>,
  { success: true }
>["attendees"][number];

type CreatedEntry = { attendee: CreatedAttendee; listing: ListingWithCount };

/**
 * Keep only the text-answer refs that still carry a resolved string id (`s`).
 *
 * A ref without one is corrupt metadata: a checkout signed before string-id
 * resolution was fixed to read its ids back from the primary could drop the `s`
 * (a replica answered the read before the insert replicated, so the id resolved
 * to undefined and JSON.stringify omitted the key). The referenced text is not
 * recoverable from the metadata, so we drop that single answer and surface it
 * loudly, rather than bind an undefined id — the payment is already captured, so
 * the booking must still finalize instead of crash-looping the webhook.
 */
const textRefsWithStringId = (
  refs: TextAnswerRef[],
  listingId: number,
): TextAnswerRef[] => {
  const resolved: TextAnswerRef[] = [];
  for (const ref of refs) {
    if (Number.isInteger(ref.s)) {
      resolved.push(ref);
    } else {
      logError({
        code: ErrorCode.DATA_INVALID,
        detail: `Text answer ref missing string id (question=${ref.q})`,
        listingId,
      });
    }
  }
  return resolved;
};

const saveSessionAnswers = async (
  createdEntries: CreatedEntry[],
  intent: BookingIntent,
): Promise<void> => {
  if (!intent.listingAnswerIds && !intent.listingTextAnswerIds) return;
  const choiceAnswers = groupListingAnswers(
    createdEntries,
    intent.listingAnswerIds ?? {},
  );
  const grouped: Map<
    number,
    {
      answerIds: number[];
      textAnswerIds?: { questionId: number; stringId: number }[];
    }
  > = new Map(
    [...choiceAnswers].map(([attendeeId, answerIds]) => [
      attendeeId,
      { answerIds },
    ]),
  );
  for (const { attendee, listing } of createdEntries) {
    const refs = intent.listingTextAnswerIds?.[String(listing.id)] ?? [];
    const resolvedRefs = textRefsWithStringId(refs, listing.id);
    if (resolvedRefs.length === 0) continue;
    const existing = grouped.get(attendee.id) ?? { answerIds: [] };
    grouped.set(attendee.id, {
      ...existing,
      textAnswerIds: [
        ...(existing.textAnswerIds ?? []),
        ...resolvedRefs.map((ref) => ({ questionId: ref.q, stringId: ref.s })),
      ],
    });
  }
  await saveAttendeeAnswers(grouped);
};

/**
 * Create the attendee plus per-listing bookings atomically.
 * durationDays is listing-scoped and re-read here at finalize time so the
 * stored range always matches the listing's current duration policy.
 */
const createAttendeeForSession = async (
  session: ValidatedPaymentSession,
  intent: BookingIntent,
  validatedItems: ValidatedItem[],
  pricedOrder: PricedOrder,
): Promise<{ ok: true; entries: CreatedEntry[] } | PaymentResult> => {
  const linePaidByListing = paidByListing(pricedOrder);
  const bookings = validatedItems.map(({ item, listing }) => ({
    listingId: item.e,
    pricePaid: linePaidByListing.get(item.e)!,
    quantity: item.q,
    ...bookingDateFields(listing, intent.date, intent.dayCount),
  }));
  const fullTotal = pricedOrder.fullSubtotal;
  const depositTotal = orderLineTotal(pricedOrder);
  const remainingBalance =
    intent.reservationAmount === undefined ? 0 : fullTotal - depositTotal;

  // Consume modifier stock and post the ledger legs in the same transaction as
  // the attendee and bookings, so the booking, its stock, and its sale/payment
  // legs are all-or-nothing. The usage amounts come from the same pricing pass
  // that calculated the checkout total, so scoped bases, quantities, and clamped
  // discounts match. A modifier that sold out during payment throws, rolling the
  // whole order back so the caller refunds rather than leaving orphaned legs.
  // The free checkout posts these very same facts (see bookingLedgerPoster); a
  // paid booking just keys the event on its payment session and dates it from
  // the provider's checkout time rather than now.
  const postLedger = bookingLedgerPoster(pricedOrder.modifierApplications, {
    eventId: () => session.id,
    occurredAt: businessTime(session),
    pricedOrder,
  });

  const result = await createOrSoldOut(
    {
      address: intent.address,
      bookings,
      email: intent.email,
      name: intent.name,
      paymentId: session.paymentReference,
      phone: intent.phone,
      remainingBalance,
      special_instructions: intent.special_instructions,
      statusId: await getPublicStatusId(),
    },
    postLedger,
  );
  if (result === "sold-out") {
    return refundAndFail(
      session,
      MODIFIER_SOLD_OUT_MESSAGE,
      validatedItems[0]!.listing.id,
      409,
    );
  }

  // All-or-nothing: a capacity failure rolled the transaction back (no legs),
  // so this only refunds; the partial-rollback branch never fires for the paid
  // path.
  const bookingCheck = await ensureAllBookings(
    result,
    bookings.length,
    "public",
  );
  if (!bookingCheck.ok) {
    const error = formatPostPaymentError(
      bookingCheck.reason,
      validatedItems[0]!.listing.name,
    );
    return refundAndFail(
      session,
      error,
      validatedItems[0]!.listing.id,
      bookingCheck.reason === "encryption_error" ? 500 : 409,
    );
  }
  const created = result as Extract<typeof result, { success: true }>;

  const entries = created.attendees.map((attendee, i) => ({
    attendee,
    listing: validatedItems[i]!.listing,
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
 * 2. Validate listings and create attendees atomically (with rollback on failure)
 * 3. Finalize session (records attendee ID)
 */
/** User-facing message when the outstanding balance changed mid-payment. */
const BALANCE_CHANGED_MESSAGE =
  "The outstanding balance for this booking changed while you were paying.";

/**
 * Settle a reserved attendee's balance instead of creating a new attendee.
 *
 * Reached only for a trusted session (the mismatch verdict refunds upstream), so
 * the proof has already bound `balance_attendee_id` and the single balance line,
 * and the charge equals the signed total. The amount this checkout was created
 * for is that line's price (`items[0].p`); the settle clears the balance only if
 * the live `remaining_balance` still equals it — so a balance the owner edited,
 * or one a concurrent/stale checkout already settled, can't be cleared for the
 * wrong figure — and finalizes the session in the SAME transaction so a crash
 * between settle and finalize can't leave a paid-but-unfinalized row (which a
 * later stale-replay would wrongly refund). A mismatch refunds and returns a
 * terminal failure rather than mutating anything.
 */
const settleBalanceSession = async (
  sessionId: string,
  session: ValidatedPaymentSession,
  intent: BookingIntent,
): Promise<PaymentResult> => {
  const attendeeId = intent.balanceAttendeeId as number;
  // A balance checkout is always a single synthetic line whose price is the
  // outstanding balance it was created to clear (proof-bound: see handleBalancePost).
  const expectedAmount = intent.items[0]!.p;
  const listingId = intent.items[0]!.e;

  // The balance payment is cash arriving for the order: world funds the
  // attendee, clearing what they owed (the sale was recognised at booking).
  //
  // Only post the leg once the original booking is already in the ledger. A
  // reservation created before booking dual-write has no sale/deposit legs, so a
  // lone payment leg would leave cash with no matching revenue (and a later
  // backfill from the columns would double-count it); those legacy orders are
  // reconstructed wholesale by the backfill instead. Take the currency from the
  // booking's own legs, not the (possibly since-changed) site currency, so the
  // batch can't append a mixed-currency leg.
  const bookingLegs = await transfersByAccount(attendeeAccount(attendeeId));
  const settleStatements = [
    balanceFinalizeStatement(sessionId, attendeeId, expectedAmount),
  ];
  if (bookingLegs.length > 0) {
    settleStatements.push(
      guardedInsertStatement(
        {
          amount: expectedAmount,
          destination: attendeeAccount(attendeeId),
          eventGroup: await eventGroup(["balance", sessionId]),
          kind: "payment",
          occurredAt: businessTime(session),
          reference: await legReference(["balance", sessionId, "payment"]),
          source: WORLD,
        },
        nowIso(),
        "(SELECT remaining_balance FROM attendees WHERE id = ?) = ?",
        [attendeeId, expectedAmount],
      ),
    );
  }

  const settled = await settleAttendeeBalance(
    attendeeId,
    expectedAmount,
    settleStatements,
  );
  if (!settled.settled) {
    return refundAndFail(
      session,
      BALANCE_CHANGED_MESSAGE,
      listingId,
      409,
      `Balance not settled (${settled.reason}) for attendee ${attendeeId}; paid ${session.amountTotal}`,
    );
  }

  // Settle + finalize already committed atomically above. The listing (which
  // may since be deleted) is resolved lazily by the redirect for its thank-you
  // link, so we carry only its id here.
  return {
    attendee: { id: attendeeId },
    listingId,
    success: true,
    ticketTokens: [],
  };
};

const logPromoCodeModifiers = async (
  specs: ModifierSpec[],
  applications: ModifierApplication[],
  listing: ListingWithCount,
  attendeeId: number,
): Promise<void> => {
  const byId = new Map(applications.map((a) => [a.modifierId, a]));
  for (const spec of specs) {
    const delta = byId.get(spec.id)!.delta;
    const effect =
      delta < 0 ? `${formatCurrency(-delta)} off` : `+${formatCurrency(delta)}`;
    await logActivity(
      `Promo code '${spec.name}' used: ${effect}`,
      listing,
      attendeeId,
    );
  }
};

/**
 * Process a session we have just reserved (holding the lock). Every failure
 * returned here is a handled terminal outcome; processPaymentSession records it
 * so a later redirect/webhook replays the same result instead of re-running
 * refunds or stalling behind the idempotency lock.
 */
const processReservedSession = async (
  sessionId: string,
  data: ValidatedSession,
  options?: { storeTokens?: boolean },
): Promise<PaymentResult> => {
  const { session, intent, verdict } = data;
  const signedListingId = intent.items[0]!.e;

  // The provider charged an amount other than our signed total — refund. Inside
  // the reservation so the refund is idempotent (a later delivery replays this
  // outcome, never re-refunds). Covers ticket and balance sessions uniformly.
  if (verdict.verdict === "mismatch") {
    return refuseMismatch(session, verdict.agreed, signedListingId);
  }

  // Balance payment: settle the existing attendee rather than create one.
  if (intent.balanceAttendeeId) {
    return settleBalanceSession(sessionId, session, intent);
  }

  // Phase 2: Validate listings and create attendees atomically
  const validated = await validateAllItems(session, intent);
  if ("success" in validated) {
    // validateAllItems leaves a 404 un-refunded (a foreign instance sharing the
    // provider would land there). This is a trusted session we signed, so a 404
    // is our own since-deleted listing — refund instead of stranding the paid
    // customer behind a bare "listing not found".
    if (validated.status === 404) {
      return priceMismatchRefund(
        session,
        `Listing not found for a signed session (session=${session.id})`,
        signedListingId,
      );
    }
    return validated;
  }
  const validatedItems = validated.items;

  // Resolve the applied modifiers once (re-fetched by id from the database);
  // both the price re-derivation and the stock consumption use the same specs.
  // Every trigger — automatic, code, opt-in add-on, and answer — rides the same
  // metadata refs and is re-fetched by id here, re-checking the visit gate and
  // re-deriving the amount so a tampered checkout can't dodge a surcharge.
  const visits = await buyerVisits(intent.email, intent.phone);
  const modifierSpecs = await specsFromRefs(intent.modifiers, { visits });
  const pricingIntent = checkoutIntentForSession(
    intent,
    validatedItems,
    modifierSpecs,
  );
  const pricedOrder = priceCheckout(pricingIntent);

  const pricingError = await verifyPaidPricing(
    session,
    intent,
    validatedItems,
    pricedOrder,
    verdict.agreed,
  );
  if (pricingError) return pricingError;

  const created = await createAttendeeForSession(
    session,
    intent,
    validatedItems,
    pricedOrder,
  );
  if ("success" in created) return created;
  const createdEntries = created.entries;

  await saveSessionAnswers(createdEntries, intent);

  const firstAttendee = createdEntries[0]!;
  const ticketToken = firstAttendee.attendee.ticket_token;

  await finalizeSession(
    sessionId,
    firstAttendee.attendee.id,
    options?.storeTokens === false ? [] : [ticketToken],
  );

  const codeSpecs = modifierSpecs.filter((s) => s.trigger === "code");
  if (codeSpecs.length > 0) {
    await logPromoCodeModifiers(
      codeSpecs,
      pricedOrder.modifierApplications,
      firstAttendee.listing,
      firstAttendee.attendee.id,
    );
  }

  await logAndNotifyRegistration(createdEntries, intent.siteTokenIndex);

  return {
    attendee: firstAttendee.attendee,
    listingId: firstAttendee.listing.id,
    success: true,
    ticketTokens: [ticketToken],
  };
};

const processPaymentSession = async (
  sessionId: string,
  data: ValidatedSession,
  options?: { storeTokens?: boolean },
): Promise<PaymentResult> => {
  // Phase 1: Reserve the session (claim the lock)
  const reservation = await reserveSession(sessionId);
  if (!reservation.reserved) {
    return handleReservationConflict(data.intent, reservation.existing);
  }

  const result = await processReservedSession(sessionId, data, options);

  // A refund of a real payment that FAILED must stay retryable, and the very
  // next provider redelivery should re-attempt it. Releasing the reservation
  // now (rather than leaving it held with no recorded outcome) is what makes
  // that happen: a held reservation would make the redelivery collide with the
  // lock and return 409 until the row goes stale (~5 min), gating refund
  // recovery on a local timer instead of provider redelivery. Releasing lets
  // the next delivery re-claim and re-refund immediately. This CANNOT
  // double-pay: every provider refunds the full charge amount and rejects a
  // refund that exceeds the already-refunded balance, and tryRefund treats an
  // already-refunded payment as success — so a redelivery after a refund that
  // actually went through (but reported failure) records success, not a second
  // payout.
  if (!result.success && result.refunded === false) {
    await releaseReservation(sessionId);
    return result;
  }

  // Otherwise record a handled failure as the session's terminal outcome so a
  // later redirect/webhook for the same paid session replays it (same message
  // and refund status) instead of re-refunding or stalling behind the lock. The
  // transient "another request is processing" conflict returns above and never
  // reaches here, so it stays retryable too.
  if (!result.success) {
    await markSessionFailed(sessionId, {
      error: result.error,
      refunded: result.refunded,
      status: result.status,
    });
  }

  return result;
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
    const listingId = validation.data.intent.items[0]?.e;
    logError({
      code: ErrorCode.PAYMENT_SESSION,
      detail: `[redirect] ${result.detail ?? result.error}`,
      listingId,
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
      `/payment/success?tokens=${encodeURIComponent(
        result.ticketTokens.join("+"),
      )}`,
    );
  }

  // Already-processed session (no tokens available) - render directly. Resolve
  // the listing lazily here (the only place a thank-you URL is needed) so the
  // webhook path never loads it; a since-deleted listing simply yields no URL.
  let thankYouUrl = "";
  if (validation.data.intent.items.length === 1) {
    const listing = await getListing(result.listingId);
    thankYouUrl = listing?.thank_you_url ?? "";
  }
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
  const listingIds: number[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const awb = attendeeResults[i];
    if (awb) {
      verifiedTokens.push(tokens[i]!);
      // Collect all listing IDs from all bookings
      for (const booking of awb.bookings) {
        listingIds.push(booking.listing_id);
      }
    }
  }

  if (verifiedTokens.length === 0) {
    return paymentErrorResponse("Invalid payment callback");
  }

  const ticketUrl = `/t/${verifiedTokens.join("+")}`;

  // Only use thank_you_url for single-listing purchases
  const uniqueListingIds = unique(listingIds);
  let thankYouUrl = "";
  if (uniqueListingIds.length === 1) {
    const listing = await getListing(uniqueListingIds[0]!);
    if (listing) thankYouUrl = listing.thank_you_url.trim();
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

  return cancelPageResponse(session, logCancelError);
});

/**
 * =============================================================================
 * Payment Webhook Endpoint
 * =============================================================================
 * Handles listings directly from payment providers with signature verification.
 */

/** JSON response acknowledging a webhook listing.
 * Always returns 200 so payment providers don't retry — we've already
 * handled the outcome (logged, refunded, etc.). Error details are in the body. */
const webhookAckResponse = (extra?: Record<string, unknown>): Response =>
  jsonResponse({ received: true, ...extra });

/**
 * Map a processed-payment result to the webhook's HTTP response.
 *  - success → 200 ack (processed).
 *  - another request holds the reservation (transient lock, no refund) → 409 so
 *    the provider retries.
 *  - a refund of a real payment failed → 503 (reservation left retryable) so the
 *    provider re-delivers and we re-attempt; guarded on a payment reference so a
 *    session with nothing to refund can't trigger a retry loop.
 *  - any other handled failure (refund issued, or nothing to retry) → 200 ack.
 */
const webhookResultResponse = (
  result: PaymentResult,
  session: ValidatedPaymentSession,
  payload: string,
  listingIdForLog: number | undefined,
): Response => {
  if (result.success) return webhookAckResponse({ processed: true });
  // Log once at the boundary — inner functions pass structured context via detail.
  logError({
    code: ErrorCode.PAYMENT_SESSION,
    detail: result.detail ?? result.error,
    listingId: listingIdForLog,
  });
  logDebug("Webhook", `Failed payload: ${payload}`);
  if (result.status === 409 && result.refunded === undefined) {
    return plainResponse(result.error, 409);
  }
  if (result.refunded === false && session.paymentReference) {
    return plainResponse(result.error, 503);
  }
  return webhookAckResponse({ error: result.error, processed: false });
};

/** Detect which provider sent the webhook based on request headers */
const getWebhookSignatureHeader = (request: Request): string | null =>
  request.headers.get("stripe-signature") ??
  request.headers.get("x-square-hmacsha256-signature") ??
  null;

/**
 * Authenticate an incoming webhook: resolve the provider, require the signature
 * header when the provider needs one, and verify signature/payload integrity.
 * Returns the verified listing + provider on success, or a Response to short-
 * circuit the request on failure.
 */
const authenticateWebhook = async (
  request: Request,
  payload: string,
  payloadBytes: Uint8Array,
): Promise<
  | Response
  | {
      provider: NonNullable<
        Awaited<ReturnType<typeof getActivePaymentProvider>>
      >;
      listing: WebhookEvent;
    }
> => {
  const provider = await getActivePaymentProvider();
  if (!provider) {
    logError({
      code: ErrorCode.PAYMENT_SESSION,
      detail: "Webhook received but payment provider not configured",
    });
    logDebug("Webhook", `Rejected payload: ${payload}`);
    return plainResponse("Payment provider not configured", 400);
  }

  const signature = getWebhookSignatureHeader(request) ?? "";
  if (provider.requiresWebhookSignature && !signature) {
    logError({
      code: ErrorCode.PAYMENT_SESSION,
      detail: "Webhook missing signature header",
    });
    logDebug("Webhook", `Rejected payload: ${payload}`);
    return plainResponse("Missing signature", 400);
  }

  // Use the public-facing domain for signature verification. Square signs the
  // webhook using the exact notification URL from the subscription, which is the
  // public https:// URL. Deriving from request.url fails behind CDNs that
  // terminate TLS (the edge runtime sees http:// instead of https://).
  const webhookUrl = `https://${getEffectiveDomain()}/payment/webhook`;
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

  return { listing: verification.listing, provider };
};

/**
 * Handle POST /payment/webhook (payment provider webhook endpoint)
 *
 * Receives listings directly from the payment provider with signature verification.
 * Primary handler for payment completion - more reliable than redirects.
 */
const handlePaymentWebhook = async (request: Request): Promise<Response> => {
  // Read raw body bytes FIRST, before any async work. The Bunny Edge runtime
  // can garbage-collect the underlying request body resource during awaits
  // (e.g. dynamic imports in getActivePaymentProvider), causing "BadResource:
  // Cannot read body as underlying resource unavailable" errors.
  const payloadBytes = new Uint8Array(await request.arrayBuffer());
  const payload = new TextDecoder().decode(payloadBytes);

  const auth = await authenticateWebhook(request, payload, payloadBytes);
  if (auth instanceof Response) return auth;
  const { provider, listing } = auth;

  // Only handle checkout completed listings
  if (listing.type !== provider.checkoutCompletedEventType) {
    // Acknowledge other listings without processing
    return webhookAckResponse();
  }

  // Delegate session extraction to the provider — each provider knows how to
  // resolve a session from its own webhook listing structure.
  const sessionResult = await provider.resolveWebhookSession(listing);

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

  // Verify payment is complete before classifying — an unpaid session may carry
  // a charge amount that would otherwise classify as trusted.
  if (session.paymentStatus !== "paid") {
    logError({
      code: ErrorCode.PAYMENT_SESSION,
      detail: `Webhook session not yet paid (session=${session.id}, status=${session.paymentStatus})`,
    });
    logDebug("Webhook", `Pending payload: ${payload}`);
    return webhookAckResponse({ status: "pending" });
  }

  // A valid price proof is the only signal that the session is ours: it cannot
  // be forged without our key, and our checkout always attaches one. Without it
  // we cannot prove ownership (a different application sharing the provider
  // account, or replayed/corrupt data), so we acknowledge without processing or
  // refunding — refunding an unverifiable session could refund another
  // instance's payment.
  const verdict = await classifySession(session);
  if (verdict.verdict === "ignore") {
    logDebug(
      "Webhook",
      `Ignoring webhook for unverifiable session (origin=${session.metadata._origin}): ${payload}`,
    );
    return webhookAckResponse();
  }

  // A valid proof means the metadata is byte-for-byte what we signed, so the
  // intent always parses — extractIntent only returns null on metadata we never
  // produced.
  const intent = extractIntent(session)!;
  const listingIdForLog = intent.items[0]?.e;
  const result = await processPaymentSession(session.id, {
    intent,
    session,
    verdict,
  });
  return webhookResultResponse(result, session, payload, listingIdForLog);
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
