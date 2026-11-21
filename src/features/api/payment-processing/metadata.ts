/**
 * Read a paid session's signed metadata into the domain {@link BookingIntent}.
 *
 * The metadata JSON was serialized by our own checkout (buildMetadata), but it
 * is never trusted on the way back in. The assembled booking is parsed against
 * {@link BookingIntentSchema}, so a drifted, tampered, or foreign blob fails
 * closed here. Wrong values therefore never reach fulfilment after the buyer
 * has already paid.
 */

import * as v from "valibot";
import { openCheckoutBundle } from "#db/checkout-bundles.ts";
import {
  type BookingIntent,
  BookingIntentSchema,
} from "#shared/booking-intent.ts";
import { nowIso } from "#shared/now.ts";
import {
  extractSessionMetadata,
  hasRequiredSessionMetadata,
} from "#shared/payment-helpers.ts";
import type {
  SessionMetadata,
  ValidatedPaymentSession,
} from "#shared/payments.ts";
import { NO_TAX } from "#shared/tax/types.ts";

/**
 * The ledger occurredAt for a payment: the provider's checkout time — the
 * customer's business time. A late webhook, an old redirect, or a stale retry
 * still books on the day they paid. Falls back to the processing clock only
 * when the provider gave no timestamp.
 */
export const businessTime = (session: ValidatedPaymentSession): string =>
  session.createdAt ?? nowIso();

/** Read one JSON metadata field. The value is what the field holds when it
 * has one, and the field's own fallback when it is empty. A `null` return
 * means the text is not readable JSON at all. Nothing in a booking can be
 * null, so unreadable text fails the whole booking below rather than one
 * field going quietly missing. */
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
 * checkout sent none. Modifiers are an empty list. */
const parseAnswerRefs = jsonMetaField(undefined);
const parseModifierRefs = jsonMetaField([]);
const parseTaxPolicy = jsonMetaField(NO_TAX);

/** The lines being booked. A checkout with none is not a booking, so an empty
 * field reads as nothing the schema will accept. */
const parseBookingItems = jsonMetaField(null);

/** A whole number a booking counts with, or nothing when the field is empty.
 * A field holding something that is not a whole number becomes a number the
 * booking schema refuses, so the reading fails instead of counting wrong. */
const wholeNumberField = (raw: string): number | undefined =>
  raw ? Number(raw) : undefined;

/** A validated session or a rejected one: anything that holds the checkout's
 * metadata. */
type HasMetadata = { readonly metadata: SessionMetadata };

/** What a session's order turned out to be. A sealed order that cannot be
 * opened differs from fields that do not make a booking. Only the sealed
 * order leaves a paid buyer with no record at all. */
export type SessionOrder =
  | { status: "read"; intent: BookingIntent }
  | { status: "unreadable" }
  | { status: "bundle_missing" | "bundle_unreadable" };

/** The booking that a set of order fields describes, or `unreadable`. */
const orderFrom = (metadata: SessionMetadata): SessionOrder => {
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
    taxPolicy: parseTaxPolicy(metadata.tax_policy),
    thankYouUrl: metadata.thank_you_url || undefined,
  });
  return result.success
    ? { intent: result.output, status: "read" }
    : { status: "unreadable" };
};

/**
 * Read a session's booking out of its order. A Stripe or Square checkout names
 * its sealed order by token, and the order is opened from our database. A
 * checkout that carries its order in its own fields (SumUp, or one made before
 * orders were sealed) is read as it stands.
 *
 * Everything is parsed against the schema before anyone sees it, so a drifted,
 * tampered, or foreign order fails here rather than after the buyer pays.
 */
export const readSessionOrder = async ({
  metadata,
}: HasMetadata): Promise<SessionOrder> => {
  if (metadata.bundle === "") return orderFrom(metadata);
  const bundle = await openCheckoutBundle(metadata.bundle);
  if (bundle.status !== "opened") return { status: `bundle_${bundle.status}` };
  return hasRequiredSessionMetadata(bundle.record)
    ? orderFrom(extractSessionMetadata(bundle.record))
    : { status: "unreadable" };
};

/** Read the booking a session's order describes, or null when it cannot be
 * read as one — a rejected session's order can predate the current shape. */
export const extractIntent = async (
  holder: HasMetadata,
): Promise<BookingIntent | null> => {
  const order = await readSessionOrder(holder);
  return order.status === "read" ? order.intent : null;
};
