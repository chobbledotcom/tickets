/**
 * Currency formatting utilities
 *
 * Uses Intl.NumberFormat to format prices with correct decimal places
 * and currency symbols. The currency code is loaded once from the
 * database and cached permanently (it's a sitewide setting).
 */

import { lazyRef } from "#fp";
import { getCurrencyCode } from "#lib/config.ts";

const [getCachedCode, setCachedCode] = lazyRef<string | null>(() => null);

/**
 * Load currency code from database and cache permanently.
 * Safe to call multiple times — only the first call hits the DB.
 */
export const loadCurrencyCode = async (): Promise<string> => {
  const cached = getCachedCode();
  if (cached !== null) return cached;
  const code = await getCurrencyCode();
  setCachedCode(code);
  return code;
};

/** Get the cached currency code, falling back to GBP if not yet loaded */
const code = (): string => getCachedCode() ?? "GBP";

/** Get the number of decimal places for a currency code */
export const getDecimalPlaces = (currencyCode: string): number =>
  new Intl.NumberFormat("en", { style: "currency", currency: currencyCode })
    .resolvedOptions().minimumFractionDigits;

/**
 * Format an amount in minor units (pence/cents) as a currency string.
 * e.g. formatCurrency(1050) → "£10.50" (when currency is GBP)
 */
export const formatCurrency = (minorUnits: number | string): string => {
  const c = code();
  const places = getDecimalPlaces(c);
  const divisor = 10 ** places;
  return new Intl.NumberFormat("en", { style: "currency", currency: c })
    .format(Number(minorUnits) / divisor);
};

/**
 * Convert major units (decimal) to minor units (integer).
 * e.g. toMinorUnits(10.50) → 1050 (for GBP)
 */
export const toMinorUnits = (majorUnits: number): number => {
  const places = getDecimalPlaces(code());
  return Math.round(majorUnits * (10 ** places));
};

/**
 * Convert minor units to major units string for form display.
 * e.g. toMajorUnits(1050) → "10.50" (for GBP)
 */
export const toMajorUnits = (minorUnits: number): string => {
  const c = code();
  const places = getDecimalPlaces(c);
  return (minorUnits / (10 ** places)).toFixed(places);
};

/** For testing: set the cached currency code directly */
export const setCurrencyCodeForTest = (c: string): void => {
  setCachedCode(c);
};

/** For testing: reset the cached currency code */
export const resetCurrencyCode = (): void => {
  setCachedCode(null);
};
