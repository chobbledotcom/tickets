/**
 * Read a paid session's signed metadata into the domain {@link BookingIntent}.
 *
 * The metadata JSON was serialized by our own checkout (buildMetadata), and
 * every fulfilment caller reaches here only for a session carrying a valid price
 * proof, so the structure is trusted — except {@link parseBookingItems}, which
 * schema-validates so a drifted/foreign blob fails closed instead of feeding
 * wrong values inward.
 */

import * as v from "valibot";
import type { BookingIntent } from "#shared/booking-intent.ts";
import {
  type BookingItem,
  BookingItemsSchema,
  type ModifierRef,
  type TextAnswerRef,
} from "#shared/booking-intent.ts";
import type { ChildAllocation } from "#shared/db/attendee-types.ts";
import { nowIso } from "#shared/now.ts";
import type { ValidatedPaymentSession } from "#shared/payments.ts";

/**
 * The ledger occurredAt for a payment: the provider's checkout time — the
 * customer's business time — so a late webhook (or an old redirect, or a stale
 * retry) still books on the day they paid. Falls back to the processing clock
 * only when the provider gave no timestamp.
 */
export const businessTime = (session: ValidatedPaymentSession): string =>
  session.createdAt ?? nowIso();

/** Read one optional JSON metadata field: parse it when present, or hand back
 * the field's own fallback when empty. The JSON was serialized by our own
 * buildMetadata, so we trust the structure (parseBookingItems is the deliberate
 * schema-validated exception). */
const jsonMetaField =
  <T>(fallback: T) =>
  (json: string): T =>
    json ? (JSON.parse(json) as T) : fallback;

/** Per-listing answer IDs; undefined when the checkout sent none. */
const parseListingAnswerIds = jsonMetaField<
  Record<string, number[]> | undefined
>(undefined);

/** Per-listing free-text answer references; undefined when none. */
const parseListingTextAnswerIds = jsonMetaField<
  Record<string, TextAnswerRef[]> | undefined
>(undefined);

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
  // Schema-validated, never blind-cast: a malformed or drifted blob fails the
  // parse loudly (the session is then unsigned/ignored) instead of feeding
  // wrong nodeKeys or NaN prices into revalidation.
  const result = v.safeParse(BookingItemsSchema, parsed);
  return result.success ? result.output : null;
};

/** The compact modifier references; absent (empty) means no modifiers. */
const parseModifierRefs = jsonMetaField<ModifierRef[]>([]);

/** Child ticket allocations; undefined when the checkout sent none. */
const parseAllocations = jsonMetaField<ChildAllocation[] | undefined>(
  undefined,
);

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
  const allocations = parseAllocations(metadata.allocations);
  const balanceAttendeeId = metadata.balance_attendee_id
    ? Number(metadata.balance_attendee_id)
    : undefined;
  const dayCount =
    Number.isInteger(parsedDayCount) && parsedDayCount > 0
      ? parsedDayCount
      : undefined;
  const listingAnswerIds = parseListingAnswerIds(metadata.answer_ids);
  const listingTextAnswerIds = parseListingTextAnswerIds(
    metadata.text_answer_ids,
  );
  const reservationAmount = metadata.reservation_amount || undefined;
  const siteTokenIndex = metadata.site_token_index || undefined;
  const thankYouUrl = metadata.thank_you_url || undefined;
  return {
    address: metadata.address,
    allocations,
    balanceAttendeeId,
    date: metadata.date || null,
    dayCount,
    email: metadata.email,
    items,
    listingAnswerIds,
    listingTextAnswerIds,
    modifiers: parseModifierRefs(metadata.modifiers),
    name: metadata.name,
    phone: metadata.phone,
    reservationAmount,
    siteTokenIndex,
    special_instructions: metadata.special_instructions,
    thankYouUrl,
  };
};
