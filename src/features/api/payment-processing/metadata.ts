/**
 * Read a paid session's signed metadata into the domain {@link BookingIntent}.
 *
 * The metadata JSON was serialized by our own checkout (buildMetadata), but it
 * is never trusted on the way back in: the assembled booking is parsed against
 * {@link BookingIntentSchema}, so a drifted, tampered, or foreign blob fails
 * closed here instead of feeding wrong values into fulfilment after the buyer
 * has already paid.
 */

import * as v from "valibot";
import {
  type BookingIntent,
  BookingIntentSchema,
} from "#shared/booking-intent.ts";
import { nowIso } from "#shared/now.ts";
import type {
  SessionMetadata,
  ValidatedPaymentSession,
} from "#shared/payments.ts";

/**
 * The ledger occurredAt for a payment: the provider's checkout time — the
 * customer's business time — so a late webhook (or an old redirect, or a stale
 * retry) still books on the day they paid. Falls back to the processing clock
 * only when the provider gave no timestamp.
 */
export const businessTime = (session: ValidatedPaymentSession): string =>
  session.createdAt ?? nowIso();

/** Read one JSON metadata field: the value it holds when it has one, the
 * field's own fallback when it is empty, and `null` when the text is not
 * readable JSON at all. Nothing in a booking may be null, so unreadable text
 * fails the whole booking below rather than one field going quietly missing. */
const jsonMetaField =
  (fallback: unknown) =>
  (json: string): unknown => {
    if (!json) return fallback;
    try {
      return JSON.parse(json);
    } catch {
      return null;
    }
  };

/** Answers, free-text answers, and child tickets are all absent when the
 * checkout sent none; modifiers are an empty list. */
const parseAnswerRefs = jsonMetaField(undefined);
const parseModifierRefs = jsonMetaField([]);

/** The lines being booked. A checkout with none is not a booking, so an empty
 * field reads as nothing the schema will accept. */
const parseBookingItems = jsonMetaField(null);

/** A whole number a booking counts with, or nothing when the field is empty.
 * A field holding something that is not a whole number becomes a number the
 * booking schema refuses, so the reading fails instead of counting wrong. */
const wholeNumberField = (raw: string): number | undefined =>
  raw ? Number(raw) : undefined;

/**
 * Read a paid session's booking back out of its metadata, or `null` when what
 * came back is not a booking we can act on.
 *
 * Everything here arrives as text a provider handed back, so the assembled
 * booking is parsed against the schema before anyone sees it: a drifted,
 * tampered, or foreign blob fails here rather than after the buyer has paid.
 * The empty date the metadata uses for "no date" becomes null on the way in.
 */
export const extractIntent = (
  session: ValidatedPaymentSession,
): BookingIntent | null => extractIntentFromMetadata(session.metadata);

/** Read the booking a metadata blob describes, or null when it cannot be
 * read as one — a rejected session's blob may predate the current shape. */
export const extractIntentFromMetadata = (
  metadata: SessionMetadata,
): BookingIntent | null => {
  const result = v.safeParse(BookingIntentSchema, {
    address: metadata.address,
    allocations: parseAnswerRefs(metadata.allocations),
    balanceAttendeeId: wholeNumberField(metadata.balance_attendee_id),
    date: metadata.date || null,
    dayCount: wholeNumberField(metadata.day_count),
    email: metadata.email,
    items: parseBookingItems(metadata.items),
    listingAnswerIds: parseAnswerRefs(metadata.answer_ids),
    listingTextAnswerIds: parseAnswerRefs(metadata.text_answer_ids),
    modifiers: parseModifierRefs(metadata.modifiers),
    name: metadata.name,
    phone: metadata.phone,
    reservationAmount: metadata.reservation_amount || undefined,
    siteTokenIndex: metadata.site_token_index || undefined,
    special_instructions: metadata.special_instructions,
    thankYouUrl: metadata.thank_you_url || undefined,
  });
  return result.success ? result.output : null;
};
