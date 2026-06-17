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

import { toMinorUnits } from "#shared/currency.ts";

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

/**
 * The per-unit deposit (minor units) for one listing line of a reservation —
 * the price each ticket is charged up front. Computed identically at checkout
 * (to set the charged amount) and in the webhook (to validate it), so the two
 * always agree. A flat order amount is spread evenly across all items.
 * Clamped to [0, unitPrice] so a deposit never exceeds the ticket price.
 */
export const reservationDepositPerUnit = (
  raw: string,
  unitPrice: number,
  totalQuantity: number,
): number =>
  clampedDeposit(raw, unitPrice, (parsed) =>
    parsed.kind === "percent"
      ? Math.round((unitPrice * parsed.value) / 100)
      : parsed.kind === "perItem"
        ? toMinorUnits(parsed.value)
        : Math.round(toMinorUnits(parsed.value) / Math.max(1, totalQuantity)),
  );
