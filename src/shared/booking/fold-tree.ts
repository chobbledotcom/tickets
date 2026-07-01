import { compact } from "#fp";
import { t } from "#i18n";
import {
  formatAtomicError,
  parseCustomPrice,
} from "#routes/public/ticket-form.ts";
import type { BookingNode, BookingTree } from "#shared/booking/tree.ts";
import {
  childPriceFieldName,
  childQuantityFieldName,
} from "#shared/booking/tree.ts";
import type { ChildAllocation } from "#shared/db/attendee-types.ts";
import type { FormParams } from "#shared/form-data.ts";
import type { Holiday } from "#shared/types.ts";
import { parseNonNegativeInt } from "#shared/validation/number.ts";
import {
  childDateOk,
  childDurationMatches,
  childPricedForSpan,
  childSelectableIgnoringSpan,
  resolveInheritedDuration,
  selectableChild,
  type TicketListing,
} from "#templates/public.tsx";

/**
 * The **unified fold** — one recursive walk over the {@link BookingTree} that
 * turns a submitted form into the order's listing set, quantity/custom-price maps
 * and per-(child, parent) allocations. It replaces the bespoke parent-walk
 * (`foldSelectedChildren`/`foldParent`) so a package member, a regular group
 * member and a standalone parent all fold through the *same* code, driven by node
 * facets and the tree's form-field-name single source of truth. Pure and DB-free:
 * the caller (`foldSelectedChildren`) builds the tree, resolves each node's
 * availability, and fetches holidays, then hands them in — so this walk is a
 * direct function of its inputs (see `booking-unification-phase2.md`, 2a).
 */

/** The booking duration a parent's customisable children inherit (invariant I4):
 * the shared `dayCount` for a customisable parent, fixed `duration_days` for a
 * fixed daily parent, 1 for a standard parent. Specialises the shared
 * {@link resolveInheritedDuration} with `(dayCount, 1)`. */
const parentResolvedDuration = (
  parent: TicketListing["listing"],
  dayCount: number,
): number => resolveInheritedDuration(parent, dayCount, 1);

/** Order context the candidate child must be bookable against: inherited
 * duration, resolved date, active holidays. */
type ChildBookableCtx = {
  duration: number;
  date: string | null;
  holidays: Holiday[];
};

/** The date-INDEPENDENT disqualifiers `childIsBookable` applies. The date- and
 * span-independent part (active, not closed, standard child not date-less sold
 * out) is {@link childSelectableIgnoringSpan}. When the inherited span is known
 * (`duration` non-null) two span atoms also apply: a customisable child must
 * price it ({@link childPricedForSpan}) and a fixed daily child's `duration_days`
 * must equal it ({@link childDurationMatches}). A null `duration` (CUSTOMISABLE
 * parent, span not yet chosen at render) skips only those span atoms — enforced
 * per-span at submit. Deliberately omits the child's own date calendar
 * ({@link childDateOk}), which the union folds in per-candidate-date instead
 * (parents.md Fixes 2–4). Shared with the render-side date union
 * (`constrainDatesByChildUnion`). */
export const childSelectableForSpan = (
  child: TicketListing,
  duration: number | null,
): boolean =>
  selectableChild(
    compact([
      childSelectableIgnoringSpan,
      duration === null ? null : childPricedForSpan(duration),
      duration === null ? null : childDurationMatches(duration),
    ]),
  )(child);

/** Bookable now = selectable for the inherited span ({@link childSelectableForSpan})
 * and — when daily — the resolved date is within the child's own bookable start
 * dates for the inherited duration ({@link childDateOk}). A daily child's
 * date-capacity is enforced later by the folded `checkAvailability` (never clamped). */
const childIsBookable = (
  child: TicketListing,
  { duration, date, holidays }: ChildBookableCtx,
): boolean =>
  childSelectableForSpan(child, duration) &&
  childDateOk(date, holidays, duration)(child);

/** The order's listing set, quantity/custom-price maps and selected ids, expanded
 * with the chosen children. Shared by the fold accumulator and the success result
 * so the two never drift apart. */
type FoldedOrder = {
  listings: TicketListing[];
  quantities: Map<number, number>;
  customPrices: Map<number, number>;
  selectedListingIds: Set<number>;
};

/** Accumulator threaded through the recursive fold: the {@link FoldedOrder} plus
 * the single customisable duration seen so far, used to reject mixed durations. */
type FoldState = FoldedOrder & {
  /** The one duration every customisable line must share, or null if none yet. */
  customisableDuration: number | null;
  allocations: ChildAllocation[];
};

export type FoldChildrenResult =
  | (FoldedOrder & {
      ok: true;
      hasCustomisable: boolean;
      /** The shared customisable duration, or the passed-in dayCount when no line
       * is customisable. Drives the folded order's `dayCount` so a fixed parent's
       * customisable child is priced for the inherited duration, not one day. */
      dayCount: number;
      allocations: ChildAllocation[];
    })
  | { ok: false; error: string };

/** The resolved inputs the fold needs beyond the tree: the page's date/day-count,
 * whether a page line was already customisable, the base quantity/custom-price
 * maps (page listings, before children fold in), and the active holidays. */
export type FoldBase = {
  quantities: Map<number, number>;
  customPrices: Map<number, number>;
  date: string | null;
  dayCount: number;
  hasCustomisable: boolean;
};

/** A bookable child paired with the per-unit quantity chosen under one parent
 * (always > 0 — zero-quantity children are dropped). */
type ChildSelection = { child: TicketListing; qty: number };

/** Parse one child's submitted per-unit quantity via the tree's field-name SSOT
 * ({@link childQuantityFieldName}): a non-negative integer, else 0. The selects
 * only emit `0..min(parentQty, childMax)`, so any other value is treated as "none
 * chosen" and the sum check (below) catches a too-low total. */
const childQtyField = (
  parentId: number,
  childId: number,
  form: FormParams,
): number =>
  // Strict parse: only a non-negative decimal integer counts. A tampered value
  // like "2.9", "1abc" or "01" is "none chosen" (0), never a truncated quantity
  // — matching every other quantity field, which uses the same strict helper.
  parseNonNegativeInt(
    form.getString(childQuantityFieldName(parentId, childId)),
  ) ?? 0;

/** Resolve the per-unit child selection for one in-cart parent: read each bookable
 * child's `child_qty_<parentId>_<childId>`, auto-assign the whole parent quantity
 * to a sole bookable child when NOTHING was submitted, and require the chosen
 * quantities to sum to exactly the parent's quantity. Returns the chosen children
 * (each qty > 0) or an error (none bookable / total too low or high / a quantity
 * on a non-bookable child).
 *
 * Exported for direct unit/property testing of the per-parent selection algebra. */
export const resolveChildSelections = (
  parent: TicketListing,
  bookable: TicketListing[],
  parentQty: number,
  form: FormParams,
): ChildSelection[] | { error: string } => {
  const name = parent.listing.name;
  if (bookable.length === 0) {
    return { error: t("public.ticket.child_sold_out", { name }) };
  }
  const parentId = parent.listing.id;
  const bookableIds = new Set(bookable.map((c) => c.listing.id));
  // Reject a positive quantity for a child not currently bookable under this
  // parent (unknown id, stranger listing, or a sibling that sold out/closed
  // between render and submit) — never silently swap in a still-bookable sibling
  // (parents.md step 3).
  const prefix = `child_qty_${parentId}_`;
  for (const key of form.keys()) {
    if (!key.startsWith(prefix)) continue;
    const childId = Number.parseInt(key.slice(prefix.length), 10);
    const qty = childQtyField(parentId, childId, form);
    if (qty > 0 && !bookableIds.has(childId)) {
      return { error: t("public.ticket.child_required", { name }) };
    }
  }
  const selections: ChildSelection[] = [];
  let total = 0;
  for (const child of bookable) {
    const qty = childQtyField(parentId, child.listing.id, form);
    if (qty > 0) {
      selections.push({ child, qty });
      total += qty;
    }
  }
  // Auto-select: nothing submitted for a sole bookable child fills the whole
  // parent quantity.
  if (total === 0 && bookable.length === 1) {
    return [{ child: bookable[0]!, qty: parentQty }];
  }
  if (total < parentQty) {
    return {
      error: t("public.ticket.child_too_few", {
        count: parentQty - total,
        name,
      }),
    };
  }
  if (total > parentQty) {
    return {
      error: t("public.ticket.child_too_many", {
        count: total - parentQty,
        name,
      }),
    };
  }
  return selections;
};

/** Read and validate a chosen child's pay-more price (`can_pay_more`), namespaced
 * by parent+child via the tree's field-name SSOT ({@link childPriceFieldName}).
 * Returns the price (undefined when fixed-price) or an error. */
const childCustomPrice = (
  parentId: number,
  child: TicketListing,
  form: FormParams,
): number | { error: string } | undefined => {
  if (!child.listing.can_pay_more) return undefined;
  const result = parseCustomPrice(
    form,
    childPriceFieldName(parentId, child.listing.id),
    child.listing.unit_price,
    child.listing.max_price,
  );
  if (!result.ok) return { error: `${child.listing.name}: ${result.error}` };
  return result.price;
};

/** Record a customisable line's duration into the order's single shared duration,
 * rejecting a second distinct value (the single CheckoutIntent dayCount can't
 * represent two — parents.md "Pricing & payment round-trip"). Shared by the page's
 * own customisable lines and folded customisable children. Returns null on success
 * or the mixed-duration error. */
const recordDuration = (state: FoldState, duration: number): string | null => {
  if (
    state.customisableDuration !== null &&
    state.customisableDuration !== duration
  ) {
    return t("public.ticket.mixed_durations");
  }
  state.customisableDuration = duration;
  return null;
};

/** Fold one chosen child into the accumulator at its own per-unit quantity
 * (`childQty`, not the parent quantity): sum that quantity across parents/units,
 * reconcile the customisable duration and pay-more price, and re-validate the
 * summed quantity against the child's max-purchasable cap (reject, never clamp).
 * Records a per-(child, parent) allocation so `expandChildAllocations` can later
 * produce one `listing_attendees` row per allocation instead of one summed row.
 * Returns null on success or an error message.
 *
 * @param parentId - The id of the parent listing that required this child choice.
 *
 * Exported for direct unit/property testing of the summing/capacity rule. */
export const foldChild = (
  state: FoldState,
  child: TicketListing,
  childQty: number,
  duration: number,
  parentId: number,
  price: number | undefined,
): string | null => {
  const childId = child.listing.id;
  const summed = (state.quantities.get(childId) ?? 0) + childQty;
  // A DAILY child's `maxPurchasable` is the date-less aggregate cap, which reads
  // 0 once the child is full on ANY single date — so it must NOT gate a booking on
  // a different date with capacity (same date-less-aggregate trap as `isSoldOut`,
  // Codex 336); its per-date cap is enforced by the folded `checkAvailability`
  // (rejected, never clamped). A STANDARD child's cap is cumulative and
  // date-independent, so it stays authoritative here.
  if (child.listing.listing_type !== "daily" && summed > child.maxPurchasable) {
    return formatAtomicError("capacity_exceeded", child.listing.name);
  }
  if (child.listing.customisable_days) {
    const durationError = recordDuration(state, duration);
    if (durationError) return durationError;
  }
  if (price !== undefined) {
    const existing = state.customPrices.get(childId);
    if (existing !== undefined && existing !== price) {
      return t("public.ticket.child_price_mismatch", {
        name: child.listing.name,
      });
    }
    state.customPrices.set(childId, price);
  }
  state.quantities.set(childId, summed);
  state.selectedListingIds.add(childId);
  if (!state.listings.some((e) => e.listing.id === childId)) {
    state.listings.push(child);
  }
  state.allocations.push({ childId, parentId, qty: childQty });
  return null;
};

/** Fold one in-cart parent NODE's selected children into `state`: filter its child
 * nodes to those bookable for the resolved date/duration (availability read from
 * `resolved`, keyed by nodeKey), resolve the per-unit selection (children totalling
 * the parent quantity, auto-filled when a sole child exists), and fold each at ITS
 * own quantity. Returns null on success or a user-facing error. */
const foldParentNode = (
  state: FoldState,
  node: BookingNode,
  parent: TicketListing,
  parentQty: number,
  resolved: ReadonlyMap<string, TicketListing>,
  form: FormParams,
  dayCount: number,
  date: string | null,
  holidays: Holiday[],
): string | null => {
  const duration = parentResolvedDuration(parent.listing, dayCount);
  // Every child node was built from the same resolved context, so its key is
  // always present in `resolved` (non-null by construction).
  const bookable = node.children
    .map((childNode) => resolved.get(childNode.nodeKey)!)
    .filter((child) => childIsBookable(child, { date, duration, holidays }));
  const selections = resolveChildSelections(parent, bookable, parentQty, form);
  if ("error" in selections) return selections.error;
  for (const { child, qty } of selections) {
    const price = childCustomPrice(parent.listing.id, child, form);
    if (price && typeof price === "object") return price.error;
    const error = foldChild(
      state,
      child,
      qty,
      duration,
      parent.listing.id,
      price,
    );
    if (error) return error;
  }
  return null;
};

/** Map every node's key to its availability-resolved {@link TicketListing} — the
 * `isClosed`/`isSoldOut`/group-clamped `maxPurchasable` the fold reads, which the
 * node itself deliberately does not carry. Top-level nodes resolve from the page
 * listings; a child node resolves from its parent's hydrated children — keyed by
 * `nodeKey`, so the same child reached under two parents stays distinct. Every node
 * was built from this same context, so its listing is always present (non-null by
 * construction). The caller builds this once and hands it to {@link foldBookingTree}. */
export const resolvedByNodeKey = (
  topLevel: readonly TicketListing[],
  childrenByParentId: ReadonlyMap<number, readonly TicketListing[]>,
  tree: BookingTree,
): Map<string, TicketListing> => {
  const topById = new Map(topLevel.map((e) => [e.listing.id, e]));
  const childByParent = new Map<number, Map<number, TicketListing>>(
    [...childrenByParentId].map(([parentId, children]) => [
      parentId,
      new Map(children.map((c) => [c.listing.id, c])),
    ]),
  );
  const resolved = new Map<string, TicketListing>();
  const visit = (nodes: readonly BookingNode[]): void => {
    for (const node of nodes) {
      resolved.set(
        node.nodeKey,
        node.edgeRef.kind === "parent_child"
          ? childByParent.get(node.edgeRef.parentId)!.get(node.listingId)!
          : topById.get(node.listingId)!,
      );
      visit(node.children);
    }
  };
  visit(tree.nodes);
  return resolved;
};

/**
 * Fold every in-cart parent's selected children into the order by walking the
 * booking tree (steps 4–5 core, parents.md "Server-side validation"). Each
 * top-level node with a positive quantity and child edges folds its bookable
 * children — a package member, a group member and a standalone parent all take
 * the same path — expanding the listing set + quantity/custom-price maps +
 * selected ids so every downstream per-listing path sees a child as an ordinary
 * line. A parent with no bookable child is rejected (sold out). Child fields under
 * a zero-quantity parent are ignored, not read. No-op when no parent applies.
 *
 * Pure: `resolved` maps each node's key to the availability-resolved
 * {@link TicketListing} (isClosed/isSoldOut/group-clamped maxPurchasable) the fold
 * needs, and `holidays` is fetched by the caller — so the same tree always folds
 * the same way.
 */
export const foldBookingTree = (
  tree: BookingTree,
  resolved: ReadonlyMap<string, TicketListing>,
  form: FormParams,
  base: FoldBase,
  holidays: Holiday[],
): FoldChildrenResult => {
  const state: FoldState = {
    allocations: [],
    // The page's own customisable lines all share the one submitted `day_count`,
    // so seed the shared duration with it; a folded customisable child whose
    // inherited duration differs is then rejected.
    customisableDuration: base.hasCustomisable ? base.dayCount : null,
    customPrices: new Map(base.customPrices),
    // Every tree node was built from the same resolved context, so its key is
    // always present in `resolved` (non-null by construction).
    listings: tree.nodes.map((node) => resolved.get(node.nodeKey)!),
    quantities: new Map(base.quantities),
    selectedListingIds: new Set(base.quantities.keys()),
  };

  for (const node of tree.nodes) {
    const parentQty = base.quantities.get(node.listingId) ?? 0;
    if (parentQty <= 0) continue;
    if (node.children.length === 0) continue;
    const error = foldParentNode(
      state,
      node,
      resolved.get(node.nodeKey)!,
      parentQty,
      resolved,
      form,
      base.dayCount,
      base.date,
      holidays,
    );
    if (error) return { error, ok: false };
  }

  return {
    allocations: state.allocations,
    customPrices: state.customPrices,
    dayCount: state.customisableDuration ?? base.dayCount,
    hasCustomisable:
      base.hasCustomisable || state.customisableDuration !== null,
    listings: state.listings,
    ok: true,
    quantities: state.quantities,
    selectedListingIds: state.selectedListingIds,
  };
};
