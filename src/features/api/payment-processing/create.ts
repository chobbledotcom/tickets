/**
 * Turn a validated, correctly-priced session into a real attendee: create the
 * attendee plus its per-listing bookings atomically, finalize the payment
 * session in the same batch, and persist the answers the buyer gave. Every
 * failure here is *structured* (never a refund) so the caller can keep a
 * quantity-0 placeholder instead of dropping a paid customer.
 */

import { committedEntries } from "#routes/api/payment-processing/committed-entries.ts";
import { businessTime } from "#routes/api/payment-processing/metadata.ts";
import type { ValidatedItem } from "#routes/api/payment-processing/package-pricing.ts";
import {
  orderLineTotal,
  paidByItem,
} from "#routes/api/payment-processing/pricing.ts";
import type {
  BookingIntent,
  PaymentResult,
} from "#routes/api/webhook-types.ts";
import { lineGroupId } from "#shared/booking/signed-metadata.ts";
import { orderBookings } from "#shared/booking-lines.ts";
import { capacityErrorFormatter } from "#shared/capacity-error.ts";
import { bookingBatchPlan } from "#shared/checkout-complete.ts";
import type {
  ModifierApplication,
  PricedOrder,
} from "#shared/checkout-pricing.ts";
import { formatCurrency } from "#shared/currency.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import { getPublicStatusId } from "#shared/db/attendee-statuses.ts";
import { activateStagedBooking } from "#shared/db/attendees/activate.ts";
import type { ActivationFailure } from "#shared/db/attendees/activation-refusal.ts";
import {
  type createAttendeeAtomic,
  createBookingAtomic,
} from "#shared/db/attendees/api.ts";
import type { CheckoutStage } from "#shared/db/checkout-stages.ts";
import { recordOrderActivity } from "#shared/db/contact-tokens.ts";
import {
  decryptSessionTokens,
  type ProcessedPayment,
} from "#shared/db/processed-payments.ts";
import {
  groupListingAnswerSets,
  saveAttendeeAnswers,
} from "#shared/db/questions/attendee-answers/save.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import type {
  BookingItem,
  CheckoutIntent,
  ModifierSpec,
  TextAnswerRef,
  ValidatedPaymentSession,
} from "#shared/payments.ts";
import type { ListingWithCount } from "#shared/types.ts";

/** The listing id + package path shared by every booking row we build from a
 * signed line — a fresh booking, a quantity-0 placeholder, or a dateless ghost.
 * A line's package path keeps a listing booked through two paths in two distinct
 * slots. */
export const bookingSlot = (item: BookingItem) => ({
  listingId: item.e,
  packageGroupId: lineGroupId(item) ?? 0,
});

/** The one success shape every resolved payment session returns: the created or
 *  already-existing attendee (only its id is carried — see PaymentSuccess), the
 *  listing id the redirect resolves lazily, and any ticket tokens (a fresh
 *  booking carries its token; a replay/settle carries none). Centralised so the
 *  resolve paths — fresh booking, balance settle, processed-payments replay, and
 *  ledger replay — can't drift apart. */
export const sessionSuccess = (
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
export const alreadyProcessedResult = async (
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
 * Pair each created booking row with its listing **by listing id**, not by
 * position. `expandChildAllocations` can emit more rows than there are signed
 * items — a child chosen under two parents is one signed item but two per-parent
 * rows, plus any parent-less remainder — so a positional `validatedItems[i]`
 * pairing would mis-align or read past the end (and throw). Every created row's
 * listing is a signed item by construction, so the by-id lookup is total.
 * Mirrors the free path (`ticket-payment.ts`). Exported for direct unit testing
 * of the multi-parent count mismatch.
 */
export const pairEntriesByListing = <A extends { listing_id: number }>(
  attendees: readonly A[],
  validatedItems: readonly { listing: ListingWithCount }[],
): { attendee: A; listing: ListingWithCount }[] => {
  const listingByItemId = new Map(
    validatedItems.map((v) => [v.listing.id, v.listing]),
  );
  return attendees.map((attendee) => ({
    attendee,
    listing: listingByItemId.get(attendee.listing_id)!,
  }));
};

/** Format error for post-payment attendee creation failure */
const formatPostPaymentError = capacityErrorFormatter({
  fallback: "Registration failed.",
  generic: "Sorry, this listing sold out while you were completing payment.",
  withName: (name) =>
    `Sorry, ${name} sold out while you were completing payment.`,
});

/** The reason plus internal log line for each way a staged claim can fail. The
 * two stage problems name the session (the operator's reconciliation key); the
 * two stock problems reuse the shared sold-out wording. An exhaustive record,
 * so a new activation failure cannot silently fall through to the wrong story.
 * "stage_gone" is excluded by type: a deleted stage books fresh instead of
 * failing, so it can never be routed into a failure detail. */
const STAGED_FAILURE_DETAILS: Record<
  Exclude<ActivationFailure, "stage_gone">,
  (sessionId: string, listingName: string) => string
> = {
  capacity_exceeded: (_sessionId, listingName) =>
    formatPostPaymentError("capacity_exceeded", listingName),
  sold_out: (_sessionId, listingName) =>
    formatPostPaymentError("sold_out", listingName),
  stage_active: (sessionId) =>
    `Staged rows for session ${sessionId} were already given a quantity outside payment`,
  stage_mismatch: (sessionId) =>
    `Staged booking lines for session ${sessionId} no longer match the signed order`,
};

type CreatedAttendee = Extract<
  Awaited<ReturnType<typeof createAttendeeAtomic>>,
  { success: true }
>["attendees"][number];

export type CreatedEntry = {
  attendee: CreatedAttendee;
  listing: ListingWithCount;
};

/**
 * The outcome of trying to honour a signed booking at the charged price: the
 * created entries, or a structured reason it couldn't be created. The caller
 * decides what to do — a success finalizes a real ticket; any failure keeps a
 * quantity-0 placeholder and refunds. createAttendeeForSession never refunds
 * itself.
 */
export type HonourResult =
  | { ok: true; entries: CreatedEntry[] }
  | {
      ok: false;
      reason:
        | "sold_out"
        | "capacity_exceeded"
        | "encryption_error"
        | "stage_active"
        | "stage_mismatch";
      detail: string;
    };

/** Build the failure arm of a {@link HonourResult}: a classified reason plus the
 * operator-facing detail. Shared by every honour path that gives up after a
 * post-payment capacity, stock, or staging problem. */
const honourFailure = (
  reason: Extract<HonourResult, { ok: false }>["reason"],
  detail: string,
): HonourResult => ({ detail, ok: false, reason });

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

export const saveSessionAnswers = async (
  createdEntries: CreatedEntry[],
  intent: BookingIntent,
): Promise<void> => {
  if (!intent.listingAnswerIds && !intent.listingTextAnswerIds) return;
  const grouped = groupListingAnswerSets(
    createdEntries,
    intent.listingAnswerIds ?? {},
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

export const attendeeBaseFields = async (
  session: ValidatedPaymentSession,
  intent: BookingIntent,
) => ({
  address: intent.address,
  email: intent.email,
  name: intent.name,
  paymentId: session.paymentReference,
  phone: intent.phone,
  special_instructions: intent.special_instructions,
  statusId: await getPublicStatusId(),
});

export const logPromoCodeModifiers = async (
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
 * Create the attendee plus per-listing bookings atomically, finalizing the
 * payment session in the SAME batch (see batchFinalizeStatement) so attendee_id
 * is set iff the attendee row exists — closing the crash window between a
 * separate post-transaction finalize and the attendee INSERT. durationDays is
 * listing-scoped and re-read here so the stored range always matches the
 * listing's current duration policy. Returns a structured failure (never
 * refunds) so the caller can keep the booking as a placeholder instead.
 */
export const createAttendeeForSession = async (
  session: ValidatedPaymentSession,
  intent: BookingIntent,
  validatedItems: ValidatedItem[],
  pricingIntent: CheckoutIntent,
  pricedOrder: PricedOrder,
  ticketToken: string,
  stage: CheckoutStage | null,
): Promise<HonourResult> => {
  // Per-LINE paid amounts: a listing booked through two paths is two lines
  // with their own prices, and each becomes its own booking row. The priced
  // order's lines reference the pricing intent's item objects, which pair
  // 1:1 by index with validatedItems.
  const paidByIntentItem = paidByItem(pricedOrder);
  const bookings = orderBookings(
    validatedItems.map(({ item, listing }, index) => ({
      item,
      listing,
      pricePaid: paidByIntentItem.get(pricingIntent.items[index]!) ?? 0,
    })),
    intent,
  );
  const fullTotal = pricedOrder.fullSubtotal;
  const depositTotal = orderLineTotal(pricedOrder);
  const remainingBalance =
    intent.reservationAmount === undefined ? 0 : fullTotal - depositTotal;

  // Consume modifier stock, post the ledger legs, and finalize the session in
  // one atomic write with the attendee + booking rows, so the booking, its
  // stock, its sale/payment legs, and attendee_id are all-or-nothing in a single
  // write transaction. The usage amounts come
  // from the same pricing pass that calculated the checkout total, so scoped
  // bases, quantities, and clamped discounts match. A modifier that sold out
  // during payment stops the booking landing (→ "sold-out"). The event is keyed
  // on the payment session and dated from the provider's checkout time.
  const ledger = {
    eventId: session.id,
    occurredAt: businessTime(session),
    pricedOrder,
  };
  const finalize = {
    paymentReference: session.paymentReference,
    sessionId: session.id,
  };
  const attendeeInput = {
    ...(await attendeeBaseFields(session, intent)),
    bookings,
    remainingBalance,
    ticketToken,
  };

  /** Book a brand-new attendee from the signed order — the no-stage path, and
   * the fallback when a staged record was deleted mid-payment. Builds its own
   * plan: a fresh insert must never reference a staged attendee id. */
  const createFresh = async (): Promise<HonourResult> => {
    const plan = await bookingBatchPlan(
      null,
      pricedOrder.modifierApplications,
      ledger,
      finalize,
    );
    const result = await createBookingAtomic(attendeeInput, plan);
    if (result === "sold-out") {
      return honourFailure(
        "sold_out",
        "a chosen add-on or extra sold out during payment",
      );
    }

    // A capacity failure rolled the whole atomic transaction back, including legs.
    if (!result.success) {
      return honourFailure(
        result.reason,
        formatPostPaymentError(result.reason, validatedItems[0]!.listing.name),
      );
    }

    const entries = pairEntriesByListing(result.attendees, validatedItems);
    return { entries, ok: true };
  };

  if (stage) {
    const plan = await bookingBatchPlan(
      stage.attendeeId,
      pricedOrder.modifierApplications,
      ledger,
      finalize,
    );
    const activated = await activateStagedBooking(
      session.id,
      stage.attendeeId,
      ticketToken,
      attendeeInput,
      { ...plan, finalize },
    );
    if (!activated.success) {
      // The stage vanished between the caller's read and the claim: the
      // operator deleted the record mid-payment — the one sanctioned
      // mid-payment mutation, whose contract is that a late payment books
      // fresh from its signed order. Fall through to the fresh create rather
      // than refunding a bookable payment.
      if (activated.reason === "stage_gone") return createFresh();
      return honourFailure(
        activated.reason,
        STAGED_FAILURE_DETAILS[activated.reason](
          session.id,
          validatedItems[0]!.listing.name,
        ),
      );
    }
    await recordOrderActivity(
      intent.email,
      intent.phone,
      "public",
      ticketToken,
    );
    return {
      entries: await committedEntries(
        stage.attendeeId,
        ticketToken,
        session,
        intent,
        validatedItems,
      ),
      ok: true,
    };
  }

  return createFresh();
};
