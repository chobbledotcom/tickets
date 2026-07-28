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

import * as v from "valibot";
import { VALID_DAY_NAMES } from "#shared/day-names.ts";
import type { Listing } from "#shared/types.ts";
import { integerAtLeast } from "#shared/validation/number.ts";
import { defineStoredJson } from "#shared/validation/stored-json.ts";

/**
 * The operator-configurable defaults. A key is present only when a default is
 * set; an absent key means "no default — never override".
 */
export const ListingDefaultsSchema = v.strictObject({
  bookableDays: v.optional(v.array(v.picklist(VALID_DAY_NAMES))),
  hidden: v.optional(v.boolean()),
  maximumDaysAfter: v.optional(integerAtLeast(0)),
  minimumDaysBefore: v.optional(integerAtLeast(0)),
  thankYouUrl: v.optional(v.string()),
  usesLogistics: v.optional(v.boolean()),
  webhookUrl: v.optional(v.string()),
});
export type ListingDefaults = v.InferOutput<typeof ListingDefaultsSchema>;
const listingDefaultsJson = defineStoredJson(ListingDefaultsSchema);

/** How a default is stored, validated, and rendered. */
export type ListingDefaultKind = "bool" | "number" | "url" | "days";

/** What {@link resolveListingDefaults} knows beyond the listing being resolved. */
export type ResolveContext = { hasLogistics: boolean };

/**
 * A row the overlay can resolve: it must carry the inheritance flag, and it
 * inherits whichever defaultable fields it actually selected. A narrow read
 * that selects only some of them gets only those overlaid — see
 * {@link resolveListingDefaults}.
 */
export type ResolvableListing = Partial<Listing> & { use_defaults: boolean };

export type ListingDefaultField = {
  /** Key in {@link ListingDefaults}. */
  key: keyof ListingDefaults;
  /** Matching listing column / listing-form field name (snake_case). */
  field: keyof Listing;
  kind: ListingDefaultKind;
  /**
   * When present, the default only overlays a listing for which this returns
   * true — the schema-level home for a per-field invariant the overlay must not
   * break, so {@link resolveListingDefaults} stays a plain fold with no
   * special-cased branches. Absent ⇒ the default always applies.
   */
  appliesTo?: (listing: ResolvableListing, ctx: ResolveContext) => boolean;
  /** The other fields {@link appliesTo} reads. A row carrying this field must
   * carry these too — {@link resolveListingDefaults} throws rather than judge
   * the gate on values that are not there. */
  gateReads?: readonly (keyof Listing)[];
};

/**
 * Every defaultable field, in display order — the single source of truth for the
 * settings form, the form-field hiding, the storage round-trip, and the overlay.
 * Two carry an `appliesTo` gate so the overlay never produces a listing the save
 * path would reject:
 * - `uses_logistics` is inert while logistics is off, matching the per-listing
 *   save gate — so a listing created during a logistics-off window can't
 *   silently become a logistics listing if the feature is re-enabled.
 * - `hidden` never applies to a renewal tier (`months_per_unit > 0`), which must
 *   stay hidden + purchase-only or renewal extension breaks. {@link catalogVisibleSql}
 *   mirrors this gate in SQL.
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
  {
    appliesTo: (_listing, { hasLogistics }) => hasLogistics,
    field: "uses_logistics",
    key: "usesLogistics",
    kind: "bool",
  },
  { field: "bookable_days", key: "bookableDays", kind: "days" },
  { field: "minimum_days_before", key: "minimumDaysBefore", kind: "number" },
  { field: "maximum_days_after", key: "maximumDaysAfter", kind: "number" },
  { field: "webhook_url", key: "webhookUrl", kind: "url" },
  { field: "thank_you_url", key: "thankYouUrl", kind: "url" },
  {
    appliesTo: (listing) => listing.months_per_unit === 0,
    field: "hidden",
    gateReads: ["months_per_unit"],
    key: "hidden",
    kind: "bool",
  },
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
 * set default whose {@link ListingDefaultField.appliesTo} gate (if any) accepts
 * the listing; otherwise return it unchanged. The per-field gates keep the
 * overlay from producing a listing the save path would reject — see
 * {@link LISTING_DEFAULT_FIELDS}.
 *
 * A field the row did not select cannot be inherited, so a narrow read gets the
 * effective values of exactly the fields it asked for. Selecting a gated field
 * without the fields its gate reads is a bug in the read, and throws.
 */
export const resolveListingDefaults = <T extends ResolvableListing>(
  listing: T,
  defaults: ListingDefaults,
  hasLogistics: boolean,
): T => {
  if (!listing.use_defaults) return listing;
  const ctx: ResolveContext = { hasLogistics };
  const overlay: Partial<Record<keyof Listing, unknown>> = {};
  for (const { key, field, appliesTo, gateReads } of setListingDefaultFields(
    defaults,
  )) {
    if (!(field in listing)) continue;
    const missing = (gateReads ?? []).filter((read) => !(read in listing));
    if (missing.length > 0) {
      throw new Error(
        `Cannot resolve the ${field} default: the row selects it but not ${missing.join(", ")}, which its rule reads`,
      );
    }
    if (!appliesTo || appliesTo(listing, ctx)) overlay[field] = defaults[key];
  }
  return { ...listing, ...overlay };
};

/**
 * Parse the stored JSON blob into a {@link ListingDefaults}. The blob is only
 * ever written by {@link serializeListingDefaults}, so its shape is trusted; an
 * absent setting (no defaults configured yet) reads as `{}`.
 */
export const parseListingDefaults = (
  raw: string | undefined,
): ListingDefaults =>
  raw ? listingDefaultsJson.read(raw, "settings.listing_defaults") : {};

/** Serialize defaults for storage. `JSON.stringify` drops every unset
 * (`undefined`) key, so only configured defaults are persisted. */
export const serializeListingDefaults = (defaults: ListingDefaults): string =>
  listingDefaultsJson.write(defaults, "settings.listing_defaults");
