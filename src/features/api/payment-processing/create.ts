/**
 * Turn a validated, correctly-priced session into a real attendee: create the
 * attendee plus its per-listing bookings atomically, finalize the payment
 * session in the same batch, and persist the answers the buyer gave. Every
 * failure here is *structured* (never a refund) so the caller can keep a
 * quantity-0 placeholder instead of dropping a paid customer.
 */

import * as v from "valibot";
/* jscpd:ignore-start */
import { lineGroupId } from "#booking/signed-metadata.ts";
import type { ActivityToLog } from "#db/activity-log.ts";
import { attendeesApi } from "#db/attendees/api.ts";
import {
  decryptSessionTokens,
  type ProcessedPayment,
} from "#db/processed-payments.ts";
import {
  groupListingAnswerSets,
  saveAttendeeAnswers,
} from "#db/questions/attendee-answers/save.ts";
import { requiredMapValue } from "#fp";
import { paymentReferenceOf } from "#payment/validated-session.ts";
import { businessTime } from "#routes/api/payment-processing/metadata.ts";
import type { ValidatedItem } from "#routes/api/payment-processing/package-pricing.ts";
import {
  orderLineTotal,
  paidByItem,
} from "#routes/api/payment-processing/pricing.ts";
import type { PaymentResult } from "#routes/api/webhook-types.ts";
/* jscpd:ignore-end */
import { refusedOrderItem } from "#shared/attendee-failures.ts";
import {
  type BookingIntent,
  type BookingItem,
  type StoredTextAnswerRef,
  StoredTextAnswerRefSchema,
  type TextAnswerRef,
} from "#shared/booking-intent.ts";
import {
  bookingsForOrder,
  checkoutBookingLines,
} from "#shared/booking-lines.ts";
import { bookingBatchPlan } from "#shared/checkout-complete.ts";
import type {
  ModifierApplication,
  PricedOrder,
} from "#shared/checkout-pricing.ts";
import { formatCurrency } from "#shared/currency.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import type {
  CheckoutIntent,
  ModifierSpec,
  ValidatedPaymentSession,
} from "#shared/payments.ts";
import type { ListingWithCount } from "#types";

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
    listing: requiredMapValue(
      listingByItemId,
      attendee.listing_id,
      `Listing ${attendee.listing_id} was not loaded for a created booking`,
    ),
  }));
};

/** Format a capacity failure without assuming the listing has a display name. */
const formatPostPaymentError = (name: string): string =>
  name
    ? `Sorry, ${name} sold out while you were completing payment.`
    : "Sorry, this listing sold out while you were completing payment.";

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
 * decides what to do — a success finalizes a real ticket; any failure keeps a
 * quantity-0 placeholder and refunds. createAttendeeForSession never refunds
 * itself.
 */
export type HonourResult =
  | { ok: true; entries: CreatedEntry[] }
  | { ok: null; error: unknown }
  | {
      ok: false;
      reason: "sold_out" | "capacity_exceeded" | "unexpected_error";
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
 *
 * The check is the schema rather than a plain "is it there", because the refs
 * come from metadata that was parsed but never validated: an id that is null, a
 * word, or half a number would otherwise be written as a real answer.
 */
const textRefsWithStringId = (
  refs: TextAnswerRef[],
  listingId: number,
): StoredTextAnswerRef[] => {
  const resolved: StoredTextAnswerRef[] = [];
  for (const ref of refs) {
    if (v.is(StoredTextAnswerRefSchema, ref)) {
      resolved.push(ref);
    } else {
      logError({
        code: ErrorCode.DATA_INVALID,
        detail: `Text answer ref has no usable string id (question ${ref.q})`,
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

/** The identity fields every stored attendee starts from: who the buyer said
 * they are, the payment that proves it, and the status the row begins in. */
export type AttendeeBaseFields = Pick<
  BookingIntent,
  "address" | "email" | "name" | "phone" | "special_instructions"
> & {
  paymentId: string;
  statusId: number;
};

export const attendeeBaseFields = (
  paymentId: string,
  intent: BookingIntent,
  publicStatusId: number,
): AttendeeBaseFields => ({
  address: intent.address,
  email: intent.email,
  name: intent.name,
  paymentId,
  phone: intent.phone,
  special_instructions: intent.special_instructions,
  statusId: publicStatusId,
});

export const promoCodeActivities = (
  specs: ModifierSpec[],
  applications: ModifierApplication[],
  listing: ListingWithCount,
  attendeeId: number,
): ActivityToLog[] => {
  const byId = new Map(applications.map((a) => [a.modifierId, a]));
  return specs.map((spec) => {
    const delta = requiredMapValue(
      byId,
      spec.id,
      `Modifier application ${spec.id} was not loaded for promo code activity`,
    ).delta;
    const effect =
      delta < 0 ? `${formatCurrency(-delta)} off` : `+${formatCurrency(delta)}`;
    return {
      attendeeId,
      listing,
      message: `Promo code '${spec.name}' used: ${effect}`,
    };
  });
};

/**
 * Create the attendee plus per-listing bookings atomically, finalizing the
 * payment session in the SAME batch (see batchFinalizeStatements) so attendee_id
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
  publicStatusId: number,
  parentIdsByChild: ReadonlyMap<number, readonly number[]>,
): Promise<HonourResult> => {
  let prepared: {
    attendeeInput: Parameters<typeof attendeesApi.createBookingAtomic>[0];
    plan: Parameters<typeof attendeesApi.createBookingAtomic>[1];
  };
  try {
    // Per-line paid amounts are keyed by checkout item object, so one listing
    // booked through two paths keeps each path's own price and package.
    const paidByIntentItem = paidByItem(pricedOrder);
    const listingById = new Map(
      validatedItems.map(({ listing }) => [listing.id, listing]),
    );
    const bookings = bookingsForOrder(
      {
        allocations: intent.allocations,
        date: intent.date,
        dayCount: intent.dayCount,
      },
      checkoutBookingLines(pricingIntent.items, listingById, paidByIntentItem),
    );
    const remainingBalance =
      intent.reservationAmount === undefined
        ? 0
        : pricedOrder.fullSubtotal - orderLineTotal(pricedOrder);

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
      {
        paymentReference: paymentReferenceOf(session),
        sessionId: session.id,
      },
    );
    prepared = {
      attendeeInput: {
        ...attendeeBaseFields(session.paymentReference, intent, publicStatusId),
        bookings,
        parentIdsByChild,
        remainingBalance,
        ticketToken,
      },
      plan,
    };
  } catch (error) {
    return {
      detail: `Unexpected error preparing session ${session.id}: ${String(
        error,
      )}`,
      ok: false,
      reason: "unexpected_error",
    };
  }
  let result: Awaited<ReturnType<typeof attendeesApi.createBookingAtomic>>;
  try {
    result = await attendeesApi.createBookingAtomic(
      prepared.attendeeInput,
      prepared.plan,
    );
  } catch (error) {
    return { error, ok: null };
  }
  if (result === "sold-out") {
    return {
      detail: "a chosen add-on or extra sold out during payment",
      ok: false,
      reason: "sold_out",
    };
  }

  // All-or-nothing: a capacity failure rolled the transaction back (no legs).
  if (!result.success) {
    // A package order must never name a member in the capacity error — a hidden
    // package would leak the listing it conceals. Same guard as the free path.
    // A non-package order names the first validated item whose listing the
    // refusal says is out of room, else its first item.
    const errorName = pricingIntent.items.some(
      (item) => item.packageGroupId !== undefined,
    )
      ? ""
      : refusedOrderItem(
          validatedItems,
          (item) => item.listing.id,
          result.listingIds,
        ).listing.name;
    return {
      detail: formatPostPaymentError(errorName),
      ok: false,
      reason: result.reason,
    };
  }
  const entries = pairEntriesByListing(result.attendees, validatedItems);
  return { entries, ok: true };
};
