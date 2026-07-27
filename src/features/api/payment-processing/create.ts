/**
 * Turn a validated, correctly-priced session into a real attendee: create the
 * attendee plus its per-listing bookings atomically, finalize the payment
 * session in the same batch, and persist the answers the buyer gave. Every
 * failure here is *structured* (never a refund) so the caller can keep a
 * quantity-0 placeholder instead of dropping a paid customer.
 */

/* jscpd:ignore-start -- imports */
import { requiredMapValue } from "#fp";
import { ticketPaymentFulfilmentStatements } from "#routes/api/payment-processing/fence.ts";
import { businessTime } from "#routes/api/payment-processing/metadata.ts";
import type { ValidatedItem } from "#routes/api/payment-processing/package-pricing.ts";
import {
  orderLineTotal,
  paidByItem,
} from "#routes/api/payment-processing/pricing.ts";
import type {
  BookingIntent,
  PaymentResult,
  PaymentWork,
} from "#routes/api/webhook-types.ts";
import { lineGroupId } from "#shared/booking/signed-metadata.ts";
import {
  bookingsForOrder,
  checkoutBookingLines,
} from "#shared/booking-lines.ts";
import { bookingBatchPlan } from "#shared/checkout-complete.ts";
import type { PricedOrder } from "#shared/checkout-pricing.ts";
import { requirePublicStatusId } from "#shared/db/attendee-statuses.ts";
import { attendeesApi } from "#shared/db/attendees/api.ts";
import type { TxScope } from "#shared/db/client.ts";
import {
  groupListingAnswerSets,
  saveAttendeeAnswers,
} from "#shared/db/questions/attendee-answers/save.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import type { PaymentCompletion } from "#shared/payment-completion.ts";
import type {
  BookingItem,
  CheckoutIntent,
  StoredTextAnswerRef,
  TextAnswerRef,
} from "#shared/payments.ts";
import type { ListingWithCount } from "#shared/types.ts";
/* jscpd:ignore-end */

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
 *  resolve paths for fresh bookings and balance settlements can't drift apart. */
export const sessionSuccess = (
  attendeeId: number,
  listingId: number,
  ticketTokens: string[] = [],
): Extract<PaymentResult, { success: true }> => ({
  attendee: { id: attendeeId },
  listingId,
  success: true,
  ticketTokens,
});

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
 */
const textRefsWithStringId = (
  refs: TextAnswerRef[],
  listingId: number,
): StoredTextAnswerRef[] => {
  const resolved: StoredTextAnswerRef[] = [];
  for (const ref of refs) {
    if (ref.s !== undefined) {
      resolved.push({ ...ref, s: ref.s });
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
  transaction?: TxScope,
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
  await saveAttendeeAnswers(grouped, transaction);
};

export const attendeeBaseFields = async (intent: BookingIntent) => ({
  address: intent.address,
  email: intent.email,
  name: intent.name,
  paymentId: "",
  phone: intent.phone,
  special_instructions: intent.special_instructions,
  statusId: await requirePublicStatusId(),
});

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
  work: PaymentWork,
  intent: BookingIntent,
  validatedItems: ValidatedItem[],
  pricingIntent: CheckoutIntent,
  pricedOrder: PricedOrder,
  ticketToken: string,
  completion: PaymentCompletion,
): Promise<HonourResult> => {
  const { session } = work;
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
    const finalize = await ticketPaymentFulfilmentStatements(
      work,
      ticketToken,
      [ticketToken],
      completion,
    );
    const plan = await bookingBatchPlan(
      pricedOrder.modifierApplications,
      {
        eventId: session.id,
        occurredAt: businessTime(session),
        pricedOrder,
      },
      finalize,
    );
    prepared = {
      attendeeInput: {
        ...(await attendeeBaseFields(intent)),
        bookings,
        remainingBalance,
        ticketToken,
      },
      plan,
    };
  } catch (error) {
    return {
      detail: `Unexpected error preparing session ${session.id}: ${String(error)}`,
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
    // The named arm needs one listing: a paid checkout always has at least one
    // validated item, so the first is guaranteed to exist.
    const errorName = pricingIntent.items.some(
      (item) => item.packageGroupId !== undefined,
    )
      ? ""
      : validatedItems[0]!.listing.name;
    return {
      detail: formatPostPaymentError(errorName),
      ok: false,
      reason: result.reason,
    };
  }
  const entries = pairEntriesByListing(result.attendees, validatedItems);
  return { entries, ok: true };
};
