/**
 * Event mappers — pure translations from a money event's facts to the ledger
 * legs to post. Kept free of the checkout pricing types and of any I/O: the
 * wiring builds {@link BookingFacts} from the priced order and hands the result
 * to the store.
 */

import {
  attendeeAccount,
  BOOKING_FEE_INCOME,
  modifierAccount,
  revenueAccount,
  WORLD,
} from "#shared/accounting/accounts.ts";
import {
  eventGroup,
  legReference,
  type RefPart,
} from "#shared/accounting/refs.ts";
import type {
  AccountRef,
  Transfer,
  TransferInput,
} from "#shared/ledger/types.ts";

const BOOKING = "booking";
const REFUND = "refund";

/**
 * The refund-side `kind` for each reversible booking leg. The cash leg is
 * relabelled `refund_cash` so reports can sum refunded cash (decision 8) without
 * double-counting the reversed sale/fee/modifier legs; the rest carry a
 * `refund_` prefix so a refund's legs never share a `kind` (or reference) with
 * the booking's.
 */
const REFUND_KIND: Readonly<Record<string, string>> = {
  fee: "refund_fee",
  modifier: "refund_modifier",
  payment: "refund_cash",
  sale: "refund_sale",
};

const refundKind = (kind: string): string =>
  REFUND_KIND[kind] ?? `refund_${kind}`;

/** The event group shared by every leg of the refund of one booking order,
 *  derived from the booking's own group so a re-submit is recognisable. */
export const refundEventGroup = (bookingEventGroup: string): Promise<string> =>
  eventGroup([REFUND, bookingEventGroup]);

/**
 * The money facts of one booking, decoupled from the checkout pricing types.
 * `gross` is a listing's list price before modifiers/fee; `delta` is a modifier's
 * signed effect (negative = discount); `amountPaid` is the cash actually received
 * now (a deposit, or the full amount). `eventId` is any stable per-booking id
 * (e.g. the payment reference) — it is hashed into the references, never stored.
 */
export type BookingFacts = {
  readonly attendeeId: number;
  readonly currency: string;
  readonly occurredAt: string;
  readonly eventId: string;
  readonly lines: ReadonlyArray<{ listingId: number; gross: number }>;
  readonly modifiers: ReadonlyArray<{ modifierId: number; delta: number }>;
  readonly bookingFee: number;
  readonly amountPaid: number;
};

type LegSpec = {
  source: AccountRef;
  destination: AccountRef;
  amount: number;
  kind: string;
  refParts: RefPart[];
};

const modifierLeg = (
  attendee: AccountRef,
  modifier: { modifierId: number; delta: number },
): LegSpec => {
  const modAccount = modifierAccount(modifier.modifierId);
  const refParts = ["mod", modifier.modifierId];
  // A surcharge bills the attendee (revenue); a discount funds the attendee
  // from the modifier's contra account. Amounts are always positive.
  return modifier.delta > 0
    ? {
        amount: modifier.delta,
        destination: modAccount,
        kind: "modifier",
        refParts,
        source: attendee,
      }
    : {
        amount: -modifier.delta,
        destination: attendee,
        kind: "modifier",
        refParts,
        source: modAccount,
      };
};

const bookingLegSpecs = (
  facts: BookingFacts,
  attendee: AccountRef,
): LegSpec[] => {
  // Aggregate to one sale leg per listing: discount splits produce several
  // lines for the same listing, which must not share a `["sale", listingId]`
  // reference (the store would treat the second as a conflicting duplicate).
  const grossByListing = new Map<number, number>();
  for (const line of facts.lines) {
    if (line.gross > 0) {
      grossByListing.set(
        line.listingId,
        (grossByListing.get(line.listingId) ?? 0) + line.gross,
      );
    }
  }
  const sales: LegSpec[] = [...grossByListing].map(([listingId, gross]) => ({
    amount: gross,
    destination: revenueAccount(listingId),
    kind: "sale",
    refParts: ["sale", listingId],
    source: attendee,
  }));
  const modifiers = facts.modifiers
    .filter((modifier) => modifier.delta !== 0)
    .map((modifier) => modifierLeg(attendee, modifier));
  const fee: LegSpec[] =
    facts.bookingFee > 0
      ? [
          {
            amount: facts.bookingFee,
            destination: BOOKING_FEE_INCOME,
            kind: "fee",
            refParts: ["fee"],
            source: attendee,
          },
        ]
      : [];
  const payment: LegSpec[] =
    facts.amountPaid > 0
      ? [
          {
            amount: facts.amountPaid,
            destination: attendee,
            kind: "payment",
            refParts: ["payment"],
            source: WORLD,
          },
        ]
      : [];
  return [...sales, ...modifiers, ...fee, ...payment];
};

/**
 * Reject malformed facts loudly rather than silently dropping a leg with the
 * zero-amount filter. Catches a blank event id — empty or whitespace-only —
 * (which would make every such booking share one event group / references),
 * non-finite amounts (NaN/∞ slip
 * past `> 0`), negative non-modifier amounts, and fractional/unsafe minor units
 * (all money facts are integer pence/cents — a fractional split like `10.5` must
 * be caught here, since aggregating two of them into `21` would hide the
 * fractional pennies before `validateTransfer` ever sees them). A modifier
 * `delta` may be negative (a discount) but must still be a safe integer.
 */
const assertValidFacts = (facts: BookingFacts): void => {
  const problems: string[] = [];
  // Reject a blank id, including whitespace-only: a missing source id normalised
  // to spaces would still hash to a non-empty event group, so two such bookings
  // would collide onto one event and the second would be skipped as a replay.
  if (!facts.eventId?.trim()) problems.push("empty eventId");
  const requireAmount = (label: string, value: number): void => {
    if (!Number.isFinite(value)) problems.push(`non-finite ${label}`);
    else if (value < 0) problems.push(`negative ${label}`);
    else if (!Number.isSafeInteger(value))
      problems.push(`non-integer ${label}`);
  };
  for (const line of facts.lines) {
    requireAmount(`listing ${line.listingId} gross`, line.gross);
  }
  for (const modifier of facts.modifiers) {
    if (!Number.isFinite(modifier.delta)) {
      problems.push(`non-finite modifier ${modifier.modifierId} delta`);
    } else if (!Number.isSafeInteger(modifier.delta)) {
      problems.push(`non-integer modifier ${modifier.modifierId} delta`);
    }
  }
  requireAmount("bookingFee", facts.bookingFee);
  requireAmount("amountPaid", facts.amountPaid);
  if (problems.length > 0) {
    throw new Error(`mapBooking: invalid facts (${problems.join(", ")})`);
  }
};

/**
 * Map a booking's money facts to the ledger legs to post: a `sale` per listing
 * (gross), a signed `modifier` per applied modifier, a `fee` for the booking
 * fee, and a `payment` for the cash received — all sharing one event group.
 * Zero-amount legs are dropped. `balanceOf(attendee)` over the result is the
 * negative of what the attendee still owes.
 */
export const mapBooking = async (
  facts: BookingFacts,
): Promise<TransferInput[]> => {
  assertValidFacts(facts);
  const group = await eventGroup([BOOKING, facts.eventId]);
  const attendee = attendeeAccount(facts.attendeeId);
  return Promise.all(
    bookingLegSpecs(facts, attendee).map(async (spec) => ({
      amount: spec.amount,
      currency: facts.currency,
      destination: spec.destination,
      eventGroup: group,
      kind: spec.kind,
      occurredAt: facts.occurredAt,
      reference: await legReference([BOOKING, facts.eventId, ...spec.refParts]),
      source: spec.source,
    })),
  );
};

/**
 * The money facts of a full refund: the stored legs of the one booking order
 * being refunded (all sharing its event group) and when the refund happened.
 * `postedBy` is the actor (an admin id or "system").
 */
export type RefundFacts = {
  readonly orderLegs: ReadonlyArray<Transfer>;
  readonly occurredAt: string;
  readonly postedBy?: string;
};

/**
 * Map a full refund of one booking order to its ledger legs: the inverse of each
 * stored leg (revenue/fee/modifier handed back to the attendee, cash returned to
 * the world as `refund_cash`), all under one new refund event group derived from
 * the booking's. The booking legs are read from the ledger, so the reversal
 * matches exactly what was posted — whatever the booking's modifiers, fee, or
 * deposit were — and `balanceOf(revenue)` returns to zero on a full refund.
 *
 * Refunds don't use `reverses_id`: that one-slot link is for admin voids, while
 * a refund posts many rows and repeat/partial refunds are scoped by event group
 * instead (decision 8). Posting is idempotent — the derived refund event group
 * means a re-submit replays as a no-op.
 */
export const mapRefund = async (
  facts: RefundFacts,
): Promise<TransferInput[]> => {
  const legs = facts.orderLegs;
  if (legs.length === 0) throw new Error("mapRefund: no order legs to refund");
  const bookingGroup = legs[0]!.eventGroup;
  if (legs.some((leg) => leg.eventGroup !== bookingGroup)) {
    throw new Error("mapRefund: order legs span more than one event group");
  }
  const group = await refundEventGroup(bookingGroup);
  return Promise.all(
    legs.map(async (leg) => ({
      amount: leg.amount,
      currency: leg.currency,
      destination: leg.source,
      eventGroup: group,
      kind: refundKind(leg.kind ?? ""),
      occurredAt: facts.occurredAt,
      postedBy: facts.postedBy ?? "system",
      reference: await legReference([REFUND, bookingGroup, leg.reference]),
      source: leg.destination,
    })),
  );
};
