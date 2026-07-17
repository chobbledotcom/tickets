/**
 * Turn a validated, correctly-priced session into a real attendee: create the
 * attendee plus its per-listing bookings atomically, finalize the payment
 * session in the same batch, and persist the answers the buyer gave. Every
 * failure here is structured so the caller can route the staged payment to its
 * durable refund path.
 */

import { map, requiredMapValue } from "#fp";
import { businessTime } from "#routes/api/payment-processing/metadata.ts";
import type { ValidatedItem } from "#routes/api/payment-processing/package-pricing.ts";
import { paidByItem } from "#routes/api/payment-processing/pricing.ts";
import type {
  BookingIntent,
  PaymentResult,
} from "#routes/api/webhook-types.ts";
import { lineGroupId } from "#shared/booking/signed-metadata.ts";
import { bookingsForOrder } from "#shared/booking-lines.ts";
import { capacityErrorFormatter } from "#shared/capacity-error.ts";
import { bookingBatchPlan } from "#shared/checkout-complete.ts";
import type {
  ModifierApplication,
  PricedOrder,
} from "#shared/checkout-pricing.ts";
import { formatCurrency } from "#shared/currency.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import { attendeesApi } from "#shared/db/attendees/api.ts";
import { contactFields } from "#shared/db/attendees/pii.ts";
import type { CheckoutStage } from "#shared/db/checkout-stages.ts";
import { DatabaseBusyError } from "#shared/db/client.ts";
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

/** The listing id and package path for a signed booking line. A package path
 * keeps one listing booked through two paths in two distinct slots. */
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

type CreatedAttendee = Extract<
  Awaited<ReturnType<typeof attendeesApi.createAttendeeAtomic>>,
  { success: true }
>["attendees"][number];

export type CreatedEntry = {
  attendee: CreatedAttendee;
  listing: ListingWithCount;
};

/**
 * The outcome of trying to honour a signed booking at the charged price: the
 * created entries, or a structured reason it couldn't be created. The caller
 * decides what to do: success finalizes a real ticket and failure enters the
 * staged refund path. createAttendeeForSession never refunds itself.
 */
export type HonourResult =
  | { ok: true }
  | { ok: null; error: unknown }
  | {
      ok: false;
      reason:
        | "sold_out"
        | "capacity_exceeded"
        | "encryption_error"
        | "stage_mismatch"
        | "unexpected_error";
      detail: string;
    };

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
 * payment session in the SAME batch (see batchFinalizeStatements) so attendee_id
 * is set iff the attendee row exists — closing the crash window between a
 * separate post-transaction finalize and the attendee INSERT. durationDays is
 * listing-scoped and re-read here so the stored range always matches the
 * listing's current duration policy. Returns a structured failure so the caller
 * can refund the staged booking.
 */
export const createAttendeeForSession = async (
  session: ValidatedPaymentSession,
  intent: BookingIntent,
  validatedItems: ValidatedItem[],
  pricingIntent: CheckoutIntent,
  pricedOrder: PricedOrder,
  stage: CheckoutStage,
): Promise<HonourResult> => {
  let prepared: {
    attendeeInput: Parameters<typeof attendeesApi.activateStagedAttendee>[1];
    plan: Parameters<typeof attendeesApi.activateStagedAttendee>[2];
  };
  try {
    // Per-LINE paid amounts: a listing booked through two paths is two lines
    // with their own prices, and each becomes its own booking row. The priced
    // order's lines reference the pricing intent's item objects, which pair
    // 1:1 by index with validatedItems.
    const paidByIntentItem = paidByItem(pricedOrder);
    const bookings = bookingsForOrder(
      intent,
      map(({ item, listing }: ValidatedItem, index) => {
        const pricePaid = requiredMapValue(
          paidByIntentItem,
          pricingIntent.items[index]!,
          `Paid amount for checkout item ${index} was not loaded`,
        );
        return {
          ...bookingSlot(item),
          listing,
          pricePaid,
          quantity: item.q,
        };
      })(validatedItems),
    );
    // Build every fallible input before starting the atomic write. A failure
    // here is known not to have committed, while a write failure below must be
    // checked against primary state before deciding whether to refund.
    const plan = await bookingBatchPlan(
      pricedOrder.modifierApplications,
      {
        eventId: session.id,
        occurredAt: businessTime(session),
        pricedOrder,
      },
      { paymentReference: session.paymentReference, sessionId: session.id },
    );
    prepared = {
      attendeeInput: {
        ...contactFields(intent),
        bookings,
        paymentId: session.paymentReference,
      },
      plan: { ...plan, finalize: plan.finalize! },
    };
  } catch (error) {
    return {
      detail: `Unexpected error preparing session ${session.id}: ${String(error)}`,
      ok: false,
      reason: "unexpected_error",
    };
  }
  let result: Awaited<ReturnType<typeof attendeesApi.activateStagedAttendee>>;
  try {
    result = await attendeesApi.activateStagedAttendee(
      stage,
      prepared.attendeeInput,
      prepared.plan,
    );
  } catch (error) {
    if (error instanceof DatabaseBusyError) throw error;
    return { error, ok: null };
  }
  if (!result.success) {
    return {
      detail:
        result.reason === "sold_out"
          ? "a chosen add-on or extra sold out during payment"
          : result.reason === "stage_mismatch"
            ? `Staged order did not match session ${session.id}`
            : formatPostPaymentError(
                result.reason,
                validatedItems[0]!.listing.name,
              ),
      ok: false,
      reason: result.reason,
    };
  }
  return { ok: true };
};
