/**
 * A paid booking's create batch carries statements on top of the booking:
 * - the buyer's answers
 * - the take-back of the checkout's staged free text
 * - the booking's activity lines
 *
 * They ride the same atomic batch as the attendee insert (see `BatchTail`). A
 * failure in any of them rolls the whole booking back. The payment provider's
 * redelivery then starts the booking again from the beginning. The external
 * sends run only after that batch commits.
 */

/* jscpd:ignore-start -- imports */
import * as v from "valibot";
import { hmacHash } from "#crypto/hashing.ts";
import {
  type BookedActivity,
  bookingActivityStatements,
  sealBookedActivities,
} from "#db/activity-log.ts";
import type { BatchTail } from "#db/attendees/create-batch.ts";
import {
  dropCheckoutAnswersStatement,
  readCheckoutAnswers,
} from "#db/checkout-pending-answers.ts";
import { bookedAnswersTail } from "#db/questions/attendee-answers/at-booking.ts";
import {
  groupListingAnswerSets,
  prepareAttendeeAnswerSave,
} from "#db/questions/attendee-answers/save.ts";
import { requiredMapValue } from "#fp";
import {
  type BookingIntent,
  StoredTextAnswerRefSchema,
  type TextAnswerRef,
} from "#shared/booking-intent.ts";
import { formatCurrency } from "#shared/currency.ts";
import type { FreeTextAnswers } from "#shared/email/answers.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import type { ModifierSpec } from "#shared/payments.ts";
import { registeredActivityMessage } from "#shared/webhook/delivery.ts";
import type { ListingWithCount } from "#types";

/* jscpd:ignore-end */

/** The one attendee a paid booking creates, as the answer sets key it: a
 * placeholder the batch resolves from the booking's own ticket token. */
const PLACEHOLDER_ATTENDEE_ID = 0;

/**
 * Keep only the text-answer refs that still carry a resolved string id (`s`).
 * A ref without one is corrupt metadata, and the text is not recoverable from
 * it. Drop that one answer loudly rather than bind an undefined id. The
 * payment is already captured, so the booking must still finalize instead of
 * crash-loop the webhook.
 *
 * The check is the schema, not a presence test, because these refs were parsed
 * but never validated. Without it, a null, a word, or half a number lands in
 * the stored answers.
 */
const textRefsWithStringId = (
  refs: TextAnswerRef[],
  listingId: number,
): { questionId: number; stringId: number }[] => {
  const resolved: { questionId: number; stringId: number }[] = [];
  for (const ref of refs) {
    if (v.is(StoredTextAnswerRefSchema, ref)) {
      resolved.push({ questionId: ref.q, stringId: ref.s });
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

/** What one promo-code modifier did to the charged price. */
export type ModifierApplication = { delta: number; modifierId: number };

/** The activity line a promo code earns: what it changed the price by. The
 * first booked listing carries it, the way the buyer's own confirmation does. */
export const promoActivityLines = (
  specs: ModifierSpec[],
  applications: ModifierApplication[],
  listing: ListingWithCount,
): { listing: ListingWithCount; message: string }[] => {
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
      listing,
      message: `Promo code '${spec.name}' used: ${effect}`,
    };
  });
};

export type PaidBookingTail = {
  /** The buyer's typed free-text answers, read from the staged row for the
   * confirmation email. The staged row itself is deleted by the batch. */
  freeTexts: FreeTextAnswers | undefined;
  /** The statements the create batch carries after the booking rows. */
  ride: BatchTail;
};

export type PaidBookingTailInput = {
  codeSpecs: ModifierSpec[];
  intent: BookingIntent;
  /** Every listing the booking books, as validated against the checkout. */
  listings: readonly ListingWithCount[];
  modifierApplications: ModifierApplication[];
  sessionId: string;
};

/** Build the paid booking's batch tail, plus the free texts its confirmation
 * email needs. Everything fallible here — the answer encryption, the message
 * sealing, the staged-row read — happens before the batch opens, so the batch
 * itself is plain statements. */
export const paidBookingTail = async ({
  codeSpecs,
  intent,
  listings,
  modifierApplications,
  sessionId,
}: PaidBookingTailInput): Promise<PaidBookingTail> => {
  // The buyer's typed answers, read before the batch so the confirmation
  // email can show them. The staged row is deleted by the batch itself, so a
  // booking that rolls back keeps its staged copy for the redelivery.
  const wantsStagedTexts = intent.listingTextAnswerIds !== undefined;
  const freeTexts = wantsStagedTexts
    ? await readCheckoutAnswers(sessionId)
    : undefined;
  if (freeTexts?.size === 0) {
    // The hashed index, not the raw session id: for SumUp the id is the
    // checkout reference, which must not reach logs or sinks either.
    logError({
      code: ErrorCode.DATA_INVALID,
      detail: `A paid checkout carried text answers but its staged row is gone (session index ${await hmacHash(sessionId)}); its emails will show choice answers only`,
    });
  }
  const stagedDrop = wantsStagedTexts
    ? await dropCheckoutAnswersStatement(sessionId)
    : null;

  // The answers, keyed by one placeholder attendee the batch resolves from
  // the ticket token it inserts. The buyer's typed answers ride the same
  // sets, with the loud drop for a ref that lost its string id.
  const textRefsByListing: Record<
    string,
    { questionId: number; stringId: number }[]
  > = {};
  for (const listing of listings) {
    const refs = intent.listingTextAnswerIds?.[String(listing.id)] ?? [];
    const resolvedRefs = textRefsWithStringId(refs, listing.id);
    if (resolvedRefs.length === 0) continue;
    textRefsByListing[String(listing.id)] = resolvedRefs;
  }
  const answers = await prepareAttendeeAnswerSave(
    groupListingAnswerSets(
      listings.map((listing) => ({
        attendee: { id: PLACEHOLDER_ATTENDEE_ID },
        listing: { id: listing.id },
      })),
      intent.listingAnswerIds ?? {},
      {},
      textRefsByListing,
    ),
  );

  // The booking's activity lines, sealed with the owner public key before the
  // batch opens.
  const sealedActivities: BookedActivity[] = await sealBookedActivities([
    ...promoActivityLines(codeSpecs, modifierApplications, listings[0]!),
    ...listings.map((listing) => ({
      listing,
      message: registeredActivityMessage(listing.name),
    })),
  ]);

  return {
    freeTexts,
    ride: (tokenIndex) => [
      ...bookedAnswersTail(
        answers,
        listings.map((listing) => listing.id),
      )(tokenIndex),
      ...(stagedDrop === null ? [] : [stagedDrop]),
      ...bookingActivityStatements(sealedActivities, tokenIndex),
    ],
  };
};
