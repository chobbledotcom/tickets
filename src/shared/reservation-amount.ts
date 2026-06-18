/**
 * The reservation-amount mini-language.
 *
 * Owners set a per-status `reservation_amount` string that determines the
 * deposit a public reservation pays up front. Three forms are supported:
 *
 *   "10%"  → 10% of the full order total
 *   "10"   → 10 currency units (NOT minor units) for the whole order
 *   "10x"  → 10 currency units per item booked (× total quantity)
 *
 * `"0"` is valid (no deposit — reserve now, pay the full balance later) and is
 * the default. Decimals are allowed (e.g. "33.33%", "10.50"). The value is
 * validated before it is stored, so the calculation path can assume it parses.
 */

import { sum, sumOf } from "#fp";
import { toMinorUnits } from "#shared/currency.ts";
import { largestRemainderIndexes } from "#shared/largest-remainder.ts";

/** A parsed reservation amount. `value` is the bare number (not minor units). */
export type ReservationAmount =
  | { kind: "percent"; value: number }
  | { kind: "flat"; value: number }
  | { kind: "perItem"; value: number };

const RESERVATION_AMOUNT_RE = /^(\d+(?:\.\d+)?)(%|x)?$/;

/** Human-readable hint shown when validation fails. */
export const RESERVATION_AMOUNT_HINT =
  "Enter an amount like 10 (currency units), 10% (of the total) or 10x (per item)";

/**
 * Parse a reservation-amount string into its kind and numeric value, or null
 * when the string is malformed.
 */
export const parseReservationAmount = (
  raw: string,
): ReservationAmount | null => {
  const match = RESERVATION_AMOUNT_RE.exec(raw.trim());
  if (!match) return null;
  // match[1] is `\d+(\.\d+)?`, so this always parses to a finite number.
  const value = Number.parseFloat(match[1]!);
  if (match[2] === "%") return { kind: "percent", value };
  if (match[2] === "x") return { kind: "perItem", value };
  return { kind: "flat", value };
};

/**
 * Validate a reservation-amount string for form input. Returns an error
 * message, or null when valid. Empty input is rejected — the field must be
 * filled in (use "0" for no deposit).
 */
export const validateReservationAmount = (raw: string): string | null =>
  parseReservationAmount(raw) === null ? RESERVATION_AMOUNT_HINT : null;

/**
 * Parse `raw`, turn the parsed amount into a deposit via `fromParsed`, and
 * clamp the result to [0, max]. A malformed amount yields 0. Shared by the
 * order-level and per-unit calculations so the parse/guard/clamp lives once.
 */
const clampedDeposit = (
  raw: string,
  max: number,
  fromParsed: (parsed: ReservationAmount) => number,
): number => {
  const parsed = parseReservationAmount(raw);
  if (!parsed) return 0;
  return Math.max(0, Math.min(fromParsed(parsed), max));
};

/**
 * Compute the deposit (in minor units) a reservation should pay up front,
 * given the full order price (minor units) and the total quantity of items.
 * The result is clamped to [0, fullPriceMinor] — a deposit never exceeds the
 * full price, and a malformed amount yields 0.
 */
export const computeReservationDeposit = (
  raw: string,
  fullPriceMinor: number,
  totalQuantity: number,
): number =>
  clampedDeposit(raw, fullPriceMinor, (parsed) =>
    parsed.kind === "percent"
      ? Math.round((fullPriceMinor * parsed.value) / 100)
      : parsed.kind === "perItem"
        ? toMinorUnits(parsed.value) * totalQuantity
        : toMinorUnits(parsed.value),
  );

export type ReservationAllocationItem = {
  unitPrice: number;
  quantity: number;
};

export type ReservationAllocatedLine = {
  itemIndex: number;
  chargedUnitAmount: number;
  quantity: number;
};

export type ReservationDepositAllocation = {
  lines: ReservationAllocatedLine[];
  perItemTotals: number[];
  total: number;
};

type AllocationUnit = {
  itemIndex: number;
  capacity: number;
  originalIndex: number;
};

/**
 * Allocate an order-level reservation deposit exactly across individual ticket
 * units. The intended total still comes from `computeReservationDeposit`; this
 * helper only decides where each minor unit lands. Allocation is proportional
 * to unit price, floors fractional shares, then assigns leftover minor units to
 * the largest remainders with cart order as the stable tie-breaker.
 */
export const allocateReservationDeposit = (
  raw: string,
  items: ReadonlyArray<ReservationAllocationItem>,
): ReservationDepositAllocation => {
  const perItemTotals = Array.from({ length: items.length }, () => 0);
  const units: AllocationUnit[] = items.flatMap((item, itemIndex) =>
    Array.from({ length: Math.max(0, item.quantity) }, (_, unitIndex) => ({
      capacity: Math.max(0, item.unitPrice),
      itemIndex,
      originalIndex:
        sumOf((i: ReservationAllocationItem) => Math.max(0, i.quantity))(
          items.slice(0, itemIndex),
        ) + unitIndex,
    })),
  );
  const fullSubtotal = sumOf((unit: AllocationUnit) => unit.capacity)(units);
  const total = computeReservationDeposit(raw, fullSubtotal, units.length);
  if (units.length === 0) {
    return { lines: [], perItemTotals, total };
  }
  const allocations =
    total === 0 || fullSubtotal === 0
      ? units.map(() => 0)
      : total === fullSubtotal
        ? units.map((unit) => unit.capacity)
        : allocateProportionally(units, total);
  const lineKey = (itemIndex: number, amount: number) =>
    `${itemIndex}:${amount}`;
  const grouped = new Map<
    string,
    { itemIndex: number; chargedUnitAmount: number; quantity: number }
  >();
  for (const [index, amount] of allocations.entries()) {
    const unit = units[index]!;
    perItemTotals[unit.itemIndex] = perItemTotals[unit.itemIndex]! + amount;
    const key = lineKey(unit.itemIndex, amount);
    const existing = grouped.get(key);
    if (existing) {
      existing.quantity += 1;
    } else {
      grouped.set(key, {
        chargedUnitAmount: amount,
        itemIndex: unit.itemIndex,
        quantity: 1,
      });
    }
  }
  return {
    lines: [...grouped.values()].sort(
      (a, b) =>
        a.itemIndex - b.itemIndex || b.chargedUnitAmount - a.chargedUnitAmount,
    ),
    perItemTotals,
    total: sum(allocations),
  };
};

const allocateProportionally = (
  units: AllocationUnit[],
  total: number,
): number[] => {
  const fullSubtotal = sumOf((unit: AllocationUnit) => unit.capacity)(units);
  const shares = units.map((unit) => (total * unit.capacity) / fullSubtotal);
  const floors = shares.map((share) => Math.floor(share));
  const leftover = total - sum(floors);
  const bumped = largestRemainderIndexes(shares, leftover, {
    canReceive: (index) => floors[index]! < units[index]!.capacity,
    tieBreaker: (index) => units[index]!.originalIndex,
  });
  return floors.map((amount, i) => amount + (bumped.has(i) ? 1 : 0));
};
