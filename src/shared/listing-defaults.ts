/**
 * Listing defaults — operator-set defaults that listings inherit live.
 *
 * The operator sets a default for any subset of the fields below on the Listing
 * Defaults page. A listing with `use_defaults` on inherits each set default's
 * *current* value at read time ({@link resolveListingDefaults}), so changing a
 * default instantly changes every "Use defaults" listing; the row's own value
 * for a defaulted field is ignored while the flag is on. A field with no
 * default is never touched.
 *
 * Inheritance is one per-listing flag, never per-field: a per-field "use
 * default?" toggle would be ambiguous for a field whose own value is
 * `false`/empty (an override, or just unset?), so the whole set moves together.
 *
 * This module is pure. Form parsing/validation lives in the feature layer.
 */

import type { Listing } from "#shared/types.ts";

/**
 * The operator-configurable defaults. A key is present only when a default is
 * set; an absent key means "no default — never override".
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

/** How a default is stored, validated, and rendered. */
export type ListingDefaultKind = "bool" | "number" | "url" | "days";

export type ListingDefaultField = {
  /** Key in {@link ListingDefaults}. */
  key: keyof ListingDefaults;
  /** Matching listing column / listing-form field name (snake_case). */
  field: keyof Listing;
  kind: ListingDefaultKind;
};

/**
 * Every defaultable field, in display order — the single source of truth for the
 * settings form, the form-field hiding, the storage round-trip, and the overlay.
 *
 * Deliberately excludes `duration_days` and `customisable_days`: both are tied
 * to per-listing booking data and save-time invariants that read-time
 * inheritance can't honour (customisable days needs a priced day count, forbids
 * pay-more, and must stay uniform across a group; duration feeds parent/child
 * edge compatibility and existing bookings' ranges). Inheriting either globally
 * would silently produce listings the normal save path would reject, so they
 * stay per-listing. The fields below are display/availability/side-effect only.
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

/** The HTML form input name for a field's default value. */
export const listingDefaultInputName = (field: ListingDefaultField): string =>
  `default_${field.field}`;

/** The i18n key for a field's label. */
export const listingDefaultLabelKey = (field: ListingDefaultField): string =>
  `listing_defaults.field.${field.field}.label`;

/** The i18n key for a field's hint. */
export const listingDefaultHintKey = (field: ListingDefaultField): string =>
  `listing_defaults.field.${field.field}.hint`;

/** A kebab-case CSS marker class per field (e.g. `uses_logistics` →
 * `listing-form--default-uses-logistics`). */
export const listingDefaultFieldClass = (field: keyof Listing): string =>
  `listing-form--default-${String(field).replace(/_/g, "-")}`;

/** The fields that currently have a default set, in display order. */
export const setListingDefaultFields = (
  defaults: ListingDefaults,
): ListingDefaultField[] =>
  LISTING_DEFAULT_FIELDS.filter(({ key }) => defaults[key] !== undefined);

/** Whether any default is configured (drives the form toggle's presence). */
export const hasAnyListingDefault = (defaults: ListingDefaults): boolean =>
  setListingDefaultFields(defaults).length > 0;

/** One marker class per set default, so CSS can hide each defaulted field while
 * "Use defaults" is on. */
export const listingDefaultFormClasses = (defaults: ListingDefaults): string =>
  setListingDefaultFields(defaults)
    .map(({ field }) => listingDefaultFieldClass(field))
    .join(" ");

/**
 * Resolve a listing's effective values: when `use_defaults` is on, overlay each
 * set default onto a copy of the listing; otherwise return it unchanged. Two
 * fields are gated so the overlay never produces a listing the save path rejects:
 * - `uses_logistics` is inert while logistics is off, matching the per-listing
 *   save gate — so a listing created during a logistics-off window can't
 *   silently become a logistics listing if the feature is re-enabled.
 * - `hidden` never applies to a renewal tier (`months_per_unit > 0`), which must
 *   stay hidden + purchase-only or renewal extension breaks.
 */
export const resolveListingDefaults = <T extends Listing>(
  listing: T,
  defaults: ListingDefaults,
  hasLogistics: boolean,
): T => {
  if (!listing.use_defaults) return listing;
  const overlay: Partial<Record<keyof Listing, unknown>> = {};
  for (const { key, field } of setListingDefaultFields(defaults)) {
    overlay[field] = defaults[key];
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

/** Parse JSON into a plain object, or null for blank/garbled/non-object input. */
const parseJsonObject = (
  raw: string | undefined,
): Record<string, unknown> | null => {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

/**
 * Parse the stored JSON blob into a {@link ListingDefaults}, keeping only known
 * keys with a value of the right type. Bad input yields `{}` so a corrupt row
 * can never silently override listings.
 */
export const parseListingDefaults = (
  raw: string | undefined,
): ListingDefaults => {
  const source = parseJsonObject(raw);
  if (!source) return {};
  const result: Record<string, unknown> = {};
  for (const { key, kind } of LISTING_DEFAULT_FIELDS) {
    if (!(key in source)) continue;
    const value = readDefaultValue(kind, source[key]);
    if (value !== undefined) result[key] = value;
  }
  return result;
};

/** Serialize defaults for storage (only set keys, stable field order). */
export const serializeListingDefaults = (defaults: ListingDefaults): string =>
  JSON.stringify(
    Object.fromEntries(
      setListingDefaultFields(defaults).map(({ key }) => [key, defaults[key]]),
    ),
  );
