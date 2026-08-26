/**
 * A listing's "type" is inferred from four stored dimensions, with no DB column
 * of its own:
 *
 *   daily        listing_type === "daily"
 *   dated        date field non-empty
 *   purchaseable purchase_only (the "No check-in" flag)
 *   logistics    uses_logistics
 *
 * A listing that matches no named template is "Custom": full form, nothing hid.
 */

import type { Listing } from "#types";

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
 * Both halves of the condition are needed. The template choice alone would
 * reject the Custom card's legitimate unnamed shape. The submitted dimensions
 * alone would be vacuous, because a blank date never infers one-off.
 *
 * Together they distinguish "forgot the date" from "different type".
 */
export const submissionRequiresDate = (
  chosenTemplateId: string | null,
  submittedDimensions: Dimensions,
): boolean =>
  chosenTemplateId === "one-off-event" &&
  !submittedDimensions.daily &&
  !submittedDimensions.purchaseable &&
  !submittedDimensions.logistics;
