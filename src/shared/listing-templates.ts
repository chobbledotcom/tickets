/**
 * Five stored dimensions determine a listing's type. It has no type column:
 *
 *   daily        listing_type === "daily"
 *   dated        date field non-empty
 *   purchaseable purchase_only (the "No check-in" flag)
 *   logistics    uses_logistics
 *   subscribed   recurring_price > 0
 *
 * A listing that matches no named template is "Custom": full form, no fields
 * hidden.
 */

import type { Listing } from "#types";

export type TemplateId =
  | "day-pass"
  | "donation"
  | "hireable-item"
  | "online-digital"
  | "one-off-event"
  | "physical-product"
  | "subscription"
  | "weekly-event";

/** A site feature that a template needs before the picker offers it. */
export type TemplateRequirement = "logistics" | "subscriptions";

export type Dimensions = {
  daily: boolean;
  dated: boolean;
  logistics: boolean;
  purchaseable: boolean;
  subscribed: boolean;
};

/** Undefined means "don't care". */
export type TemplateSignature = {
  daily?: boolean;
  /** Only checked when daily is pinned false. */
  dated?: boolean;
  logistics?: boolean;
  purchaseable?: boolean;
  subscribed: boolean;
};

export type ListingTemplate = {
  /** i18n key for the picker card description. */
  description: string;
  id: TemplateId;
  /** i18n key for the picker card title. */
  label: string;
  requiresDate: boolean;
  requires: TemplateRequirement | null;
  signature: TemplateSignature;
};

/** One picker entry's flags and dimension signature. The i18n keys derive
 *  from the id (`template_<id>` / `template_<id>_description`), so an entry
 *  is one line of real choices. The exact keys are pinned in
 *  test/shared/listing-templates.test.ts. */
const listingTemplate = (
  id: TemplateId,
  flags: { requiresDate: boolean; requires: TemplateRequirement | null },
  signature: TemplateSignature,
): ListingTemplate => {
  const label = `listings_table.template_${id.replaceAll("-", "_")}`;
  return {
    description: `${label}_description`,
    id,
    label,
    requires: flags.requires,
    requiresDate: flags.requiresDate,
    signature,
  };
};

/** No date, and no site feature needed. */
const NOT_DATED = { requires: null, requiresDate: false };

/** Booked on a day the buyer picks, and checked in. */
const DAILY = {
  daily: true,
  logistics: false,
  purchaseable: false,
  subscribed: false,
};

/** Bought, with nothing to check in and nothing dated. */
const PURCHASABLE = {
  daily: false,
  dated: false,
  logistics: false,
  purchaseable: true,
  subscribed: false,
};

/** The picker's listing templates. Some pairs share one signature, because
 *  the model has no dimension that tells them apart: weekly-event and
 *  day-pass, and online-digital, physical-product and donation. Only the
 *  picker card, its copy, and the create form's seed differ.
 *
 *  Entry ORDER pins inference precedence. matchesSignature returns the first
 *  match, so the template that a shared signature infers comes first. The
 *  picker sets its own card order. */
export const LISTING_TEMPLATES: readonly ListingTemplate[] = [
  listingTemplate(
    "one-off-event",
    { requires: null, requiresDate: true },
    {
      daily: false,
      dated: true,
      logistics: false,
      purchaseable: false,
      subscribed: false,
    },
  ),
  listingTemplate("weekly-event", NOT_DATED, DAILY),
  listingTemplate("day-pass", NOT_DATED, DAILY),
  listingTemplate("online-digital", NOT_DATED, PURCHASABLE),
  listingTemplate(
    "hireable-item",
    { requires: "logistics", requiresDate: false },
    // daily and dated are both omitted: a hireable item may be daily or
    // standard and any dated state, so listing_type stays visible on the
    // form.
    { logistics: true, purchaseable: true, subscribed: false },
  ),
  listingTemplate("physical-product", NOT_DATED, PURCHASABLE),
  listingTemplate("donation", NOT_DATED, PURCHASABLE),
  listingTemplate(
    "subscription",
    { requires: "subscriptions", requiresDate: false },
    // A subscription can also be posted, or need no check-in, so only the
    // undated standard shape is pinned.
    { daily: false, dated: false, subscribed: true },
  ),
];

export type DimensionSource = Pick<
  Listing,
  "date" | "listingType" | "purchaseOnly" | "recurringPrice" | "usesLogistics"
>;

export const dimensionsOf = (source: DimensionSource): Dimensions => ({
  daily: source.listingType === "daily",
  dated: source.date !== "",
  logistics: source.usesLogistics,
  purchaseable: source.purchaseOnly,
  subscribed: source.recurringPrice > 0,
});

/** True when the signature pins this dimension to the other value. */
const pinnedOther = (pinned: boolean | undefined, actual: boolean): boolean =>
  pinned !== undefined && pinned !== actual;

const matchesSignature = (
  signature: TemplateSignature,
  dims: Dimensions,
): boolean =>
  !pinnedOther(signature.daily, dims.daily) &&
  // dated is only meaningful when daily is explicitly pinned to false.
  !(signature.daily === false && pinnedOther(signature.dated, dims.dated)) &&
  !pinnedOther(signature.purchaseable, dims.purchaseable) &&
  !pinnedOther(signature.logistics, dims.logistics) &&
  signature.subscribed === dims.subscribed;

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
