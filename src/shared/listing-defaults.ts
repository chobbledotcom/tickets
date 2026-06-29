/**
 * Listing defaults — operator-set defaults that listings inherit live.
 *
 * The operator configures a default for any subset of the fields below on the
 * Listing Defaults settings page. A listing with `use_defaults` on inherits the
 * *currently configured* value of each set default at read time
 * ({@link resolveListingDefaults}), so changing a default in settings instantly
 * changes every "Use defaults" listing — the row's own stored value for a
 * defaulted field is ignored while the flag is on. A field with no configured
 * default is never overridden, so untouched defaults leave the listing alone.
 *
 * Inheritance is a single per-listing flag, never a per-field one: a per-field
 * "use default?" toggle would be ambiguous for a field whose own value is
 * `false`/empty (is that an override, or just unset?), so the whole set moves
 * together.
 *
 * This module is pure (storage parse/serialize + the overlay). Form parsing and
 * validation for the settings page live in the feature layer, which owns the
 * validators.
 */

import type { Listing } from "#shared/types.ts";

/**
 * The operator-configurable defaults. A key is present only when a default is
 * set for that field; an absent key means "no default — never override".
 */
export type ListingDefaults = {
  /** Always (`true`) / never (`false`) require logistics. */
  usesLogistics?: boolean;
  /** Days of the week daily listings are bookable on. */
  bookableDays?: string[];
  /** Minimum days' notice before a daily booking. */
  minimumDaysBefore?: number;
  /** Maximum days ahead a daily booking can be made. */
  maximumDaysAfter?: number;
  /** Booking webhook URL. */
  webhookUrl?: string;
  /** Post-purchase thank-you redirect URL. */
  thankYouUrl?: string;
  /** Whether listings are hidden from public listing pages. */
  hidden?: boolean;
};

/** A defaultable field's identity across storage, the form, and the CSS hide. */
export type ListingDefaultKind = "bool" | "number" | "url" | "days";

export type ListingDefaultField = {
  /** Key in {@link ListingDefaults}. */
  key: keyof ListingDefaults;
  /** Matching listing column / listing-form field name (snake_case). */
  field: keyof Listing;
  kind: ListingDefaultKind;
};

/**
 * Every defaultable field, in display order. The single source of truth that
 * drives the settings form, the form-field hiding (one CSS marker class per
 * key), the storage round-trip, and the overlay.
 *
 * Deliberately excludes `duration_days` and `customisable_days`. Both are
 * entangled with per-listing booking data and save-time invariants that live,
 * read-time inheritance can't honour: `customisable_days` requires a priced day
 * count within the duration, forbids `can_pay_more`, and must stay uniform
 * across a group (`validateGroupListingType`); `duration_days` feeds
 * parent/child edge compatibility (`durationsCompatible`) and existing bookings'
 * stored ranges. Inheriting either globally would silently produce listings the
 * normal save path would have rejected, so they stay per-listing. The remaining
 * fields are display / availability / side-effect only and inherit safely.
 */
export const LISTING_DEFAULT_FIELDS: readonly ListingDefaultField[] = [
  { field: "uses_logistics", key: "usesLogistics", kind: "bool" },
  { field: "bookable_days", key: "bookableDays", kind: "days" },
  { field: "minimum_days_before", key: "minimumDaysBefore", kind: "number" },
  { field: "maximum_days_after", key: "maximumDaysAfter", kind: "number" },
  { field: "webhook_url", key: "webhookUrl", kind: "url" },
  { field: "thank_you_url", key: "thankYouUrl", kind: "url" },
  { field: "hidden", key: "hidden", kind: "bool" },
] as const;

/** Whether any default at all is configured (drives the form toggle's presence). */
export const hasAnyListingDefault = (defaults: ListingDefaults): boolean =>
  LISTING_DEFAULT_FIELDS.some(({ key }) => defaults[key] !== undefined);

/** A kebab-case CSS marker class per defaulted field (e.g. `uses_logistics`
 * → `listing-form--default-uses-logistics`). */
export const listingDefaultFieldClass = (field: keyof Listing): string =>
  `listing-form--default-${String(field).replace(/_/g, "-")}`;

/**
 * The marker classes for a listing form, one per field that has a default set,
 * so CSS can hide each defaulted field while "Use defaults" is on.
 */
export const listingDefaultFormClasses = (defaults: ListingDefaults): string =>
  LISTING_DEFAULT_FIELDS.filter(({ key }) => defaults[key] !== undefined)
    .map(({ field }) => listingDefaultFieldClass(field))
    .join(" ");

/**
 * Resolve a listing's effective values: when `use_defaults` is on, overlay each
 * configured default onto a copy of the listing; otherwise return it unchanged.
 * Pure — the caller supplies the current defaults snapshot and whether the
 * logistics feature is enabled.
 *
 * Two overlaid fields are gated to keep the overlay from producing a listing the
 * normal save path would reject:
 * - `uses_logistics` is inert while the logistics feature is off, matching how a
 *   per-listing save can't set it when `hasLogistics` is off — so a listing
 *   created during a logistics-off window never silently becomes a logistics
 *   listing if the feature is later re-enabled.
 * - `hidden` never applies to a renewal tier (`months_per_unit > 0`), which must
 *   stay hidden + purchase-only (`validateRenewalConfig`); a global "Hidden = No"
 *   would otherwise make it visible and break renewal extension
 *   (`isQualifyingTierListing`).
 */
export const resolveListingDefaults = <T extends Listing>(
  listing: T,
  defaults: ListingDefaults,
  hasLogistics: boolean,
): T => {
  if (!listing.use_defaults) return listing;
  const overlay: Partial<Record<keyof Listing, unknown>> = {};
  for (const { key, field } of LISTING_DEFAULT_FIELDS) {
    const value = defaults[key];
    if (value !== undefined) overlay[field] = value;
  }
  if (!hasLogistics) delete overlay.uses_logistics;
  if (listing.months_per_unit > 0) delete overlay.hidden;
  return { ...listing, ...overlay };
};

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

/** Coerce one raw parsed value to the type its field expects, or undefined. */
const readDefaultValue = (
  kind: ListingDefaultKind,
  raw: unknown,
): boolean | number | string | string[] | undefined => {
  if (kind === "bool") return typeof raw === "boolean" ? raw : undefined;
  if (kind === "number") {
    return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
  }
  if (kind === "url") return typeof raw === "string" ? raw : undefined;
  return isStringArray(raw) ? raw : undefined;
};

/**
 * Parse the stored JSON blob into a {@link ListingDefaults}, keeping only known
 * keys with a value of the right type. Empty/blank/garbled input yields `{}`
 * (no defaults), so a bad row can never silently override listings.
 */
export const parseListingDefaults = (
  raw: string | undefined,
): ListingDefaults => {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null) return {};
  const source = parsed as Record<string, unknown>;
  const result: ListingDefaults = {};
  for (const { key, kind } of LISTING_DEFAULT_FIELDS) {
    if (!(key in source)) continue;
    const value = readDefaultValue(kind, source[key]);
    if (value !== undefined) {
      (result as Record<string, unknown>)[key] = value;
    }
  }
  return result;
};

/** Serialize defaults for storage (only set keys, stable field order). */
export const serializeListingDefaults = (defaults: ListingDefaults): string => {
  const result: Record<string, unknown> = {};
  for (const { key } of LISTING_DEFAULT_FIELDS) {
    const value = defaults[key];
    if (value !== undefined) result[key] = value;
  }
  return JSON.stringify(result);
};
