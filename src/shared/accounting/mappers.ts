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
 * Reject malformed facts loudly rather than silently dropping a leg with the
 * zero-amount filter. Catches an empty event id (which would make every such
 * booking share one event group / references), non-finite amounts (NaN/∞ slip
 * past `> 0`), negative non-modifier amounts, and fractional/unsafe minor units
 * (all money facts are integer pence/cents — a fractional split like `10.5` must
 * be caught here, since aggregating two of them into `21` would hide the
 * fractional pennies before `validateTransfer` ever sees them). A modifier
 * `delta` may be negative (a discount) but must still be a safe integer.
 */
const assertValidFacts = (facts: BookingFacts): void => {
  const problems: string[] = [];
  if (!facts.eventId) problems.push("empty eventId");
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
