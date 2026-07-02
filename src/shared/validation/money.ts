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
 * `settings.currency` when they run), so the schema itself can stay a module
 * constant — exactly as `ledgerAmountPattern` does.
 *
 * Mirrors the schema + `parseXxx` (null-on-invalid) convention of
 * validation/number.ts and validation/date.ts.
 */

/** Decimal-string pattern for the active currency: `\d+` with up to
 *  `getDecimalPlaces` fractional digits (none for a zero-decimal currency). */
const currencyDecimalPattern = (): RegExp => {
  const places = getDecimalPlaces(settings.currency);
  return places === 0 ? /^\d+$/ : new RegExp(`^\\d+(?:\\.\\d{1,${places}})?$`);
};

/** Core money schema: a trimmed, non-empty, currency-decimal-valid major-unit
 *  string coerced to safe-integer minor units bounded below by `min`. */
const moneyMinorSchema = (min: number) =>
  v.pipe(
    v.string(),
    v.trim(),
    v.nonEmpty(),
    v.check((amount: string) => currencyDecimalPattern().test(amount)),
    v.transform(Number),
    v.finite(),
    v.transform(toMinorUnits),
    v.safeInteger(),
    v.minValue(min),
  );

const PositiveMoneySchema = moneyMinorSchema(1);

/**
 * Parse a strictly positive money amount in major units into positive minor
 * units, or `null` when `raw` is empty, non-numeric, carries more decimal places
 * than the currency allows, non-positive, non-finite, or rounds to a non-safe
 * amount of minor units. Used by routes that take a positive money amount from a
 * form (service costs) so an invalid value becomes a form error rather than a
 * silently-rounded or 500-ing ledger post.
 */
export const parsePositiveMinorUnits = (raw: string): number | null => {
  const result = v.safeParse(PositiveMoneySchema, raw);
  return result.success ? result.output : null;
};
