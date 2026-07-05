import {
  type BookingNode,
  type BookingTree,
  nodeFixedQuantity,
  nodesDeepestFirst,
  type PriceRule,
} from "#shared/booking/tree.ts";
import { type DayPricedListing, dayPriceFor } from "#shared/types.ts";

/**
 * The unified **unit price** derivation — one evaluation of a node's `priceRule`
 * that replaces the old `itemUnitPrice` + `applyPackageOverrides` pair.
 * `priceCheckout` still layers the non-line
 * components (modifiers, reservation deposit, booking fee, the `/pay` balance)
 * over these line prices — this module only decides the per-ticket line price.
 */

/** The per-ticket unit price (minor units) a node's `priceRule` resolves to:
 * `OVERRIDE` is the flat package price (including an explicit free `0`);
 * `DAY_PRICE` is the customisable day-count price — a package member's per-day
 * override for the chosen count when one is set, else the listing's own entered
 * day price, NEVER base × days; `PAY_MORE` and `BASE` both read the
 * `customPrices` map (falling back to `unit_price`, honouring a genuine `0`).
 * `customPrices` carries the buyer's pay-more input for a `PAY_MORE` listing AND a
 * signed QR-token override for a fixed-price `BASE` listing
 * (`applyQrTokenOverride` seeds it), so a fixed listing under a QR token is priced
 * by the override — exactly the checkout's old non-customisable
 * `customPrices ?? unit_price`. A listing is never both `customisable_days` and
 * `can_pay_more` (mutually exclusive at save — `listings-actions.ts`), so this
 * matches the customisable-first `itemUnitPrice` for every reachable config. */
/** The listing facts {@link effectivePrice} prices from — a structural subset of
 * `ListingWithCount`, so the webhook/email pipeline's narrower listing rows can
 * be priced by the same evaluation the checkout uses. */
export type PricedListing = DayPricedListing & {
  id: number;
  unit_price: number;
};

/** The shared "no buyer custom prices" map for callers pricing configured
 * amounts only (webhooks, revalidation, bundle totals). */
export const NO_CUSTOM_PRICES: ReadonlyMap<number, number> = new Map();

/** A package member's {@link PriceRule} from its configured package pricing:
 * flat override (including an explicit free `0`) > per-day overrides for a
 * customisable member > the listing's own day/base price. The ONE constructor
 * every surface that prices a member outside the tree builder (webhook payloads,
 * payment revalidation) shares with the tree itself, so the precedence can never
 * fork per surface. Pass both overrides `undefined` for a non-member line: the
 * rule falls through to the listing's own pricing. */
export const packageMemberPriceRule = (
  flatOverrideMinor: number | undefined,
  dayOverrides: ReadonlyMap<number, number> | undefined,
  customisableDays: boolean,
): PriceRule => {
  if (flatOverrideMinor !== undefined) {
    return { amountMinor: flatOverrideMinor, kind: "OVERRIDE" };
  }
  if (customisableDays) return { kind: "DAY_PRICE", overrides: dayOverrides };
  return { kind: "BASE" };
};

export const effectivePrice = (
  priceRule: PriceRule,
  listing: PricedListing,
  customPrices: ReadonlyMap<number, number>,
  dayCount: number,
): number => {
  switch (priceRule.kind) {
    case "OVERRIDE":
      return priceRule.amountMinor;
    case "DAY_PRICE":
      return (
        priceRule.overrides?.get(dayCount) ??
        dayPriceFor(listing, dayCount) ??
        0
      );
    default:
      // PAY_MORE (buyer's custom price) and BASE (fixed, optionally QR-overridden).
      return customPrices.get(listing.id) ?? listing.unit_price;
  }
};

/** The minimum unavoidable child charge for ONE unit of a parent member: the
 * fold requires chosen children to total exactly the parent quantity (a sole
 * bookable child is auto-selected), so every booked parent unit carries at
 * least its cheapest bookable child's price. `bookableChildIds` scopes the
 * minimum to children a buyer can actually choose (a render fact the tree
 * doesn't carry); 0 for a childless member — and for a parent with NO bookable
 * child, which the bookable gate rejects before any price is advertised. */
const minBookableChildPrice = (
  node: BookingNode,
  days: number,
  bookableChildIds: ReadonlySet<number>,
): number => {
  const prices = node.children
    .filter((child) => bookableChildIds.has(child.listingId))
    .map((child) =>
      effectivePrice(child.priceRule, child.listing, NO_CUSTOM_PRICES, days),
    );
  return prices.length === 0 ? 0 : Math.min(...prices);
};

/** The bundle's total price (minor units) for ONE package at the given day
 * count: each member's effective unit price (flat override → per-day override →
 * the listing's own day/base price) plus its minimum unavoidable child charge
 * ({@link minBookableChildPrice} — checkout always folds children totalling the
 * member quantity), × its fixed per-package quantity — the same tree walk
 * checkout uses, shared by the API detail and the booking page's day-count
 * labels so an advertised price can never undercut what a booking charges. */
export const packageBundleTotal = (
  tree: BookingTree,
  days: number,
  bookableChildIds: ReadonlySet<number>,
): number =>
  tree.nodes.reduce(
    (sum, node) =>
      sum +
      (effectivePrice(node.priceRule, node.listing, NO_CUSTOM_PRICES, days) +
        minBookableChildPrice(node, days, bookableChildIds)) *
        nodeFixedQuantity(node),
    0,
  );

/** Each booked listing's price rule keyed by listing id, with a **top-level**
 * node's rule taking precedence over a child's. This scopes a package member's
 * `OVERRIDE` to the member line by construction — a child keeps its own base/
 * pay-more/day rule — exactly as the old `pageListingIds`-gated
 * `applyPackageOverrides` did, but as a facet of the tree rather than a separate
 * pass. */
export const priceRuleByListingId = (
  tree: BookingTree,
): Map<number, PriceRule> => {
  // Walk deepest first so a top-level node's rule is written after a same-id
  // descendant's and overwrites it — top-level wins.
  const map = new Map<number, PriceRule>();
  for (const node of nodesDeepestFirst(tree.nodes)) {
    map.set(node.listingId, node.priceRule);
  }
  return map;
};
