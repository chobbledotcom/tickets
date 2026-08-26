/* jscpd:ignore-start */
import * as v from "valibot";
import { settings } from "#db/settings.ts";
import { getDecimalPlaces, toMinorUnits } from "#shared/currency.ts";
import { parseOrNull } from "./parse.ts";

/* jscpd:ignore-end */

/**
 * Currency-aware money validation — the one place a major-unit amount like
 * `"90.00"` becomes safe-integer minor units. The decimal places come from
 * `settings.currency` at parse time: GBP rejects `1.005` rather than rounds it
 * to 101 pence, and JPY rejects `1.23` rather than truncates to 1. Because that
 * depends on the currency, the pattern is rebuilt inside the callbacks on every
 * parse, so the schemas stay constants. Pick the parser matching the field's
 * bound and its treatment of a blank, where a blank is `null`, never a real `0`:
 *
 * | Parser | Bound | Blank |
 * | --- | --- | --- |
 * | `parsePositiveMinorUnits`    | `> 0`  | invalid (`null`)  |
 * | `parseNonNegativeMinorUnits` | `>= 0` | `0`               |
 * | `parseOptionalMinorUnits`    | `>= 0` | unset (`null`)    |
 * | `parseSignedMinorUnits`      | any    | invalid (`null`)  |
 */

/** Decimal-string pattern for the active currency: `\d+` with up to
 *  `getDecimalPlaces` fractional digits (none for a zero-decimal currency). The
 *  signed form additionally allows a leading `-`. */
const currencyDecimalPattern = (signed: boolean): RegExp => {
  const places = getDecimalPlaces(settings.currency);
  const sign = signed ? "-?" : "";
  const frac = places === 0 ? "" : `(?:\\.\\d{1,${places}})?`;
  return new RegExp(`^${sign}\\d+${frac}$`);
};

/** Core money pipeline up to the safe-integer minor-unit value (no bound). */
const baseMoneySchema = (signed: boolean) =>
  v.pipe(
    v.string(),
    v.trim(),
    v.nonEmpty(),
    v.check((amount: string) => currencyDecimalPattern(signed).test(amount)),
    v.transform(Number),
    v.finite(),
    v.transform(toMinorUnits),
    v.safeInteger(),
  );

const PositiveMoneySchema = v.pipe(baseMoneySchema(false), v.minValue(1));
const NonNegativeMoneySchema = v.pipe(baseMoneySchema(false), v.minValue(0));
const SignedMoneySchema = baseMoneySchema(true);

/**
 * Parse a strictly positive money amount into positive minor units, or `null`
 * when `raw` is empty, non-numeric, carries more decimal places than the
 * currency allows, non-positive, non-finite, or rounds to a non-safe amount.
 * Use for amounts that must be non-zero (service costs, ledger entries).
 */
export const parsePositiveMinorUnits = (raw: string): number | null =>
  parseOrNull(PositiveMoneySchema, raw);

/**
 * Non-negative money parser whose result for a blank input is chosen by the
 * caller: a required field treats blank as a real `0`, an optional field treats
 * blank as unset (`null`). A present value is validated as non-negative either
 * way, and any invalid input is `null`.
 */
const nonNegativeMinorUnitsOr =
  (whenBlank: number | null) =>
  (raw: string): number | null =>
    raw.trim() === "" ? whenBlank : parseOrNull(NonNegativeMoneySchema, raw);

/**
 * Parse a **required** non-negative money amount into minor units. Blank ⇒ `0`
 * (the field's real value — a free listing / zero-threshold modifier), any other
 * invalid input ⇒ `null`. Use where an explicit zero is meaningful and a blank
 * means zero.
 */
export const parseNonNegativeMinorUnits = nonNegativeMinorUnitsOr(0);

/**
 * Parse an **optional** non-negative money amount into minor units. Blank ⇒
 * `null` (unset — NOT a real `0`), a present value is validated as non-negative,
 * and any invalid input ⇒ `null`. Use for override fields that distinguish "no
 * value" from "£0" (QR price override, custom day prices).
 */
export const parseOptionalMinorUnits = nonNegativeMinorUnitsOr(null);

/**
 * Parse a **signed** money amount into minor units (negatives and zero allowed),
 * or `null` when empty or invalid. Use for owner-correction targets where the
 * figure can legitimately be negative (a modifier's net revenue).
 */
export const parseSignedMinorUnits = (raw: string): number | null =>
  parseOrNull(SignedMoneySchema, raw);

/**
 * True when a numeric amount in MAJOR units carries more decimal places than
 * the currency can represent — the value {@link toMinorUnits} would silently
 * round. The string parsers above reject over-precise input up front; use this
 * at a call site that only holds the already-parsed number (e.g. a modifier's
 * fixed `calc_value`, checked after `Number.parseFloat` alongside its kind).
 * `value` must be finite (round it through the currency's decimal places and
 * compare): `10.005` in GBP is over-precise, `10.01` is not. `currency`
 * defaults to the site's currency; a charge taken in another currency passes
 * that currency so the precision check matches it.
 */
export const exceedsCurrencyPrecision = (
  value: number,
  currency: string = settings.currency,
): boolean => Number(value.toFixed(getDecimalPlaces(currency))) !== value;

/** Result of validating a public/QR price against a min/max bound. */
export type PriceResult =
  | { ok: true; price: number }
  | { ok: false; error: string };

/**
 * Validate and convert a raw price string (major units) to minor units against a
 * `[minPrice, maxPrice]` bound. A blank value is `0` when `minPrice` is 0
 * (pay-what-you-want with no input) and an error otherwise. A present value is
 * parsed currency-aware — a prefix (`"12abc"`), a comma group (`"1,000"`), or
 * more decimals than the currency allows is rejected rather than silently
 * coerced/rounded. Lives here (not currency.ts) so it can reuse the shared
 * non-negative parser without a currency ⇄ money import cycle.
 */
export const validatePrice = (
  raw: string,
  minPrice: number,
  maxPrice: number,
): PriceResult => {
  if (!raw) {
    return minPrice === 0
      ? { ok: true, price: 0 }
      : { error: "Please enter a price", ok: false };
  }
  const priceMinor = parseNonNegativeMinorUnits(raw);
  if (priceMinor === null) {
    return { error: "Please enter a valid price", ok: false };
  }
  if (priceMinor < minPrice) {
    return {
      error: "Price must be at least the minimum ticket price",
      ok: false,
    };
  }
  if (priceMinor > maxPrice) {
    return { error: "Price exceeds the maximum allowed", ok: false };
  }
  return { ok: true, price: priceMinor };
};
