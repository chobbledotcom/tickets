/**
 * Event mappers — pure translations from a money event's facts to the ledger
 * legs to post. Kept free of the checkout pricing types and of any I/O: the
 * wiring builds {@link BookingFacts} from the priced order and hands the result
 * to the store.
 */

import {
  attendeeAccount,
  BOOKING_FEE_INCOME,
  MODIFIER,
  modifierAccount,
  revenueAccount,
  TAX_VAT,
  WORLD,
} from "#accounting/accounts.ts";
import { KIND } from "#accounting/kinds.ts";
import {
  MANUAL_ATTENDEE_CHARGE,
  MANUAL_ATTENDEE_WRITEOFF,
} from "#accounting/manual-entries.ts";
import { eventGroup, legReference, type RefPart } from "#accounting/refs.ts";
import { sumByKey, sumOf } from "#fp";
import { largestRemainderAllocation } from "#shared/largest-remainder.ts";
import type {
  AccountRef,
  Transfer,
  TransferInput,
} from "#shared/ledger/types.ts";

const BOOKING = "booking";
const REFUND = "refund";

/**
 * The shared event group for a booking's legs, derived from its stable event
 * id. That id is the payment session id on the paid path, the attendee id on
 * the free/owed path. The single place the booking event key is built, so a ledger preflight
 * resolves exactly the group {@link mapBooking} posts under.
 */
export const bookingEventGroup = (eventId: string): Promise<string> =>
  eventGroup([BOOKING, eventId]);

/**
 * The event group a refund of one booking group is posted under. Derived from
 * the booking's, so a reversal already in the ledger can be recognised without
 * rebuilding the legs it writes.
 */
export const refundEventGroup = (bookingGroup: string): Promise<string> =>
  eventGroup([REFUND, bookingGroup]);

/**
 * The refund-side `kind` for each reversible booking leg. The cash leg is
 * relabelled `refund_cash` so reports can sum refunded cash (decision 8) without
 * double-counting the reversed sale/fee/modifier legs. The rest carry a
 * `refund_` prefix so a refund's legs never share a `kind` (or reference) with
 * the booking's.
 */
const REFUND_KIND: Readonly<Record<string, string>> = {
  [KIND.fee]: KIND.refundFee,
  [KIND.modifier]: KIND.refundModifier,
  [KIND.payment]: KIND.refundCash,
  [KIND.sale]: KIND.refundSale,
  [MANUAL_ATTENDEE_CHARGE]: KIND.refundManualAttendeeCharge,
  [MANUAL_ATTENDEE_WRITEOFF]: KIND.refundManualAttendeeWriteoff,
  [KIND.vat]: KIND.refundVat,
};

const refundKind = (kind: string): string =>
  REFUND_KIND[kind] ?? `refund_${kind}`;

/**
 * The VAT facts a booking carries: a rate in `add_to_total` or
 * `calculate_from_total` mode, or a pre-computed `amount`. Add-to-total
 * charges the tax on top of ex-VAT amounts. Calculate-from-total splits the
 * tax out of amounts that include it, so income stays ex-VAT. `{ amount }`
 * posts the caller's own tax figure. `rate` is a fraction (0.2 is 20%).
 * The booking fee never carries VAT.
 */
export type VatFacts =
  | { readonly mode: "add_to_total"; readonly rate: number }
  | { readonly mode: "calculate_from_total"; readonly rate: number }
  | { readonly amount: number };

/**
 * The money facts of one booking, decoupled from the checkout pricing types.
 * `gross` is a listing's list price before modifiers/fee. `delta` is a modifier's
 * signed effect (negative = discount). `amountPaid` is the cash actually received
 * now (a deposit, or the full amount). `eventId` is any stable per-booking id
 * (for example the payment reference) — it is hashed into the references, never stored.
 * `vat` is the booking's VAT facts. A booking without `vat` charges no tax.
 */
export type BookingFacts = {
  readonly attendeeId: number;
  readonly occurredAt: string;
  readonly eventId: string;
  readonly lines: ReadonlyArray<{ listingId: number; gross: number }>;
  readonly modifiers: ReadonlyArray<{ modifierId: number; delta: number }>;
  readonly bookingFee: number;
  readonly amountPaid: number;
  readonly vat?: VatFacts;
};

type LegSpec = {
  source: AccountRef;
  destination: AccountRef;
  amount: number;
  kind: string;
  refParts: RefPart[];
};

/** A single fixed-direction leg, dropped when its amount is zero (a free booking
 *  posts no fee, and a deposit-free reservation posts no payment). */
const optionalLeg = (
  amount: number,
  spec: Omit<LegSpec, "amount">,
): LegSpec[] => (amount > 0 ? [{ ...spec, amount }] : []);

const modifierLeg = (
  attendee: AccountRef,
  modifier: { modifierId: number; delta: number },
): LegSpec => {
  const modAccount = modifierAccount(modifier.modifierId);
  const refParts = ["mod", modifier.modifierId];
  // A surcharge bills the attendee (revenue). A discount funds the attendee
  // from the modifier's contra account. Amounts are always positive.
  return modifier.delta > 0
    ? {
        amount: modifier.delta,
        destination: modAccount,
        kind: KIND.modifier,
        refParts,
        source: attendee,
      }
    : {
        amount: -modifier.delta,
        destination: attendee,
        kind: KIND.modifier,
        refParts,
        source: modAccount,
      };
};

/** The booking's taxable total: ticket sales plus net modifier effect. The
 *  booking fee never carries VAT. A discount (negative delta) lowers the base. */
const taxableBase = (facts: BookingFacts): number =>
  sumOf((line: BookingFacts["lines"][number]) => line.gross)(facts.lines) +
  sumOf((modifier: BookingFacts["modifiers"][number]) => modifier.delta)(
    facts.modifiers,
  );

/** The VAT amount a booking carries, derived from its facts. A booking without
 *  facts, or with a zero/negative taxable base, posts no tax. */
const vatAmountFor = (facts: BookingFacts): number => {
  const vat = facts.vat;
  if (vat === undefined) return 0;
  if ("amount" in vat) return vat.amount;
  const base = taxableBase(facts);
  if (base <= 0) return 0;
  return vat.mode === "add_to_total"
    ? Math.round(base * vat.rate)
    : Math.round((base * vat.rate) / (1 + vat.rate));
};

/** The single attendee→`tax:vat` leg, dropped when the tax is zero. */
const vatLegSpec = (vatAmount: number, attendee: AccountRef): LegSpec[] =>
  vatAmount > 0
    ? [
        {
          amount: vatAmount,
          destination: TAX_VAT,
          kind: KIND.vat,
          refParts: [KIND.vat],
          source: attendee,
        },
      ]
    : [];

/**
 * The booking's legs with VAT applied. It adds an extra attendee→`tax:vat`
 * leg. In `calculate_from_total` mode it also reduces the sale/surcharge
 * amounts by their share of the tax, so income stays ex-VAT. The tax is split
 * by largest remainder, so every reduced amount stays a whole minor unit.
 * The shares sum exactly to the VAT leg.
 */
const withVat = (
  facts: BookingFacts,
  attendee: AccountRef,
  sales: LegSpec[],
  modifiers: LegSpec[],
): { modifiers: LegSpec[]; sales: LegSpec[]; vat: LegSpec[] } => {
  const vatAmount = vatAmountFor(facts);
  if (
    facts.vat === undefined ||
    "amount" in facts.vat ||
    vatAmount <= 0 ||
    facts.vat.mode === "add_to_total"
  ) {
    return { modifiers, sales, vat: vatLegSpec(vatAmount, attendee) };
  }
  // calculate_from_total: the sale and surcharge amounts include VAT.
  const vatable = [
    ...sales,
    ...modifiers.filter((spec) => spec.destination.type === MODIFIER),
  ];
  const allocation = largestRemainderAllocation(
    vatable.map((spec) => spec.amount),
    vatAmount,
  );
  const shareOf = new Map(
    vatable.map((spec, index) => [spec, allocation[index]!]),
  );
  const reduce = (spec: LegSpec): LegSpec => {
    const share = shareOf.get(spec);
    return share === undefined
      ? spec
      : { ...spec, amount: spec.amount - share };
  };
  return {
    modifiers: modifiers.map(reduce),
    sales: sales.map(reduce),
    vat: vatLegSpec(vatAmount, attendee),
  };
};

const bookingLegSpecs = (
  facts: BookingFacts,
  attendee: AccountRef,
): LegSpec[] => {
  // Aggregate to one sale leg per listing: discount splits produce several
  // lines for the same listing, which must not share a `["sale", listingId]`
  // reference. The store treats the second as a conflicting duplicate.
  const grossByListing = sumByKey(
    (line: BookingFacts["lines"][number]) => line.listingId,
    (line) => line.gross,
  )(facts.lines.filter((line) => line.gross > 0));
  const sales: LegSpec[] = [...grossByListing].map(([listingId, gross]) => ({
    amount: gross,
    destination: revenueAccount(listingId),
    kind: KIND.sale,
    refParts: [KIND.sale, listingId],
    source: attendee,
  }));
  const modifiers = facts.modifiers
    .filter((modifier) => modifier.delta !== 0)
    .map((modifier) => modifierLeg(attendee, modifier));
  const fee = optionalLeg(facts.bookingFee, {
    destination: BOOKING_FEE_INCOME,
    kind: KIND.fee,
    refParts: [KIND.fee],
    source: attendee,
  });
  const payment = optionalLeg(facts.amountPaid, {
    destination: attendee,
    kind: KIND.payment,
    refParts: [KIND.payment],
    source: WORLD,
  });
  const vat = withVat(facts, attendee, sales, modifiers);
  return [...vat.sales, ...vat.modifiers, ...fee, ...payment, ...vat.vat];
};

/** The malformed-facts messages a booking's VAT facts carry, or none. A
 *  pre-computed amount is a money value like any other, so it gets the same
 *  finite/non-negative/integer checks the rest of the facts get. */
const vatFactsProblems = (vat: VatFacts): string[] => {
  if ("amount" in vat) {
    const problems: string[] = [];
    const value = vat.amount;
    if (!Number.isFinite(value)) problems.push("non-finite vat amount");
    else if (value < 0) problems.push("negative vat amount");
    else if (!Number.isSafeInteger(value))
      problems.push("non-integer vat amount");
    return problems;
  }
  return !Number.isFinite(vat.rate) || vat.rate <= 0
    ? [`invalid vat rate ${vat.rate}`]
    : [];
};

/**
 * Reject malformed facts loudly rather than silently dropping a leg with the
 * zero-amount filter. It catches a blank event id — empty or whitespace-only —
 * which makes every such booking share one event group and references. It also
 * catches non-finite amounts (NaN/∞ slip past `> 0`), negative non-modifier
 * amounts, and fractional/unsafe minor units. All money facts are integer
 * pence/cents, so a fractional split like `10.5` must be caught here.
 * Aggregating two of them into `21` hides the fractional pennies before
 * `validateTransfer` ever sees them. A modifier
 * `delta` can be negative (a discount) but must still be a safe integer.
 */
const assertValidFacts = (facts: BookingFacts): void => {
  const problems: string[] = [];
  // Reject a blank id, including whitespace-only. A missing source id normalised
  // to spaces still hashes to a non-empty event group. Two such bookings then
  // collide onto one event, and the second is skipped as a replay.
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
  if (facts.vat !== undefined) {
    problems.push(...vatFactsProblems(facts.vat));
  }
  if (problems.length > 0) {
    throw new Error(`mapBooking: invalid facts (${problems.join(", ")})`);
  }
};

/**
 * Map a booking's money facts to the ledger legs to post. The legs are a
 * `sale` per listing (gross), a signed `modifier` per modifier, a `fee`, and a
 * `payment` for the cash received — all sharing one event group.
 * Zero-amount legs are dropped. `balanceOf(attendee)` over the result is the
 * negative of what the attendee still owes.
 */
export const mapBooking = async (
  facts: BookingFacts,
): Promise<TransferInput[]> => {
  assertValidFacts(facts);
  const group = await bookingEventGroup(facts.eventId);
  const attendee = attendeeAccount(facts.attendeeId);
  return Promise.all(
    bookingLegSpecs(facts, attendee).map(async (spec) => ({
      amount: spec.amount,
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
 * being refunded, and when the refund happened. They all share its event group.
 * `postedBy` is the actor (an admin id or "system").
 */
export type RefundFacts = {
  readonly orderLegs: readonly Transfer[];
  readonly occurredAt: string;
  readonly postedBy?: string;
  /** Optional PII-free reason code stamped on every refund leg (for example why
   * an automatic refund happened). Kept free of names/emails by convention. */
  readonly memo?: string | undefined;
};

/**
 * Stand freshly-built (not yet stored) booking inputs in for the stored legs
 * {@link mapRefund} normally reads back from the ledger. `mapRefund` reads only
 * money-identity fields — never `id`/`recordedAt` — so a placeholder id and the
 * booking time suffice. For paths that map a reversal in the same breath as the
 * booking: the historical backfill, and test seeding that mirrors it.
 */
export const asOrderLegs = (
  inputs: TransferInput[],
  recordedAt: string,
): Transfer[] => inputs.map((leg) => ({ ...leg, id: 0, recordedAt }));

/**
 * The booking legs are read from the ledger, so the reversal matches exactly
 * what was posted, whatever the modifiers, fee or deposit were.
 *
 * Refunds do not use `reverses_id`. That one-slot link is for admin voids,
 * while a refund posts many rows. Repeat and partial refunds are therefore
 * scoped by event group instead (decision 8). The derived group also makes a re-submit
 * replay as a no-op. Every leg carries {@link TransferInput.reversesGroup} —
 * the booking order's event group — so a read can join a reversal back to the
 * one order it undid. The hashed refund group and references cannot answer
 * that per-booking-row question on their own.
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
      destination: leg.source,
      eventGroup: group,
      kind: refundKind(leg.kind ?? ""),
      ...(facts.memo !== undefined ? { memo: facts.memo } : {}),
      occurredAt: facts.occurredAt,
      postedBy: facts.postedBy ?? "system",
      reference: await legReference([REFUND, bookingGroup, leg.reference]),
      reversesGroup: bookingGroup,
      source: leg.destination,
    })),
  );
};
