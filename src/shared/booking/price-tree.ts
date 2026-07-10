import {
  type BookingNode,
  type BookingTree,
  nodeFixedQuantity,
  type PriceRule,
} from "#shared/booking/tree.ts";
import { type DayPricedListing, dayPriceFor } from "#shared/types.ts";

/** The discriminant of {@link PriceRule} — the set of price tiers. Their
 * precedence is NOT this type's business (a union has no order); it lives in
 * {@link PRICE_RULE_PRECEDENCE}. Deriving it from the union keeps the tier list
 * in one place: a new tier on {@link PriceRule} is instantly a compile error in
 * every table below keyed by this type. */
export type PriceRuleKind = PriceRule["kind"];

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

// ---------------------------------------------------------------------------
// Price rules as data — one table keyed by kind decides *which* tier a listing
// gets (precedence order) and *how* each tier prices (evaluation).
// ---------------------------------------------------------------------------

/** The listing facts that decide WHICH price rule a listing gets, checked in
 * precedence order. `payMore` is present only for a pay-what-you-want listing;
 * the surfaces that price members outside the tree builder (webhook payloads,
 * payment revalidation) hold a narrower listing shape with no pay-more fields,
 * so they omit it and their lines never select `PAY_MORE`. */
export type PriceRuleInputs = {
  /** A flat package override (incl. an explicit free `0`); absent for a
   * non-member line. */
  readonly overrideMinor: number | undefined;
  /** A customisable member's per-day overrides (day count → per-unit minor). */
  readonly dayOverrides: ReadonlyMap<number, number> | undefined;
  /** Whether the listing prices per booked day count. */
  readonly customisableDays: boolean;
  /** Pay-what-you-want bounds, present only for a `can_pay_more` listing. */
  readonly payMore?:
    | { readonly minMinor: number; readonly maxMinor: number }
    | undefined;
};

/** What an evaluated price rule reads to resolve its per-ticket price. */
type PriceEvalContext = {
  readonly listing: PricedListing;
  readonly customPrices: ReadonlyMap<number, number>;
  readonly dayCount: number;
};

/** The buyer's submitted price for this listing, else its fixed unit price. A
 * genuine `0` (a free pay-more booking, or a `0` QR override) is honoured — the
 * map holds `0`, and `0` is not nullish, so `??` keeps it. */
const submittedOrUnitPrice = (ctx: PriceEvalContext): number =>
  ctx.customPrices.get(ctx.listing.id) ?? ctx.listing.unit_price;

/** Everything one price tier knows about itself: whether it wins for a listing
 * (`appliesTo`), how to build its concrete rule from the inputs (`build`), and
 * how to price that rule at checkout (`evaluate`). Each is generic in its own
 * `kind`, so `build`/`evaluate` see the narrowed {@link PriceRule} variant. */
type PriceRuleSpec<K extends PriceRuleKind> = {
  readonly appliesTo: (inputs: PriceRuleInputs) => boolean;
  readonly build: (inputs: PriceRuleInputs) => Extract<PriceRule, { kind: K }>;
  readonly evaluate: (
    rule: Extract<PriceRule, { kind: K }>,
    ctx: PriceEvalContext,
  ) => number;
};

/** Every price tier as data, keyed by {@link PriceRuleKind}. Because it is an
 * exhaustive map over the union's discriminant, adding a tier to
 * {@link PriceRule} is a compile error here until it is defined — no silent
 * fall-through in either the selector or the evaluator. Adding a tier (say an
 * "early bird") is one new entry here plus one entry in
 * {@link PRICE_RULE_PRECEDENCE}; nothing else to hand-edit. */
const PRICE_RULES: { [K in PriceRuleKind]: PriceRuleSpec<K> } = {
  BASE: {
    // The terminal fallback: always applies, so selection is total.
    appliesTo: () => true,
    build: () => ({ kind: "BASE" }),
    // A fixed listing, optionally carrying a signed QR-token override.
    evaluate: (_rule, ctx) => submittedOrUnitPrice(ctx),
  },
  DAY_PRICE: {
    appliesTo: (inputs) => inputs.customisableDays,
    build: (inputs) => ({ kind: "DAY_PRICE", overrides: inputs.dayOverrides }),
    // A customisable member's per-day override for the chosen count, else the
    // listing's own entered day price — NEVER base × days; 0 for an unoffered count.
    evaluate: (rule, ctx) =>
      rule.overrides?.get(ctx.dayCount) ??
      dayPriceFor(ctx.listing, ctx.dayCount) ??
      0,
  },
  OVERRIDE: {
    appliesTo: (inputs) => inputs.overrideMinor !== undefined,
    // `appliesTo` guarantees the override is set.
    build: (inputs) => ({
      amountMinor: inputs.overrideMinor!,
      kind: "OVERRIDE",
    }),
    // The flat package price, including an explicit free `0`.
    evaluate: (rule) => rule.amountMinor,
  },
  PAY_MORE: {
    appliesTo: (inputs) => inputs.payMore !== undefined,
    build: (inputs) => ({
      kind: "PAY_MORE",
      maxMinor: inputs.payMore!.maxMinor,
      minMinor: inputs.payMore!.minMinor,
    }),
    // The buyer's pay-what-you-want input (falls back to the minimum unit price).
    evaluate: (_rule, ctx) => submittedOrUnitPrice(ctx),
  },
};

/** Compile-time assertion that `order` names EVERY {@link PriceRuleKind} — a new
 * tier added to {@link PriceRule} becomes a type error here until it is given a
 * place in the precedence, so it can never be silently skipped straight to
 * `BASE`. `T` is inferred as the literal tuple (the `const` type parameter), and
 * the conditional collapses the parameter to `never` when a kind is missing. */
const orderedKinds = <const T extends readonly PriceRuleKind[]>(
  order: [PriceRuleKind] extends [T[number]] ? T : never,
): T => order;

/** The price-rule precedence as data, highest first: the FIRST kind whose
 * {@link PriceRuleSpec.appliesTo} accepts the listing wins — `OVERRIDE >
 * PAY_MORE > DAY_PRICE > BASE`. This is the single source of truth for the
 * precedence the app once repeated as a comment, an if-chain, and a switch;
 * `BASE` always applies and sits last, so a match is always found. The list is
 * exhaustive by construction ({@link orderedKinds}), so it can never fall out of
 * step with the {@link PRICE_RULES} table. */
const PRICE_RULE_PRECEDENCE = orderedKinds([
  "OVERRIDE",
  "PAY_MORE",
  "DAY_PRICE",
  "BASE",
]);

/** Choose a listing's {@link PriceRule} by the {@link PRICE_RULE_PRECEDENCE}
 * order — the ONE selector the tree builder and every member-pricing surface
 * share, so the precedence can never fork per surface. */
export const selectPriceRule = (inputs: PriceRuleInputs): PriceRule => {
  // `BASE` always applies and is last, so a matching kind is always found.
  const kind = PRICE_RULE_PRECEDENCE.find((k) =>
    PRICE_RULES[k].appliesTo(inputs),
  )!;
  return PRICE_RULES[kind].build(inputs);
};

/** A package member's {@link PriceRule} from its configured package pricing:
 * flat override (including an explicit free `0`) > per-day overrides for a
 * customisable member > the listing's own day/base price. The narrower entry
 * for the surfaces that price a member outside the tree builder (webhook
 * payloads, payment revalidation): it shares {@link selectPriceRule} with the
 * tree but omits `payMore` — a package member is never pay-what-you-want
 * (invariant at save) and these surfaces carry no pay-more fields — so it only
 * ever yields `OVERRIDE > DAY_PRICE > BASE`. Pass `flatOverrideMinor` undefined
 * for a non-member line: it falls through to the listing's own pricing. */
export const packageMemberPriceRule = (
  flatOverrideMinor: number | undefined,
  dayOverrides: ReadonlyMap<number, number> | undefined,
  customisableDays: boolean,
): PriceRule =>
  selectPriceRule({
    customisableDays,
    dayOverrides,
    overrideMinor: flatOverrideMinor,
  });

export const effectivePrice = (
  priceRule: PriceRule,
  listing: PricedListing,
  customPrices: ReadonlyMap<number, number>,
  dayCount: number,
): number => {
  // Dispatch to this rule's evaluator. The cast bridges TS's inability to
  // correlate `priceRule.kind` with its matching narrowed spec; the map is
  // exhaustive, so every kind has one.
  const { evaluate } = PRICE_RULES[
    priceRule.kind
  ] as PriceRuleSpec<PriceRuleKind>;
  return evaluate(priceRule, { customPrices, dayCount, listing });
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
