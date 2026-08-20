/**
 * A money-amount `<input>` whose browser metadata tracks the active currency.
 *
 * The site has exactly one currency (fixed at setup), so a price field should
 * derive its `step` from that currency rather than hard-coding two decimals:
 * `0.01` for a 2-decimal currency, `1` for a zero-decimal one (JPY, so cents
 * aren't offered), `0.001` for a 3-decimal one (KWD, so a valid `1.005` can
 * actually be typed). This is the browser-side twin of the shared server
 * validator in `validation/money.ts` — the two must accept the same amounts, so
 * they read the decimal places from the same `settings.currency`. Use this
 * component for every price/amount field instead of a bare
 * `<input step="0.01" type="number">`.
 */

import { settings } from "#db/settings.ts";
import type { SafeHtml } from "#jsx/jsx-runtime.ts";
import { getDecimalPlaces } from "#shared/currency.ts";

/** How many decimal places the active currency uses (0 for JPY, 2 for most). */
const currencyPlaces = (): number => getDecimalPlaces(settings.currency);

/** Build a currency-derived string: use `zeroDecimal` when the active currency
 *  has no fractional digits, otherwise build it from the place count. Shared by
 *  the money `<input>`'s step and pattern so both read the places the same way. */
const byCurrencyPlaces =
  (zeroDecimal: string, withPlaces: (places: number) => string) =>
  (): string => {
    const places = currencyPlaces();
    return places === 0 ? zeroDecimal : withPlaces(places);
  };

/** The `<input step>` for the active currency (see the module comment). */
export const moneyStep = byCurrencyPlaces(
  "1",
  (places) => `0.${"0".repeat(places - 1)}1`,
);

/** The `<input pattern>` (regex source) for a non-negative amount in the active
 *  currency: `\d+` with up to `getDecimalPlaces` fractional digits (none for a
 *  zero-decimal currency). Use on a `type="text"` money input so native
 *  validation accepts exactly what the shared money schema does. */
export const moneyPattern = byCurrencyPlaces(
  "\\d+",
  (places) => `\\d+(\\.\\d{1,${places}})?`,
);

/**
 * A price/amount input in MAJOR units (e.g. `10.50`). `step` is always derived
 * from the currency; pass `min` for a lower bound (`"0"` for a non-negative
 * field, omit for a signed one), `required` to make it mandatory, and `id` to
 * pair it with a `<label for>`.
 */
export const PriceInput = ({
  id,
  name,
  value,
  min,
  required,
}: {
  id?: string;
  name: string;
  value?: string | number;
  min?: string | number;
  required?: boolean;
}): SafeHtml => (
  <input
    id={id}
    inputmode="decimal"
    min={min === undefined ? undefined : String(min)}
    name={name}
    required={required}
    step={moneyStep()}
    type="number"
    value={value === undefined ? undefined : String(value)}
  />
);
