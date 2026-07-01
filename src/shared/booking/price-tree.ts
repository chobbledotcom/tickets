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
 * `OVERRIDE` (the package price, including an explicit free `0`) wins, then
 * `PAY_MORE` (the buyer's submitted custom price, or `unit_price` when none —
 * note a genuine `0` custom price is honoured, not treated as "unset"), then
 * `DAY_PRICE` (the customisable day-count price), then `BASE` (`unit_price`).
 *
 * A listing is never both `customisable_days` and `can_pay_more` (mutually
 * exclusive at save — `listings-actions.ts`), so at most one of `PAY_MORE`/
 * `DAY_PRICE` ever applies to a given listing; their relative order is therefore
 * immaterial and this matches the checkout's customisable-first `itemUnitPrice`
 * for every reachable config. */
export const effectivePrice = (
  priceRule: PriceRule,
  listing: ListingWithCount,
  customPrices: ReadonlyMap<number, number>,
  dayCount: number,
): number => {
  switch (priceRule.kind) {
    case "OVERRIDE":
      return priceRule.amountMinor;
    case "PAY_MORE":
      return customPrices.get(listing.id) ?? listing.unit_price;
    case "DAY_PRICE":
      return dayPriceFor(listing, dayCount) ?? 0;
    default:
      return listing.unit_price;
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
