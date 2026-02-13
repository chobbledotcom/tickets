/**
 * Currency formatting utilities
 *
 * Uses Intl.NumberFormat to format prices with correct decimal places
 * and currency symbols. The currency code is loaded from settings
 * (already cached by the settings module) and stored for sync access
 * by JSX templates.
 */

import { getCurrencyCode } from "#lib/config.ts";

/** Sync-accessible currency code, populated by loadCurrencyCode() */
const state = { code: "GBP" };

/**
 * Load currency code from settings into sync-accessible state.
 * Called once per request in routes/index.ts before templates render.
 * Settings are already cached so this is cheap on repeat calls.
 */
export const loadCurrencyCode = async (): Promise<string> => {
  state.code = await getCurrencyCode();
  return state.code;
};

/** Get the number of decimal places for a currency code */
export const getDecimalPlaces = (currencyCode: string): number =>
  new Intl.NumberFormat("en", { style: "currency", currency: currencyCode })
    .resolvedOptions().minimumFractionDigits;

/**
 * Format an amount in minor units (pence/cents) as a currency string.
 * e.g. formatCurrency(1050) → "£10.50" (when currency is GBP)
 */
export const formatCurrency = (minorUnits: number | string): string => {
  const places = getDecimalPlaces(state.code);
  const divisor = 10 ** places;
  return new Intl.NumberFormat("en", { style: "currency", currency: state.code })
    .format(Number(minorUnits) / divisor);
};

/**
 * Convert major units (decimal) to minor units (integer).
 * e.g. toMinorUnits(10.50) → 1050 (for GBP)
 */
export const toMinorUnits = (majorUnits: number): number => {
  const places = getDecimalPlaces(state.code);
  return Math.round(majorUnits * (10 ** places));
};

/**
 * Convert minor units to major units string for form display.
 * e.g. toMajorUnits(1050) → "10.50" (for GBP)
 */
export const toMajorUnits = (minorUnits: number): string => {
  const places = getDecimalPlaces(state.code);
  return (minorUnits / (10 ** places)).toFixed(places);
};

/** For testing: set the currency code directly */
export const setCurrencyCodeForTest = (c: string): void => {
  state.code = c;
};

/** For testing: reset the currency code to default */
export const resetCurrencyCode = (): void => {
  state.code = "GBP";
};
