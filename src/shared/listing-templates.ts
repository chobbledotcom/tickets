/**
 * Listing template inference — derive a listing's "type" from its four stored
 * boolean/enum dimensions without any new DB column.
 *
 * The four dimensions are:
 *   daily        listing_type === "daily"
 *   dated        date field non-empty
 *   purchaseable purchase_only (the "No check-in" flag)
 *   logistics    uses_logistics
 *
 * Four named templates cover the most-common shapes; any listing whose
 * dimensions don't match is treated as "Custom" (full form, no hiding).
 */

import type { Listing } from "#shared/types.ts";

export type TemplateId =
  | "hireable-item"
  | "online-digital"
  | "one-off-event"
  | "weekly-event";

export type Dimensions = {
  daily: boolean;
  dated: boolean;
  logistics: boolean;
  purchaseable: boolean;
};

export type TemplateSignature = {
  /** Undefined means "don't care" — logistics templates ignore daily. */
  daily?: boolean;
  /** Undefined means "don't care" — only checked when daily is pinned false. */
  dated?: boolean;
  logistics: boolean;
  purchaseable: boolean;
};

export type ListingTemplate = {
  /** i18n key for the picker card description. */
  description: string;
  id: TemplateId;
  /** i18n key for the picker card title. */
  label: string;
  requiresDate: boolean;
  requiresLogistics: boolean;
  signature: TemplateSignature;
};

export const LISTING_TEMPLATES: readonly ListingTemplate[] = [
  {
    description: "listings_table.template_one_off_event_description",
    id: "one-off-event",
    label: "listings_table.template_one_off_event",
    requiresDate: true,
    requiresLogistics: false,
    signature: {
      daily: false,
      dated: true,
      logistics: false,
      purchaseable: false,
    },
  },
  {
    description: "listings_table.template_weekly_event_description",
    id: "weekly-event",
    label: "listings_table.template_weekly_event",
    requiresDate: false,
    requiresLogistics: false,
    signature: { daily: true, logistics: false, purchaseable: false },
  },
  {
    description: "listings_table.template_online_digital_description",
    id: "online-digital",
    label: "listings_table.template_online_digital",
    requiresDate: false,
    requiresLogistics: false,
    signature: {
      daily: false,
      dated: false,
      logistics: false,
      purchaseable: true,
    },
  },
  {
    description: "listings_table.template_hireable_item_description",
    id: "hireable-item",
    label: "listings_table.template_hireable_item",
    requiresDate: false,
    requiresLogistics: true,
    // daily and dated are both omitted: a hireable item may be daily or
    // standard and any dated state, so listing_type stays visible on the form.
    signature: { logistics: true, purchaseable: true },
  },
];

export type DimensionSource = Pick<
  Listing,
  "date" | "listing_type" | "purchase_only" | "uses_logistics"
>;

export const dimensionsOf = (source: DimensionSource): Dimensions => ({
  daily: source.listing_type === "daily",
  dated: source.date !== "",
  logistics: source.uses_logistics,
  purchaseable: source.purchase_only,
});

const matchesSignature = (
  signature: TemplateSignature,
  dims: Dimensions,
): boolean => {
  if (signature.daily !== undefined && signature.daily !== dims.daily)
    return false;
  // dated is only meaningful when daily is explicitly pinned to false.
  if (
    signature.daily === false &&
    signature.dated !== undefined &&
    signature.dated !== dims.dated
  )
    return false;
  if (signature.purchaseable !== dims.purchaseable) return false;
  if (signature.logistics !== dims.logistics) return false;
  return true;
};

export const inferTemplate = (
  source: DimensionSource,
): ListingTemplate | null =>
  LISTING_TEMPLATES.find((tmpl) =>
    matchesSignature(tmpl.signature, dimensionsOf(source)),
  ) ?? null;

/**
 * Returns true when a blank `date` should be rejected on create.
 *
 * The condition is the conjunction of:
 *   (a) the operator chose the one-off-event template, AND
 *   (b) the submitted non-date dimensions still match the one-off shape
 *       (daily=false, purchaseable=false, logistics=false).
 *
 * Using (a) alone would reject the Custom card's legitimate unnamed shape
 * (standard + no date + check-in + no logistics). Using (b) alone would be
 * vacuous: with a blank date the submitted dims never infer one-off. The
 * conjunction is what distinguishes "forgot the date" from "different type".
 */
export const submissionRequiresDate = (
  chosenTemplateId: string | null,
  submittedDimensions: Dimensions,
): boolean =>
  chosenTemplateId === "one-off-event" &&
  !submittedDimensions.daily &&
  !submittedDimensions.purchaseable &&
  !submittedDimensions.logistics;
