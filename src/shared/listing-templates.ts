/**
 * A listing's "type" is inferred from four stored dimensions, with no DB column
 * of its own:
 *
 *   daily        listing_type === "daily"
 *   dated        date field non-empty
 *   purchaseable purchase_only (the "No check-in" flag)
 *   logistics    uses_logistics
 *
 * A listing that matches no named template is "Custom": full form, no fields
 * hidden.
 */

import type { Listing } from "#types";

export type TemplateId =
  | "hireable-item"
  | "online-digital"
  | "one-off-event"
  | "physical-product"
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

/** One picker entry's flags and dimension signature. The i18n keys derive
 *  from the id (`template_<id>` / `template_<id>_description`), so an entry
 *  is one line of real choices. The exact keys are pinned in
 *  test/shared/listing-templates.test.ts. */
const listingTemplate = (
  id: TemplateId,
  flags: { requiresDate: boolean; requiresLogistics: boolean },
  signature: TemplateSignature,
): ListingTemplate => {
  const label = `listings_table.template_${id.replaceAll("-", "_")}`;
  return {
    description: `${label}_description`,
    id,
    label,
    requiresDate: flags.requiresDate,
    requiresLogistics: flags.requiresLogistics,
    signature,
  };
};

/** The flags three of the five entries share: no date, no logistics. */
const NOT_DATED = { requiresDate: false, requiresLogistics: false };

/** The signature both product templates share: buy it, nothing to check in,
 *  nothing dated. */
const PURCHASABLE = {
  daily: false,
  dated: false,
  logistics: false,
  purchaseable: true,
};

/** The picker's listing templates. physical-product shares online-digital's
 *  dimensions (PURCHASABLE). The model has no physical/digital dimension:
 *  both are purchase-only with no date. Inference therefore keeps preferring
 *  online-digital (first match) and the 16-combo inference table is
 *  unchanged. Only the picker card, its copy, and the create form's seed
 *  differ.
 *
 *  Entry ORDER pins inference precedence. matchesSignature returns the first
 *  match, so a template whose signature is a superset must come later. */
export const LISTING_TEMPLATES: readonly ListingTemplate[] = [
  listingTemplate(
    "one-off-event",
    { requiresDate: true, requiresLogistics: false },
    { daily: false, dated: true, logistics: false, purchaseable: false },
  ),
  listingTemplate("weekly-event", NOT_DATED, {
    daily: true,
    logistics: false,
    purchaseable: false,
  }),
  listingTemplate("online-digital", NOT_DATED, PURCHASABLE),
  listingTemplate(
    "hireable-item",
    { requiresDate: false, requiresLogistics: true },
    // daily and dated are both omitted: a hireable item may be daily or
    // standard and any dated state, so listing_type stays visible on the
    // form.
    { logistics: true, purchaseable: true },
  ),
  // physical-product comes last for inference, not prominence. Its
  // signature is identical to online-digital's, and matchesSignature
  // returns the first match. Online-digital must win the shared combo so
  // the 16-combo inference table stays as pinned. The picker shows
  // physical-product first via its own card order.
  listingTemplate("physical-product", NOT_DATED, PURCHASABLE),
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
