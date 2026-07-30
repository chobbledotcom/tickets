/** What a stored charge may be — the rules about how it behaves, as plain
 *  functions over plain data. The tables keep only what is true of a value
 *  whatever the code does; these change as the runtime is written. */

/* jscpd:ignore-start -- imports */
import type { PaymentRefundState } from "#shared/payment-state/lifecycle.ts";
import type { Fault } from "#shared/payment-state/record/fault.ts";
import {
  absent,
  allAbsent,
  firstFault,
  firstOf,
  present,
} from "#shared/payment-state/record/fault.ts";
import type { RecordOrigin } from "#shared/payment-state/words.ts";
import {
  LEGACY_SOURCES,
  RESOURCE_KIND_BY_PROVIDER,
} from "#shared/payment-state/words.ts";
/* jscpd:ignore-end */

/** A stored charge, in the shape the tables hold it. */
export type StoredCharge = {
  origin: RecordOrigin;
  provider: string | null;
  resourceKind: string | null;
  referenceIndex: string | null;
  capturedAmount: number | null;
  currency: string | null;
  refundedAmount: number | null;
  refundState: PaymentRefundState;
  pendingRefundId: string | null;
  pendingRefundIndex: string | null;
  pendingRefundIdempotencyKey: string | null;
  pendingRefundKeyIndex: string | null;
  providerRefundedAt: number | null;
  legacySource: string | null;
};

/**
 * Which refund handles a charge may hold, for where its refund has got to.
 *
 * A refund still going is the open one: it may have been started in the
 * provider's own dashboard, so we may hold neither handle for it.
 */
export const refundHandlesMatchState = (charge: StoredCharge): Fault => {
  const { pendingRefundId: id, pendingRefundIdempotencyKey: key } = charge;
  if (charge.refundState === "requested") {
    return present(id)
      ? "A refund only asked for cannot already name the provider's refund"
      : absent(key)
        ? "A refund asked for must keep the key that stops it being asked twice"
        : null;
  }
  if (charge.refundState === "pending") return null;
  if (charge.refundState === "failed") {
    return present(id)
      ? "A refund that failed cannot still name a refund in progress"
      : null;
  }
  return allAbsent([id, key])
    ? null
    : "A charge with no refund in progress cannot hold a refund's handles";
};

/** How much a charge says has gone back must agree with where its refund is. */
export const refundedTotalMatchesState = (charge: StoredCharge): Fault => {
  const { capturedAmount: taken, refundedAmount: back } = charge;
  if (taken === null || back === null) return null;
  return firstFault([
    [
      !["requested", "pending"].includes(charge.refundState) || back < taken,
      "A refund still being asked for cannot already claim everything taken",
    ],
    [
      charge.refundState !== "none" || back === 0,
      "A charge with no refund cannot have money already gone back",
    ],
    [
      charge.refundState !== "partial" || (back > 0 && back < taken),
      "A part refund must have given back some of the money, but not all",
    ],
    [
      charge.refundState !== "completed" || back === taken,
      "A finished refund must have given back everything taken",
    ],
    // A refund that failed may still have given part of the money back before
    // it stopped, so this only says it cannot have given back more than was
    // taken. The table says the same for every charge; saying it here too
    // means this rule answers on its own, without a table to lean on.
    [
      charge.refundState !== "failed" || back <= taken,
      "A refund that failed cannot have given back more than was taken",
    ],
  ]);
};

/** The six things a charge knows when the money was taken here — and knows
 *  none of when it was copied across. */
const whatMoneyTakenHereKnows = (charge: StoredCharge): unknown[] => [
  charge.provider,
  charge.resourceKind,
  charge.referenceIndex,
  charge.capturedAmount,
  charge.currency,
  charge.refundedAmount,
];

/** The handles a charge holds while a refund is in progress. */
const refundHandles = (charge: StoredCharge): unknown[] => [
  charge.pendingRefundId,
  charge.pendingRefundIndex,
  charge.pendingRefundIdempotencyKey,
  charge.pendingRefundKeyIndex,
];

/** Money copied across knows only that it happened. */
const moneyCopiedAcrossIsBare = (charge: StoredCharge): Fault =>
  firstFault([
    [
      allAbsent([...whatMoneyTakenHereKnows(charge), ...refundHandles(charge)]),
      "Money copied across knows only that it happened, nothing more",
    ],
    [
      charge.refundState === "unknown",
      "Money copied across never said what became of its refund",
    ],
    [
      LEGACY_SOURCES.some((source) => source === charge.legacySource),
      "Money copied across must say which old table it came from",
    ],
  ]);

/** Each provider names the money it took its own way, so a charge saying both
 *  a provider and a name has to say the pair that goes together. */
const kindMatchesProvider = (charge: StoredCharge): boolean =>
  Object.entries(RESOURCE_KIND_BY_PROVIDER).some(
    ([provider, kind]) =>
      provider === charge.provider && kind === charge.resourceKind,
  );

/** Money taken here knows everything about itself. */
const moneyTakenHereIsComplete = (charge: StoredCharge): Fault =>
  firstFault([
    [
      allAbsent([charge.legacySource, charge.providerRefundedAt]),
      "Money taken here cannot carry an old record's details",
    ],
    [
      whatMoneyTakenHereKnows(charge).every(present),
      "Money taken here knows who took it, how much, and how to find it again",
    ],
    [
      kindMatchesProvider(charge),
      "Money taken here must be named the way its own provider names it",
    ],
    [
      charge.refundState !== "unknown",
      `Only money copied across may say its refund is "unknown"`,
    ],
  ]);

/**
 * Money is money either side: a charge that took nothing is not a charge, and
 * money cannot go back in the wrong direction. Without this a stored -100
 * would quietly subtract from what a payment took and turn its refunds round.
 */
const theMoneyItselfMakesSense = (charge: StoredCharge): Fault =>
  firstFault([
    [
      charge.capturedAmount === null || charge.capturedAmount > 0,
      "Money taken must be at least a penny",
    ],
    [
      charge.refundedAmount === null || charge.refundedAmount >= 0,
      "Money gone back cannot be less than nothing",
    ],
  ]);

/** A charge is either money taken here or money copied across, never a mix. */
export const chargeKnowsWhereItCameFrom = (charge: StoredCharge): Fault =>
  firstOf(
    theMoneyItselfMakesSense(charge),
    charge.origin === "current"
      ? firstOf(
          moneyTakenHereIsComplete(charge),
          refundHandlesMatchState(charge),
          refundedTotalMatchesState(charge),
        )
      : moneyCopiedAcrossIsBare(charge),
  );
