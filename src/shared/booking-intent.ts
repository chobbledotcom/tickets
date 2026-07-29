/**
 * What a booking is, as the data a payment carries.
 *
 * Everything here is a schema first: the writer and every reader parse against
 * the same declaration, so a drifted or tampered blob is a loud parse failure
 * rather than a silently-wrong booking. Kept apart from the provider layer
 * because these facts outlive any one provider.
 */

/* jscpd:ignore-start -- imports */
import * as v from "valibot";
import { parseReservationAmount } from "#shared/reservation-amount.ts";
import { integerAtLeast } from "#shared/validation/number.ts";
import { optionalStringThat } from "#shared/validation/string.ts";

/* jscpd:ignore-end */

/**
 * Compact booking item stored in session metadata (serialized/deserialized as
 * JSON): listing id (`e`), quantity (`q`), line total in minor units (`p`).
 *
 * A top-level line also carries its edge provenance so the webhook can
 * reconstruct the line's canonical booking-tree `nodeKey` and re-check it still
 * resolves: `k` is the edge kind (`"p"` package member, `"g"` group member — see
 * signed-metadata.ts) and `r` the group id it hangs off. Both are absent on a
 * standalone line.
 */
/** One signed booking line, schema-first: `e` listing id, `q` quantity, `p`
 * signed line total in minor units, and the optional edge tag (`k` code + `r`
 * group id) the webhook's nodeKey revalidation reconstructs. The writer
 * (signedEdgeFor) and every reader parse against THIS schema, so a drifted or
 * tampered blob is a loud parse failure — never a silently-wrong nodeKey.
 *
 * `p` is an integer: it is `unitPrice * quantity`, both integer minor units, so
 * a fractional value is corruption. `q` is a non-negative integer — a signed
 * line may deliberately carry quantity 0 (an admin no-quantity sentinel or a
 * refunded/deleted-listing placeholder), which downstream preserves rather than
 * coercing to 1 and the success page then rejects as having no live ticket; see
 * extractIntent. The edge tag is a pair — `k` and `r` are both present (a
 * package/group member) or both absent (a standalone line); a half-present tag
 * would let the reader fall back to a standalone nodeKey instead of failing
 * loud, so the schema rejects it. This schema is internal: production always
 * parses the array form (a single line is an array of one), so only
 * {@link BookingItemsSchema} and the {@link BookingItem} type are exported. */
/** A positive integer (≥ 1): a listing id or a group id. */
const positiveInt = integerAtLeast(1);

const BookingItemSchema = v.pipe(
  v.object({
    e: positiveInt,
    k: v.optional(v.union([v.literal("p"), v.literal("g")])),
    p: v.pipe(v.number(), v.integer()),
    q: v.pipe(v.number(), v.integer(), v.minValue(0)),
    r: v.optional(positiveInt),
  }),
  v.check(
    (item) => (item.k === undefined) === (item.r === undefined),
    "edge tag k and r must both be present or both absent",
  ),
);

export const BookingItemsSchema = v.pipe(
  v.array(BookingItemSchema),
  v.minLength(1),
);

export type BookingItem = v.InferOutput<typeof BookingItemSchema>;

/** Compact modifier reference stored in session metadata: the modifier id and
 * the quantity taken. The webhook re-fetches the modifier by id and re-derives
 * its amount from the current database — provider metadata amounts are never
 * trusted. */
const ModifierRefSchema = v.strictObject({ i: positiveInt, q: positiveInt });
export type ModifierRef = v.InferOutput<typeof ModifierRefSchema>;

/** A text answer that still knows which stored string it points at. Booking
 *  checks every answer against this before saving it: the metadata it came from
 *  is parsed JSON that nothing has validated, so the string id can be any shape
 *  at all. */
export const StoredTextAnswerRefSchema = v.strictObject({
  q: positiveInt,
  s: positiveInt,
});
export type StoredTextAnswerRef = v.InferOutput<
  typeof StoredTextAnswerRefSchema
>;

/** A free-text answer as it arrives in checkout metadata. The string id can be
 *  missing when it was lost between the form and the callback; booking drops
 *  that one answer rather than throwing away a paid order. */
const TextAnswerRefSchema = v.strictObject({
  ...StoredTextAnswerRefSchema.entries,
  s: v.optional(positiveInt),
});
export type TextAnswerRef = v.InferOutput<typeof TextAnswerRefSchema>;

/** Per-listing answer references carried through a checkout, shared by the
 * booking and checkout intents. */
export type ListingAnswerRefs = {
  /** Per-listing answer IDs: maps listingId → answerIds for that listing's questions */
  listingAnswerIds?: Record<string, number[]> | undefined;
  /** Per-listing free-text string refs: maps listingId → question/string ids. */
  listingTextAnswerIds?: Record<string, TextAnswerRef[]> | undefined;
};
/**
 * Answers are filed under the listing they belong to, written the way a
 * listing id is written. A key in any other shape can never match a listing,
 * so the answers under it would be dropped without a word after the buyer had
 * paid. Whether the key names a listing that was actually booked is a question
 * only the booking code can answer, and is noted in TODO.md.
 */
const ListingKeySchema = v.pipe(
  v.string(),
  v.regex(/^[1-9][0-9]*$/u, "A listing key must be a listing id"),
);

/** Canonical booking facts persisted for a payment and sent through metadata. */
export const BookingIntentSchema = v.pipe(
  v.strictObject({
    address: v.string(),
    allocations: v.optional(
      v.array(
        v.object({
          childId: positiveInt,
          parentId: positiveInt,
          qty: positiveInt,
        }),
      ),
    ),
    balanceAttendeeId: v.optional(positiveInt),
    date: v.nullable(v.string()),
    dayCount: v.optional(positiveInt),
    email: v.string(),
    items: BookingItemsSchema,
    listingAnswerIds: v.optional(
      v.record(ListingKeySchema, v.array(positiveInt)),
    ),
    listingTextAnswerIds: v.optional(
      v.record(ListingKeySchema, v.array(TextAnswerRefSchema)),
    ),
    modifiers: v.array(ModifierRefSchema),
    name: v.string(),
    phone: v.string(),
    // A deposit that cannot be read is turned into nothing further down, which
    // reserves a place and leaves the whole price owed. The amount is checked
    // when the owner saves it, and that check is stricter than this one, so a
    // real setting always gets through here.
    reservationAmount: optionalStringThat(
      (raw) => parseReservationAmount(raw) !== null,
      "Reservation amount must be a readable amount",
    ),
    siteTokenIndex: v.optional(v.string()),
    special_instructions: v.string(),
    thankYouUrl: v.optional(v.string()),
  }),
  // Paying off a balance is one made-up line holding what is still owed, and
  // only that line is settled. A second line would be charged for and then
  // neither booked nor given back.
  v.check(
    (intent) =>
      intent.balanceAttendeeId === undefined || intent.items.length === 1,
    "Paying off a balance must be for one line only",
  ),
);

/** Processed booking intent extracted from payment session metadata. */
export type BookingIntent = v.InferOutput<typeof BookingIntentSchema>;
