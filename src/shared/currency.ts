/**
 * Currency formatting utilities
 *
 * Uses Intl.NumberFormat to format prices with correct decimal places
 * and currency symbols. Reads the currency code directly from settings.
 */

import { settings } from "#db/settings.ts";
import { lazyRef } from "#fp";

type CurrencyFormat = {
  code: string;
  divisor: number;
  formatter: Intl.NumberFormat;
  places: number;
};

const [getCachedCurrencyFormat, setCachedCurrencyFormat] =
  lazyRef<CurrencyFormat | null>(() => null);

const currencyFormat = (code: string): CurrencyFormat => {
  const cached = getCachedCurrencyFormat();
  if (cached?.code === code) return cached;
  const places = new Intl.NumberFormat("en", {
    currency: code,
    style: "currency",
  }).resolvedOptions().minimumFractionDigits;
  if (places === undefined) {
    throw new Error(`Intl omitted currency decimal places for ${code}`);
  }
  const format = {
    code,
    divisor: 10 ** places,
    formatter: new Intl.NumberFormat("en", {
      currency: code,
      style: "currency",
      trailingZeroDisplay: "stripIfInteger",
    }),
    places,
  };
  setCachedCurrencyFormat(format);
  return format;
};

/** Get the number of decimal places for a currency code */
export const getDecimalPlaces = (currencyCode: string): number =>
  currencyFormat(currencyCode).places;

/**
 * Format an amount in minor units (pence/cents) as a currency string.
 * e.g. formatCurrency(1050) → "£10.50" (when the site currency is GBP).
 * A stored provider amount passes its own currency so the symbol and minor-unit
 * divisor describe that charge rather than today's site setting.
 */
export const formatCurrency = (
  minorUnits: number | string,
  currency: string = settings.currency,
): string => {
  const { divisor, formatter } = currencyFormat(currency);
  return formatter.format(Number(minorUnits) / divisor);
};

/** Format a signed change in minor units. Positive value is added, negative
 * value is removed, and zero has no misleading sign. */
export const formatSignedCurrency = (
  minorUnits: number,
  showPositive = true,
): string =>
  minorUnits === 0
    ? formatCurrency(0)
    : `${minorUnits < 0 ? "\u2212" : showPositive ? "+" : ""}${formatCurrency(
        Math.abs(minorUnits),
      )}`;

/**
 * Convert major units (decimal) to minor units (integer).
 * e.g. toMinorUnits(10.50) → 1050 (for GBP)
 * `currency` defaults to the site's currency; a caller converting a charge
 * taken in another currency passes that currency so the divisor matches it.
 */
export const toMinorUnits = (
  majorUnits: number,
  currency: string = settings.currency,
): number => {
  const { divisor } = currencyFormat(currency);
  return Math.round(majorUnits * divisor);
};

/**
 * Convert minor units to major units string for form display.
 * e.g. toMajorUnits(1050) → "10.50" (for GBP)
 */
export const toMajorUnits = (minorUnits: number): string => {
  const { divisor, places } = currencyFormat(settings.currency);
  return (minorUnits / divisor).toFixed(places);
};
