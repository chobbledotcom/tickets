/**
 * Currency formatting utilities
 *
 * Uses Intl.NumberFormat to format prices with correct decimal places
 * and currency symbols. Reads the currency code directly from settings.
 */

import { Liquid } from "liquidjs";
import { settings } from "#shared/db/settings.ts";

/** Get the number of decimal places for a currency code */
export const getDecimalPlaces = (currencyCode: string): number =>
  new Intl.NumberFormat("en", {
    currency: currencyCode,
    style: "currency",
  }).resolvedOptions().minimumFractionDigits ?? 2;

/**
 * Format an amount in minor units (pence/cents) as a currency string.
 * e.g. formatCurrency(1050) → "£10.50" (when currency is GBP)
 */
export const formatCurrency = (minorUnits: number | string): string => {
  const code = settings.currency;
  const places = getDecimalPlaces(code);
  const divisor = 10 ** places;
  return new Intl.NumberFormat("en", {
    currency: code,
    style: "currency",
    trailingZeroDisplay: "stripIfInteger",
  }).format(Number(minorUnits) / divisor);
};

/**
 * Convert major units (decimal) to minor units (integer).
 * e.g. toMinorUnits(10.50) → 1050 (for GBP)
 */
export const toMinorUnits = (majorUnits: number): number => {
  const places = getDecimalPlaces(settings.currency);
  return Math.round(majorUnits * 10 ** places);
};

/**
 * Convert minor units to major units string for form display.
 * e.g. toMajorUnits(1050) → "10.50" (for GBP)
 */
export const toMajorUnits = (minorUnits: number): string => {
  const places = getDecimalPlaces(settings.currency);
  return (minorUnits / 10 ** places).toFixed(places);
};

/** Create a Liquid engine pre-configured with strict mode and the currency filter */
export const createBaseLiquidEngine = (): Liquid => {
  const engine = new Liquid({ strictFilters: true, strictVariables: false });
  engine.registerFilter("currency", (v: string | number) => formatCurrency(v));
  return engine;
};
