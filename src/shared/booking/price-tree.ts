import type {
  BookingNode,
  BookingTree,
  PriceRule,
} from "#shared/booking/tree.ts";
import { dayPriceFor, type ListingWithCount } from "#shared/types.ts";

/**
 * The unified **unit price** derivation — one evaluation of a node's `priceRule`
 * that replaces the old `itemUnitPrice` + `applyPackageOverrides` pair (see
 * `booking-unification-phase2.md`, 2b). `priceCheckout` still layers the non-line
 * components (modifiers, reservation deposit, booking fee, the `/pay` balance)
 * over these line prices — this module only decides the per-ticket line price.
 */

/** The per-ticket unit price (minor units) a node's `priceRule` resolves to:
 * `OVERRIDE` is the package price (including an explicit free `0`); `DAY_PRICE` is
 * the customisable day-count price; `PAY_MORE` and `BASE` both read the
 * `customPrices` map (falling back to `unit_price`, honouring a genuine `0`).
 * `customPrices` carries the buyer's pay-more input for a `PAY_MORE` listing AND a
 * signed QR-token override for a fixed-price `BASE` listing
 * (`applyQrTokenOverride` seeds it), so a fixed listing under a QR token is priced
 * by the override — exactly the checkout's old non-customisable
 * `customPrices ?? unit_price`. A listing is never both `customisable_days` and
 * `can_pay_more` (mutually exclusive at save — `listings-actions.ts`), so this
 * matches the customisable-first `itemUnitPrice` for every reachable config. */
export const effectivePrice = (
  priceRule: PriceRule,
  listing: ListingWithCount,
  customPrices: ReadonlyMap<number, number>,
  dayCount: number,
): number => {
  switch (priceRule.kind) {
    case "OVERRIDE":
      return priceRule.amountMinor;
    case "DAY_PRICE":
      return dayPriceFor(listing, dayCount) ?? 0;
    default:
      // PAY_MORE (buyer's custom price) and BASE (fixed, optionally QR-overridden).
      return customPrices.get(listing.id) ?? listing.unit_price;
  }
};

/** Each booked listing's price rule keyed by listing id, with a **top-level**
 * node's rule taking precedence over a child's. This scopes a package member's
 * `OVERRIDE` to the member line by construction — a child keeps its own base/
 * pay-more/day rule — exactly as the old `pageListingIds`-gated
 * `applyPackageOverrides` did, but as a facet of the tree rather than a separate
 * pass. */
export const priceRuleByListingId = (
  tree: BookingTree,
): Map<number, PriceRule> => {
  const map = new Map<number, PriceRule>();
  // Set deeper (child) rules first, then shallower (top-level) rules, so a
  // top-level node overwrites a same-id descendant — top-level wins.
  const visit = (nodes: readonly BookingNode[]): void => {
    for (const node of nodes) visit(node.children);
    for (const node of nodes) map.set(node.listingId, node.priceRule);
  };
  visit(tree.nodes);
  return map;
};
