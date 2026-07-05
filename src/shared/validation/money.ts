import * as v from "valibot";
import { getDecimalPlaces, toMinorUnits } from "#shared/currency.ts";
import { settings } from "#shared/db/settings.ts";

/**
 * Currency-aware money validation — the single source of truth for parsing a
 * money amount typed in MAJOR units (e.g. `"90.00"`) into safe-integer MINOR
 * units (pence/cents), rejecting anything the active currency can't represent.
 *
 * The key property the ad-hoc parsers lacked is that the accepted number of
 * decimal places is derived from `settings.currency` at parse time: GBP accepts
 * `1.00` but rejects `1.005` (3 dp) rather than silently rounding it to `101`
 * pence, and a zero-decimal currency (JPY) rejects `1.23` rather than truncating
 * to `1`. The ledger's `ledgerAmountSchema` first demonstrated this shape; this
 * module lifts it out so every money field can share one currency-aware
 * validator instead of re-deriving the rule (and its rounding bug) per field.
 *
 * Because the decimal places depend on the currency, the pattern is rebuilt
 * inside the `check`/`transform` callbacks on every parse (they read
 * `settings.currency` when they run), so the schemas can stay module constants —
 * exactly as `ledgerAmountPattern` does.
 *
 * The family spans two axes — **bound** (positive / non-negative / signed) and
 * **blank handling** (required vs optional, where blank ≠ zero for an optional
 * field). Pick the parser that matches the field:
 *
 * | Parser | Bound | Blank |
 * | --- | --- | --- |
 * | `parsePositiveMinorUnits`    | `> 0`  | invalid (`null`)  |
 * | `parseNonNegativeMinorUnits` | `>= 0` | `0`               |
 * | `parseOptionalMinorUnits`    | `>= 0` | unset (`null`)    |
 * | `parseSignedMinorUnits`      | any    | invalid (`null`)  |
 *
 * "Unset" (optional blank) is `null`, never a real `0` — the QR override and
 * day-price fields distinguish "no value" from a genuine £0.
 *
 * Mirrors the schema + `parseXxx` (null-on-invalid) convention of
 * validation/number.ts and validation/date.ts.
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

const parseWith = (
  schema:
    | typeof PositiveMoneySchema
    | typeof NonNegativeMoneySchema
    | typeof SignedMoneySchema,
  raw: string,
): number | null => {
  const result = v.safeParse(schema, raw);
  return result.success ? result.output : null;
};

/**
 * Parse a strictly positive money amount into positive minor units, or `null`
 * when `raw` is empty, non-numeric, carries more decimal places than the
 * currency allows, non-positive, non-finite, or rounds to a non-safe amount.
 * Use for amounts that must be non-zero (service costs, ledger entries).
 */
export const parsePositiveMinorUnits = (raw: string): number | null =>
  parseWith(PositiveMoneySchema, raw);

/**
 * Parse a **required** non-negative money amount into minor units. Blank ⇒ `0`
 * (the field's real value — a free listing / zero-threshold modifier), any other
 * invalid input ⇒ `null`. Use where an explicit zero is meaningful and a blank
 * means zero.
 */
export const parseNonNegativeMinorUnits = (raw: string): number | null =>
  raw.trim() === "" ? 0 : parseWith(NonNegativeMoneySchema, raw);

/**
 * Parse an **optional** non-negative money amount into minor units. Blank ⇒
 * `null` (unset — NOT a real `0`), a present value is validated as non-negative,
 * and any invalid input ⇒ `null`. Use for override fields that distinguish "no
 * value" from "£0" (QR price override, custom day prices).
 */
export const parseOptionalMinorUnits = (raw: string): number | null =>
  raw.trim() === "" ? null : parseWith(NonNegativeMoneySchema, raw);

/**
 * Parse a **signed** money amount into minor units (negatives and zero allowed),
 * or `null` when empty or invalid. Use for owner-correction targets where the
 * figure can legitimately be negative (a modifier's net revenue).
 */
export const parseSignedMinorUnits = (raw: string): number | null =>
  parseWith(SignedMoneySchema, raw);

/**
 * True when a numeric amount in MAJOR units carries more decimal places than the
 * active currency can represent — the value {@link toMinorUnits} would silently
 * round. The string parsers above reject over-precise input up front; use this
 * at a call site that only holds the already-parsed number (e.g. a modifier's
 * fixed `calc_value`, checked after `Number.parseFloat` alongside its kind).
 * `value` must be finite (round it through the currency's decimal places and
 * compare): `10.005` in GBP is over-precise, `10.01` is not.
 */
export const exceedsCurrencyPrecision = (value: number): boolean =>
  Number(value.toFixed(getDecimalPlaces(settings.currency))) !== value;

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
