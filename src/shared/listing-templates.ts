/**
 * Listing templates: infer a listing's "type" from the fields it already
 * carries, without a stored discriminator column. See `listing-templates.md`
 * (planning doc) for the full design.
 *
 * A listing's type is a fixed point in four boolean dimensions — `daily`,
 * `dated`, `purchaseable`, `logistics` — each read straight off a stored field
 * (no derived "has a price" predicate, so inference can never disagree with what
 * a template's seed wrote). The five named templates have pairwise-disjoint
 * signatures, so a listing matches at most one; anything unmatched is Custom
 * (`null`).
 */

import type { Listing } from "#shared/types.ts";

/** Stable ids for the five named templates (also the `?template` query values
 * and i18n key stems). */
export type TemplateId =
  | "one-off-event"
  | "weekly-event"
  | "online-digital"
  | "delivered-item"
  | "bookable-item";

export const ONE_OFF_TEMPLATE_ID: TemplateId = "one-off-event";

/** The four boolean dimensions a listing's template is derived from. */
export type Dimensions = {
  /** `listing_type === "daily"` — recurring per-date booking vs a single event. */
  daily: boolean;
  /** `date` is non-empty — has one fixed listing-level calendar date. */
  dated: boolean;
  /** `purchase_only` — the "No check-in" box: a pure e-ticket/purchase rather
   * than an event you scan people into. NOT a price check. */
  purchaseable: boolean;
  /** `uses_logistics` — delivery/collection agents are assigned. */
  logistics: boolean;
};

/**
 * A template's dimension signature. `dated` is **optional**: it is omitted for
 * the daily templates because a daily listing books a date per booking and
 * ignores the listing-level `date` field, so `dated` is not part of their
 * identity (a daily listing matches whether or not it happens to carry a date).
 */
export type TemplateSignature = {
  daily: boolean;
  dated?: boolean;
  purchaseable: boolean;
  logistics: boolean;
};

export type ListingTemplate = {
  id: TemplateId;
  signature: TemplateSignature;
  /** Needs the logistics feature: only offered/usable when `settings.hasLogistics`. */
  requiresLogistics: boolean;
  /** The create form must collect a `date` for this template (one-off only). */
  requiresDate: boolean;
};

/**
 * The five templates. Signatures are pairwise disjoint:
 * - the daily pair (weekly/bookable) only matches `daily` listings, the standard
 *   trio only matches non-daily;
 * - within daily they split on `purchaseable`; within standard they split on
 *   `(dated, purchaseable, logistics)`.
 */
export const LISTING_TEMPLATES: readonly ListingTemplate[] = [
  {
    id: "one-off-event",
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
    id: "weekly-event",
    requiresDate: false,
    requiresLogistics: false,
    signature: { daily: true, logistics: false, purchaseable: false },
  },
  {
    id: "online-digital",
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
    id: "delivered-item",
    requiresDate: false,
    requiresLogistics: true,
    signature: {
      daily: false,
      dated: false,
      logistics: true,
      purchaseable: true,
    },
  },
  {
    id: "bookable-item",
    requiresDate: false,
    requiresLogistics: true,
    signature: { daily: true, logistics: true, purchaseable: true },
  },
];

/** The listing fields the four dimensions are read from. Both a stored
 * {@link Listing} and a parsed create/edit submission satisfy this shape. */
export type DimensionSource = Pick<
  Listing,
  "listing_type" | "date" | "purchase_only" | "uses_logistics"
>;

/** Read the four dimensions off a listing (or a parsed submission). */
export const dimensionsOf = (source: DimensionSource): Dimensions => ({
  daily: source.listing_type === "daily",
  dated: source.date !== "",
  logistics: source.uses_logistics,
  purchaseable: source.purchase_only,
});

/**
 * Whether a listing's dimensions match a template signature. Every named
 * dimension must agree; `dated` is skipped when the signature omits it (daily
 * templates), since a daily listing's listing-level date is not part of its
 * identity.
 */
export const matchesSignature = (
  signature: TemplateSignature,
  dimensions: Dimensions,
): boolean =>
  signature.daily === dimensions.daily &&
  signature.purchaseable === dimensions.purchaseable &&
  signature.logistics === dimensions.logistics &&
  (signature.dated === undefined || signature.dated === dimensions.dated);

/**
 * Infer the template a listing belongs to, or `null` (Custom) when it matches
 * none of the five. Because the signatures are disjoint, the first match is the
 * only match.
 */
export const inferTemplate = (
  source: DimensionSource,
): ListingTemplate | null =>
  LISTING_TEMPLATES.find((template) =>
    matchesSignature(template.signature, dimensionsOf(source)),
  ) ?? null;

/**
 * Whether a create submission must carry a non-empty `date`.
 *
 * The predicate is the **conjunction** of the chosen template and the submitted
 * non-date shape — deliberately, because every simpler formulation is wrong:
 * - keying on the chosen template id alone over-blocks an operator who opened
 *   Customise and changed the shape (now daily/digital, which needs no date);
 * - inferring over the submitted body alone is *vacuous*, since a blank `date`
 *   means `dated=false`, so the body never infers one-off;
 * - keying on the submitted non-date dimensions alone would block the Custom card
 *   saving the legitimate unnamed `standard + blank-date + check-in + no-logistics`
 *   shape, which posts exactly those non-date dimensions.
 *
 * So: require a date iff the operator chose the one-off card **and** the
 * submitted non-date dimensions still match the one-off's (standard, check-in,
 * no-logistics). The chosen-template context is what distinguishes "one-off
 * attempt, forgot the date" from "deliberate Custom".
 */
export const submissionRequiresDate = (
  chosenTemplateId: string | null,
  submittedDimensions: Dimensions,
): boolean =>
  chosenTemplateId === ONE_OFF_TEMPLATE_ID &&
  !submittedDimensions.daily &&
  !submittedDimensions.purchaseable &&
  !submittedDimensions.logistics;
