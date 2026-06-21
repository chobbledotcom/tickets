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
import type { AccountRef, TransferInput } from "#shared/ledger/types.ts";

const BOOKING = "booking";

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
 * Map a booking's money facts to the ledger legs to post: a `sale` per listing
 * (gross), a signed `modifier` per applied modifier, a `fee` for the booking
 * fee, and a `payment` for the cash received — all sharing one event group.
 * Zero-amount legs are dropped. `balanceOf(attendee)` over the result is the
 * negative of what the attendee still owes.
 */
export const mapBooking = async (
  facts: BookingFacts,
): Promise<TransferInput[]> => {
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
