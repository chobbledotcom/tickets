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

/**
 * Parse a non-negative money amount in major units (e.g. `"0"`, `"90.00"`) into
 * minor units, or `null` when `raw` is empty, non-numeric, or rounds to a
 * non-safe-integer amount. An explicit `0` is a valid result (not `null`); the
 * `^\d+` shape already excludes negatives and non-finite values. Used by callers
 * that accept zero as a real value (a package member can be free) and by
 * {@link parsePositiveMinorUnits} for the positive-only case.
 */
export const parseNonNegativeMinorUnits = (raw: string): number | null => {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Reject inputs with any non-numeric characters (commas, letters, etc.) so
  // "1,000" doesn't silently parse as 1. The whole string must be a non-negative
  // decimal, unlike parseFloat which accepts a leading-numeric prefix.
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const amount = toMinorUnits(Number(trimmed));
  return Number.isSafeInteger(amount) && amount >= 0 ? amount : null;
};

/**
 * Parse a strictly positive money amount in major units (e.g. `"90.00"`) into
 * positive minor units, or `null` when `raw` is empty, non-numeric,
 * non-positive, non-finite, or rounds to a non-safe-integer amount of minor
 * units. Mirrors {@link parsePositiveIntId}'s null-on-invalid convention; the
 * caller supplies the user-facing message. Used by routes that take a positive
 * money amount from a form (service costs) so an invalid/empty/negative value
 * becomes a form error rather than a 500 from the ledger.
 */
export const parsePositiveMinorUnits = (raw: string): number | null => {
  const amount = parseNonNegativeMinorUnits(raw);
  return amount !== null && amount > 0 ? amount : null;
};

/** Result type for price validation */
export type PriceResult =
  | { ok: true; price: number }
  | { ok: false; error: string };

/**
 * Validate and convert a raw price string to minor units.
 * Returns ok with 0 if raw is empty and minPrice is 0 (pay-what-you-want with no input).
 * Returns error if raw is empty and minPrice > 0, or if parsed value is out of range.
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
  const parsed = Number.parseFloat(raw);
  if (Number.isNaN(parsed) || parsed < 0) {
    return { error: "Please enter a valid price", ok: false };
  }
  const priceMinor = toMinorUnits(parsed);
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

/** Create a Liquid engine pre-configured with strict mode and the currency filter */
export const createBaseLiquidEngine = (): Liquid => {
  const engine = new Liquid({ strictFilters: true, strictVariables: false });
  engine.registerFilter("currency", (v: string | number) => formatCurrency(v));
  return engine;
};
