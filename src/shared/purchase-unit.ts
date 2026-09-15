/**
 * The unit a purchase counts in: plain tickets, or the months one purchased
 * unit buys. Declared as data so every surface that names what a buyer is
 * paying for — the provider checkouts, the order summary, the quantity
 * selectors — reads one answer instead of re-deriving its own.
 *
 * The unit describes the purchase for display. It never authorises
 * fulfilment: a renewal still only extends a site through its own checkout
 * machinery.
 */

import * as v from "valibot";

/** The months one purchased unit buys. */
const MonthsUnitSchema = v.object({
  kind: v.literal("months"),
  // A term is a positive whole number of months — the schema's own rule, read
  // through monthsUnitOrNull wherever a term is stated.
  monthsPerUnit: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
});

/** What one purchased unit buys. */
const PurchaseUnitSchema = v.variant("kind", [
  v.object({ kind: v.literal("tickets") }),
  MonthsUnitSchema,
]);
export type PurchaseUnit = v.InferOutput<typeof PurchaseUnitSchema>;

/** The months one unit buys, or undefined when the purchase counts tickets. */
export const monthsPerUnitOf = (
  unit: PurchaseUnit | undefined,
): number | undefined =>
  unit?.kind === "months" ? unit.monthsPerUnit : undefined;

/** The listing facts that decide what one purchased unit buys. */
export type PurchaseUnitFacts = {
  assign_built_site?: boolean | undefined;
  initial_site_months?: number | undefined;
  months_per_unit?: number | undefined;
};

/** What kind of purchase this is: a renewal renews an existing site, so the
 * same tier listing prices differently there than on its own page. */
export type PurchaseContext = { renewal: boolean };

/** The months unit a stated term buys, or null when the term is not a
 *  positive whole number of months. */
const monthsUnitOrNull = (
  monthsPerUnit: number | undefined,
): PurchaseUnit | null => {
  const unit: PurchaseUnit | null =
    monthsPerUnit === undefined ? null : { kind: "months", monthsPerUnit };
  return unit !== null && v.is(PurchaseUnitSchema, unit) ? unit : null;
};

/** Resolve what one purchased unit buys. A renewal prices a tier by its
 *  months per unit; an ordinary purchase of an assigned-site plan prices its
 *  whole initial term; every other listing counts tickets. */
export const resolvePurchaseUnit = (
  listing: PurchaseUnitFacts,
  purchase: PurchaseContext,
): PurchaseUnit => {
  if (purchase.renewal) {
    // A renewal page only offers tiers that price months per unit; a listing
    // that states no term is not a tier, so its units stay what they are.
    const tier = monthsUnitOrNull(listing.months_per_unit);
    if (tier !== null) return tier;
  }
  if (listing.assign_built_site) {
    const plan = monthsUnitOrNull(listing.initial_site_months);
    // Listing saves refuse this combination, and the checkout-time
    // configuration check refuses it again — seeing it here means broken
    // stored data, so refuse loudly rather than inventing a term.
    if (plan === null) {
      throw new Error(
        "Unable to price this listing: an assigned-site plan states no initial months",
      );
    }
    return plan;
  }
  return { kind: "tickets" };
};
