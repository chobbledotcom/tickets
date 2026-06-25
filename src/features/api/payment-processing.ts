/**
 * Payment processing - the shared payment state machine.
 *
 * A payment session moves through a small, fixed lifecycle:
 *
 *   unreserved → reserved → (finalized success | terminal failure)
 *
 * via the steps: validate → reserve → process → record-outcome.
 *
 * 1. validate  — `validatePaidSession` confirms with the provider that the
 *    session is paid and `classifySession` proves (via a signed price proof)
 *    that the session is ours, yielding the `ValidatedSession` (intent, session,
 *    verdict) the rest of the machine runs on.
 * 2. reserve   — `processPaymentSession` claims the idempotency lock
 *    (`reserveSession`); a conflict replays the already-recorded outcome
 *    (`handleReservationConflict`) instead of re-processing.
 * 3. process   — `processReservedSession`, holding the lock, turns the signed
 *    session into either a real ticket (`createAttendeeForSession`) / a settled
 *    balance (`settleBalanceSession`), or — for ANY reason it can't be honoured
 *    (charge mismatch, a price edited mid-checkout, a sold-out extra, a full
 *    event, a since-deleted listing, or an unexpected error after the charge) —
 *    a quantity-0 placeholder that is refunded (`storeRefundedBooking`), so a
 *    paid customer is never dropped.
 * 4. record-outcome — `processPaymentSession` records a handled failure as the
 *    session's terminal outcome (`markSessionFailed`) so a later redirect/webhook
 *    replays the same result, or releases the reservation when a real refund
 *    failed so the next provider redelivery re-attempts it.
 *
 * The HTTP plumbing (redirect + webhook handlers, routing) lives in
 * `webhooks.ts` and calls into this module.
 */

import { sumOf } from "#fp";
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
import { htmlResponse, paymentErrorResponse } from "#routes/response.ts";
import { eventGroupHasLegs } from "#shared/accounting/queries.ts";
import { calculateBookingFee } from "#shared/booking-fee.ts";
import { bookingBatchPlan } from "#shared/checkout-complete.ts";
import {
  type ModifierApplication,
  type PricedOrder,
  priceCheckout,
} from "#shared/checkout-pricing.ts";
import { formatCurrency } from "#shared/currency.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import { getPublicStatusId } from "#shared/db/attendee-statuses.ts";
import {
  balanceEventGroup,
  settleAttendeeBalance,
} from "#shared/db/attendees/balance.ts";
import {
  createAttendeeAtomic,
  createBookingAtomic,
  ensureAllBookings,
} from "#shared/db/attendees.ts";
import { getListing, getListingWithCount } from "#shared/db/listings.ts";
import { buyerVisits, specsFromRefs } from "#shared/db/modifier-resolve.ts";
import {
  balanceFinalizeStatement,
  decryptSessionTokens,
  finalizeSessionIfUnresolved,
  markSessionFailed,
  type ProcessedPayment,
  parseSessionFailure,
  releaseReservation,
  reserveSession,
  setSessionTicketTokens,
} from "#shared/db/processed-payments.ts";
import {
  groupListingAnswers,
  saveAttendeeAnswers,
} from "#shared/db/questions.ts";
import { createSystemNote } from "#shared/db/system-notes.ts";
import {
  ErrorCode,
  type ErrorCodeType,
  logDebug,
  logError,
} from "#shared/logger.ts";
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
} from "#shared/payments.ts";
import { addPendingWork } from "#shared/pending-work.ts";
import { recordPlaceholderRefund } from "#shared/refund-ledger.ts";
import { bookingLedgerDisposition } from "#shared/session-ledger.ts";
import { dayPriceFor, type ListingWithCount } from "#shared/types.ts";
import { logAndNotifyRegistration } from "#shared/webhook.ts";
import { paymentCancelPage } from "#templates/payment.tsx";

/** User-facing message when the listing price changed between checkout and payment */
const PRICE_CHANGED_MESSAGE =
  "The price for this listing changed while you were completing payment.";

/**
 * User-facing message when a signed-by-us payment can't be honoured (price
 * changed, charge mismatch, sold out, or an unexpected error) so the booking is
 * kept and refunded. The refund clause is appended by formatPaymentError (or the
 * refund-pending suffix below), so this just covers "we saved your details".
 */
const BOOKING_SAVED_MESSAGE =
  "We couldn't complete your booking, so we've saved your details and a member of our team can help you rebook.";

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

/** Log a payment session error with redirect context prefix */
const logRedirectError = (detail: string): void =>
  logError({ code: ErrorCode.PAYMENT_SESSION, detail: `[redirect] ${detail}` });

/** Render the payment-cancelled page for a session's first listing. */
export const cancelPageResponse = async (
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

export const validatePaidSession = async (
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

/** The one success shape every resolved payment session returns: the created or
 *  already-existing attendee (only its id is carried — see PaymentSuccess), the
 *  listing id the redirect resolves lazily, and any ticket tokens (a fresh
 *  booking carries its token; a replay/settle carries none). Centralised so the
 *  resolve paths — fresh booking, balance settle, processed-payments replay, and
 *  ledger replay — can't drift apart. */
const sessionSuccess = (
  attendeeId: number,
  listingId: number,
  ticketTokens: string[] = [],
): PaymentResult => ({
  attendee: { id: attendeeId },
  listingId,
  success: true,
  ticketTokens,
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
  return sessionSuccess(
    existing.attendee_id,
    listingId,
    decrypted ? decrypted.split("+") : [],
  );
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
export const extractIntent = (
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

export const classifySession = async (
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
 * Why a signed-by-us payment must be refunded even though we can't just drop it.
 * `code` is a PII-free reason stamped into the ledger reversal and the system
 * note; `reason` is the operator-facing phrase for the note; `detail` is the
 * internal log line (ids/prices, never PII); `notify` optionally pages an alert.
 */
type RefundSpec = {
  code: string;
  reason: string;
  detail: string;
  notify?: ErrorCodeType;
};

const priceChangedSpec = (detail: string): RefundSpec => ({
  code: "price_changed",
  detail,
  reason: "the listing price changed while they were paying",
});

const chargeMismatchSpec = (
  session: ValidatedPaymentSession,
  agreed: number,
): RefundSpec => ({
  code: "charge_mismatch",
  detail: `Provider charged ${session.amountTotal} but signed total was ${agreed}`,
  notify: ErrorCode.WEBHOOK_PRICE_SIGNATURE,
  reason: "the amount charged did not match the agreed total",
});

const soldOutSpec = (detail: string): RefundSpec => ({
  code: "sold_out",
  detail,
  reason: "an add-on or extra they chose sold out while they were paying",
});

const capacitySpec = (detail: string): RefundSpec => ({
  code: "capacity_full",
  detail,
  reason: "the event filled up while they were paying",
});

/** A signed booking that threw an unexpected error after the charge — kept and
 *  refunded rather than crash-looping the webhook over a paid customer. */
const unexpectedErrorSpec = (detail: string): RefundSpec => ({
  code: "unexpected_error",
  detail,
  notify: ErrorCode.PAYMENT_SESSION,
  reason: "an unexpected error stopped the booking being completed",
});

/** A signed booking whose listing was deleted between checkout and payment:
 *  nothing left to honour, but we keep a quantity-0 ghost so the customer (and
 *  their refund) is never lost. */
const deletedListingSpec = (session: ValidatedPaymentSession): RefundSpec => ({
  code: "listing_removed",
  detail: `Listing not found for a signed session (session=${session.id})`,
  notify: ErrorCode.PAYMENT_SESSION,
  reason: "the listing was removed while they were paying",
});

/**
 * The pricing refund reason for a trusted session, or null when its prices still
 * match — computed WITHOUT refunding, so the booking is stored first and the
 * refund happens together with the ledger reversal and note.
 *
 * `agreed` is the signed total. The proof already pins every pricing input
 * (items, modifier refs, answer ids, reservation snapshot) and the charge equals
 * `agreed`, so the only thing that can still differ is the *current* database
 * price — a listing/modifier/answer price edited between checkout and now. Both
 * checks catch that legitimate mid-checkout price change. Pricing-code divergence
 * on identical inputs is caught at dev time by the property-based consistency
 * test, so this path refunds without paging.
 */
const paidPricingRefund = (
  intent: BookingIntent,
  validatedItems: ValidatedItem[],
  pricedOrder: PricedOrder,
  agreed: number,
): RefundSpec | null => {
  const hasPaidItems = intent.items.some((item) => item.p > 0);
  // Per-item prices are ticket-only (no fee), so validate without booking fee
  if (hasPaidItems) {
    for (const { item, listing, expectedPrice } of validatedItems) {
      if (hasPriceMismatch(item.p, expectedPrice, listing, 0, item.q)) {
        return priceChangedSpec(
          `Per-item price mismatch for listing ${listing.id}: metadata p=${item.p} but expected ${expectedPrice} (can_pay_more=${listing.can_pay_more})`,
        );
      }
    }
  }
  if (pricedOrder.total !== agreed) {
    return priceChangedSpec(
      `Re-derived total ${pricedOrder.total} differs from signed total ${agreed}`,
    );
  }
  return null;
};

/**
 * The PII-free system note for a stored-but-refunded booking. Explains in plain
 * language what happened, carries the provider's payment reference and our reason
 * code so the charge/refund can be reconciled in the provider dashboard, and
 * links the operator to the attendee's ledger statement. No names or emails.
 */
const refundedNoteText = (
  attendeeId: number,
  spec: RefundSpec,
  refunded: boolean,
  paymentReference: string,
): string => {
  const ledger = `[ledger](/admin/ledger/attendee/${attendeeId})`;
  // PII-free: the provider's payment reference lets the operator reconcile the
  // charge/refund in the provider dashboard; the reason code names why.
  const ref = ` Payment reference: ${paymentReference} (code: ${spec.code}).`;
  return refunded
    ? `This booking was kept at quantity 0 but its payment was refunded because ${spec.reason}.${ref} Please check the ${ledger}.`
    : `This booking was kept at quantity 0 but its payment could NOT be refunded automatically because ${spec.reason}.${ref} Please refund it manually and check the ${ledger}.`;
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
 * The outcome of trying to honour a signed booking at the charged price: the
 * created entries, or a structured reason it couldn't be created. The caller
 * decides what to do — a success finalizes a real ticket; any failure keeps a
 * quantity-0 placeholder and refunds. createAttendeeForSession never refunds
 * itself.
 */
type HonourResult =
  | { ok: true; entries: CreatedEntry[] }
  | {
      ok: false;
      reason: "sold_out" | "capacity_exceeded" | "encryption_error";
      detail: string;
    };

/**
 * Create the attendee plus per-listing bookings atomically, finalizing the
 * payment session in the SAME batch (see batchFinalizeStatement) so attendee_id
 * is set iff the attendee row exists — closing the crash window between a
 * separate post-transaction finalize and the attendee INSERT. durationDays is
 * listing-scoped and re-read here so the stored range always matches the
 * listing's current duration policy. Returns a structured failure (never
 * refunds) so the caller can keep the booking as a placeholder instead.
 */
const createAttendeeForSession = async (
  session: ValidatedPaymentSession,
  intent: BookingIntent,
  validatedItems: ValidatedItem[],
  pricedOrder: PricedOrder,
): Promise<HonourResult> => {
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

  // Consume modifier stock, post the ledger legs, and finalize the session in
  // ONE libsql batch with the attendee + booking INSERTs, so the booking, its
  // stock, its sale/payment legs, and attendee_id are all-or-nothing in a single
  // round-trip — never an interactive write transaction held open against the
  // primary (which timed out under edge→primary latency). The usage amounts come
  // from the same pricing pass that calculated the checkout total, so scoped
  // bases, quantities, and clamped discounts match. A modifier that sold out
  // during payment stops the booking landing (→ "sold-out"). The event is keyed
  // on the payment session and dated from the provider's checkout time.
  const plan = await bookingBatchPlan(
    pricedOrder.modifierApplications,
    {
      eventId: session.id,
      occurredAt: businessTime(session),
      pricedOrder,
    },
    session.id,
  );

  const result = await createBookingAtomic(
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
    plan,
  );
  if (result === "sold-out") {
    return {
      detail: "a chosen add-on or extra sold out during payment",
      ok: false,
      reason: "sold_out",
    };
  }

  // All-or-nothing: a capacity failure rolled the transaction back (no legs).
  const bookingCheck = await ensureAllBookings(
    result,
    bookings.length,
    "public",
  );
  if (!bookingCheck.ok) {
    return {
      detail: formatPostPaymentError(
        bookingCheck.reason,
        validatedItems[0]!.listing.name,
      ),
      ok: false,
      reason: bookingCheck.reason,
    };
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

  // settleAttendeeBalance posts the balance payment itself (world funds the
  // attendee, zeroing what they owed) guarded on the ledger balance, keyed to
  // this session so a webhook retry is a no-op. We only finalize the payment
  // session here, atomically with the settle.
  const settled = await settleAttendeeBalance(
    attendeeId,
    expectedAmount,
    { id: sessionId, occurredAt: businessTime(session) },
    [balanceFinalizeStatement(sessionId, attendeeId, expectedAmount)],
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
  return sessionSuccess(attendeeId, listingId);
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

/** The quantity-0, money-free booking lines for a stored-but-refunded placeholder
 *  — one per validated item, carrying the listing's current date range so the
 *  ghost still sits on the right day. */
const placeholderBookings = (
  validatedItems: ValidatedItem[],
  intent: BookingIntent,
) =>
  validatedItems.map(({ item, listing }) => ({
    listingId: item.e,
    pricePaid: 0,
    quantity: 0,
    ...bookingDateFields(listing, intent.date, intent.dayCount),
  }));

type PlaceholderBookings = Parameters<
  typeof createAttendeeAtomic
>[0]["bookings"];

/**
 * Keep a signed-by-us booking we can't honour rather than dropping it into limbo:
 * store it as a quantity-0 placeholder (overbook-tolerant, so capacity — or a
 * since-deleted listing — can never downgrade the store into a drop), refund the
 * payment, record the cash round-trip in the ledger (a `payment` + `refund_cash`
 * with NO `sale` leg, so the placeholder recognises no revenue and its projected
 * price_paid stays 0), and flag the attendee with a plain-language system note
 * carrying the reason and the provider's payment reference. The customer is told
 * their details were saved and the payment refunded; no ticket is issued.
 *
 * We never report `refunded: false`. The booking now exists, so a retry must NOT
 * re-create it — an un-refunded payment is recorded as a terminal, operator-
 * resolved outcome (the note's manual-refund instruction stands) rather than
 * released for re-processing.
 */
const storeRefundedBooking = async (
  session: ValidatedPaymentSession,
  intent: BookingIntent,
  bookings: PlaceholderBookings,
  spec: RefundSpec,
): Promise<PaymentFailureResult> => {
  if (spec.notify) addPendingWork(sendNtfyError(spec.notify));
  const listingId = bookings[0]!.listingId;
  // A quantity-0 overbook insert has no capacity gate and consumes no modifier
  // stock, so it always writes the row — trust it. (If the PII can't encrypt the
  // whole system is broken; we don't defend against that.)
  const stored = await createAttendeeAtomic({
    address: intent.address,
    allowOverbook: true,
    bookings,
    email: intent.email,
    name: intent.name,
    paymentId: session.paymentReference,
    phone: intent.phone,
    special_instructions: intent.special_instructions,
    statusId: await getPublicStatusId(),
  });
  const attendeeId = (stored as Extract<typeof stored, { success: true }>)
    .attendees[0]!.id;
  const refunded = await tryRefund(session.paymentReference, listingId);
  await recordPlaceholderRefund(
    {
      amount: session.amountTotal,
      attendeeId,
      eventId: session.id,
      listingId,
      occurredAt: businessTime(session),
    },
    spec.code,
    refunded,
  );
  if (refunded) {
    await logActivity(
      `Automatic refund (${spec.code}); booking kept at quantity 0`,
      listingId,
      attendeeId,
    );
  } else {
    logError({
      code: ErrorCode.PAYMENT_REFUND,
      detail: `Stored-but-unrefunded booking ${attendeeId} (${spec.code}): ${spec.detail}`,
      listingId,
    });
  }
  await createSystemNote(
    attendeeId,
    refundedNoteText(attendeeId, spec, refunded, session.paymentReference),
  );
  // Status 200: a fully-handled terminal outcome (booking kept, money returned or
  // flagged). The webhook acks it (never the 409 transient-lock retry nor a 503
  // refund retry — the booking exists, so a retry can't re-create it), and the
  // customer sees an informational "saved your details" message.
  return {
    detail: spec.detail,
    error: refunded
      ? BOOKING_SAVED_MESSAGE
      : `${BOOKING_SAVED_MESSAGE} Your refund is being arranged — please contact us if it does not arrive.`,
    refunded: refunded ? true : undefined,
    status: 200,
    success: false,
  };
};

/** The placeholder refund reason for a booking we tried but couldn't honour: a
 *  sold-out extra reads differently from a full event, and anything else
 *  (capacity, or the broken-system encryption_error we don't special-case) is
 *  treated as "the event filled up". */
const specForFailure = (
  failure: Extract<HonourResult, { ok: false }>,
): RefundSpec =>
  failure.reason === "sold_out"
    ? soldOutSpec(failure.detail)
    : capacitySpec(failure.detail);

/**
 * Replay a payment session the ledger already records as resolved to
 * `attendeeId`: heal the fresh reservation at that attendee — token-safely, so a
 * racing delivery's finalized tokens survive (see {@link
 * finalizeSessionIfUnresolved}) — and return success. NEVER refunds: the money is
 * already in the ledger against this attendee. Tokens come back empty, so the
 * redirect renders directly from the attendee. Shared by the booking-replay and
 * balance-replay preflights.
 */
const replaySuccess = async (
  sessionId: string,
  attendeeId: number,
  listingId: number,
): Promise<PaymentResult> => {
  await finalizeSessionIfUnresolved(sessionId, attendeeId);
  logDebug("Payment", `Replayed already-ledgered session ${sessionId}`);
  return sessionSuccess(attendeeId, listingId);
};

/**
 * Acknowledge a session the ledger already accounts for but whose booking is
 * gone — an operator deleted the attendee (its sale/payment legs remain) or it
 * was a refunded quantity-0 placeholder. The money is already recorded, so we
 * neither refund again nor recreate the booking: return a terminal handled
 * outcome (200 — the webhook acks it, the redirect shows it as processed) and
 * leave the orphaned ledger rows for the operator to reconcile.
 */
const alreadyHandledSession = (
  sessionId: string,
  listingId: number,
): PaymentFailureResult => ({
  detail: `Ledger already records session ${sessionId} with no live booking (listing ${listingId})`,
  error: "This payment has already been processed.",
  status: 200,
  success: false,
});

/**
 * The booking-session ledger preflight: the durable ledger — not the prunable
 * processed_payments row — is the source of truth for "already honoured", so
 * before validating, pricing, or refunding, resolve what it already records.
 * Returns the replay outcome for a session it has seen (a live booking replays as
 * success; an orphaned one is acknowledged), or null for a session it has never
 * recorded (process it fresh). The single guard that stops a late replay — after
 * the idempotency row is pruned or lost to a stale-reservation cleanup — from
 * refunding a live ticket via the deleted-listing, price-change, inactive-listing,
 * or capacity refund paths below.
 */
const replaySessionFromLedger = async (
  sessionId: string,
  listingId: number,
): Promise<PaymentResult | null> => {
  const disposition = await bookingLedgerDisposition(sessionId);
  switch (disposition.status) {
    case "unrecorded":
      return null;
    case "booked":
      return replaySuccess(sessionId, disposition.attendeeId, listingId);
    case "orphaned":
      return alreadyHandledSession(sessionId, listingId);
  }
};

/**
 * The balance-settlement counterpart of {@link replaySessionFromLedger}: replay a
 * balance session whose payment leg the ledger already records (its idempotency
 * row was pruned or lost), or null to settle it fresh. The attendee is known from
 * the proof-bound intent, so — unlike the booking path — there is no orphaned
 * case to resolve.
 */
const replayBalanceFromLedger = async (
  sessionId: string,
  attendeeId: number,
  listingId: number,
): Promise<PaymentResult | null> =>
  (await eventGroupHasLegs(await balanceEventGroup(sessionId)))
    ? replaySuccess(sessionId, attendeeId, listingId)
    : null;

/**
 * Process a session we have just reserved (holding the lock). A signed session
 * either becomes a real ticket or — for ANY reason we can't honour it (charge
 * mismatch, a price edited mid-checkout, a sold-out extra, a full event, a
 * since-deleted listing, or an unexpected error after the charge) — is kept as a
 * quantity-0 placeholder and refunded, so a paid customer is never dropped. Every
 * failure returned here is a handled terminal outcome; processPaymentSession
 * records it so a later redirect/webhook replays the same result instead of
 * re-running refunds or stalling behind the idempotency lock.
 */
const processReservedSession = async (
  sessionId: string,
  data: ValidatedSession,
  options?: { storeTokens?: boolean },
): Promise<PaymentResult> => {
  const { session, intent, verdict } = data;
  const signedListingId = intent.items[0]!.e;

  // Balance payment: settle the existing attendee rather than create one. A
  // mismatch can't be "stored" (the attendee already exists), so it refunds-and-
  // fails as before, idempotently inside the reservation.
  if (intent.balanceAttendeeId) {
    // Preflight: a balance session whose payment leg is already in the ledger is
    // a replay (its idempotency row was pruned or lost). Replay success rather
    // than re-settling — settleAttendeeBalance would find nothing owed and refund
    // a balance that's already paid.
    const replay = await replayBalanceFromLedger(
      sessionId,
      intent.balanceAttendeeId,
      signedListingId,
    );
    if (replay) return replay;
    if (verdict.verdict === "mismatch") {
      return refuseMismatch(session, verdict.agreed, signedListingId);
    }
    return settleBalanceSession(sessionId, session, intent);
  }

  // Preflight: the durable ledger is the source of truth for "already honoured".
  // Replay a session the ledger already records BEFORE any validation, pricing,
  // or refund path runs below — so a late delivery (after the prunable idempotency
  // row is gone) never refunds a live ticket via the deleted-listing, price-change,
  // inactive-listing, or capacity paths, nor double-books it.
  const replay = await replaySessionFromLedger(sessionId, signedListingId);
  if (replay) return replay;

  // Phase 2: Validate listings.
  const validated = await validateAllItems(session, intent);
  if ("success" in validated) {
    // A trusted session (we signed it) whose listing was deleted between checkout
    // and payment. listing_attendees has no FK to listings, so we still keep a
    // quantity-0 ghost against its id — preserving the customer and their refund
    // — rather than stranding them behind a bare "listing not found". A foreign
    // instance's 404 (signed by someone else) never reaches here.
    if (validated.status === 404) {
      return storeRefundedBooking(
        session,
        intent,
        [{ listingId: signedListingId, pricePaid: 0, quantity: 0 }],
        deletedListingSpec(session),
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
  const placeholders = placeholderBookings(validatedItems, intent);

  // A signed-by-us payment we already know we can't honour at the charged amount
  // — the provider charged a different total, or a listing/modifier/answer price
  // was edited between checkout and now: keep it as a quantity-0 placeholder and
  // refund, never drop it.
  const knownRefund: RefundSpec | null =
    verdict.verdict === "mismatch"
      ? chargeMismatchSpec(session, verdict.agreed)
      : paidPricingRefund(intent, validatedItems, pricedOrder, verdict.agreed);
  if (knownRefund) {
    return storeRefundedBooking(session, intent, placeholders, knownRefund);
  }

  // Otherwise try to honour it at the charged price. ANY failure keeps the
  // booking at quantity 0 and refunds rather than dropping a paid customer: a
  // structured sold-out/capacity/encryption result, OR an unexpected throw after
  // the charge (which would otherwise crash-loop the webhook over paid money).
  let honoured: HonourResult;
  try {
    honoured = await createAttendeeForSession(
      session,
      intent,
      validatedItems,
      pricedOrder,
    );
  } catch (error) {
    return storeRefundedBooking(
      session,
      intent,
      placeholders,
      unexpectedErrorSpec(
        `Unexpected error completing session ${session.id}: ${String(error)}`,
      ),
    );
  }
  if (!honoured.ok) {
    return storeRefundedBooking(
      session,
      intent,
      placeholders,
      specForFailure(honoured),
    );
  }

  // Success: a real ticket, finalized atomically in the creation transaction.
  const createdEntries = honoured.entries;
  await saveSessionAnswers(createdEntries, intent);
  const firstAttendee = createdEntries[0]!;
  const ticketToken = firstAttendee.attendee.ticket_token;

  // Persist the ticket token for webhook replay when the caller needs it.
  if (options?.storeTokens !== false) {
    await setSessionTicketTokens(sessionId, [ticketToken]);
  }

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

  return sessionSuccess(firstAttendee.attendee.id, firstAttendee.listing.id, [
    ticketToken,
  ]);
};

export const processPaymentSession = async (
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
export const formatPaymentError = (result: PaymentFailureResult): string => {
  if (result.refunded === true) {
    return `${result.error} Your payment has been automatically refunded.`;
  }
  if (result.refunded === false) {
    return `${result.error} Please contact support for a refund.`;
  }
  return result.error;
};
