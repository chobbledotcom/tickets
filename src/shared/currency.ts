/**
 * Currency formatting utilities
 *
 * Uses Intl.NumberFormat to format prices with correct decimal places
 * and currency symbols. Reads the currency code directly from settings.
 */

import { lazyRef } from "#fp";
import { settings } from "#shared/db/settings.ts";

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
  const places =
    new Intl.NumberFormat("en", {
      currency: code,
      style: "currency",
    }).resolvedOptions().minimumFractionDigits ?? 2;
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
 * e.g. formatCurrency(1050) → "£10.50" (when currency is GBP)
 */
export const formatCurrency = (minorUnits: number | string): string => {
  const { divisor, formatter } = currencyFormat(settings.currency);
  return formatter.format(Number(minorUnits) / divisor);
};

/**
 * Convert major units (decimal) to minor units (integer).
 * e.g. toMinorUnits(10.50) → 1050 (for GBP)
 */
export const toMinorUnits = (majorUnits: number): number => {
  const { divisor } = currencyFormat(settings.currency);
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
