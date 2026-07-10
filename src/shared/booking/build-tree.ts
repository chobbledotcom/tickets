import { map } from "#fp";
import type { TicketListing } from "#shared/booking/model.ts";
import {
  packageByMemberListingId,
  type TreePackage,
} from "#shared/booking/page-packages.ts";
import { selectPriceRule } from "#shared/booking/price-tree.ts";
import {
  type BookingNode,
  type BookingTree,
  childNodeKey,
  type DateSpan,
  groupMemberNodeKey,
  listingNodeKey,
  type PriceRule,
  packageMemberNodeKey,
  type QuantityRule,
  type RootRef,
  type Visibility,
} from "#shared/booking/tree.ts";
import type { ListingWithCount } from "#shared/types.ts";

/**
 * The pure, DB-free builder that turns the data a booking page has already
 * resolved (its listings, package bundles, and per-parent children) into the
 * canonical {@link BookingTree}. It is the one place that decides a node's
 * identity and facets, so render and the fold/price/capacity walks
 * build off the *same* tree instead of re-deriving membership from
 * scratch. No I/O — the caller loads the tables and hands the resolved shapes in.
 */

/** The resolved inputs a page already computed before render — mirrors what
 * `ticketPage`/`getTicketContext` produce, so building the tree needs no extra
 * queries. `packages` carries each package bundle sold on the page (empty/absent
 * for a plain listing page). A listing builds ONE NODE PER PATH it can be
 * booked through: one member node per package that includes it, plus a
 * standalone node when it is sold on its own — an order may book the same
 * listing through overlapping packages AND standalone, and each path keeps its
 * own price, quantity, and booking row. `standaloneListingIds` names the
 * member listings that ALSO sell standalone on this page (a member the cart
 * added by its own slug); non-members always sell standalone. `root` names a
 * regular (non-package) group page's identity; a package page needs no root —
 * its identity is derived from `packages`. */
export type BuildTreeInput = {
  readonly slugs: readonly string[];
  readonly listings: readonly TicketListing[];
  readonly root?: Extract<RootRef, { kind: "group" }> | undefined;
  /** The package bundles sold on this page, in page order. */
  readonly packages?: readonly TreePackage[] | null | undefined;
  /** Member listings that ALSO sell standalone on this page. */
  readonly standaloneListingIds?: ReadonlySet<number> | undefined;
  /** Required children per parent listing id (already hydrated + availability). */
  readonly childrenByParentId?:
    | ReadonlyMap<number, readonly TicketListing[]>
    | undefined;
};

/** Which price a listing charges, in the doc's precedence: a package `OVERRIDE`
 * wins, then pay-what-you-want (`PAY_MORE`), then a **customisable** listing's
 * per-day-count `DAY_PRICE`, then `BASE`. A *fixed* daily listing
 * (`customisable_days` false) is NOT day-priced — it charges its `unit_price`
 * and only uses the date for availability (`dayPriceFor` returns null unless
 * customisable), so it stays `BASE`/`PAY_MORE`; its date/duration is carried by
 * the node's `dateSpan`, not its price rule. A customisable package member's
 * per-day overrides (`dayOverrides`) ride the `DAY_PRICE` rule: `effectivePrice`
 * consults them before the listing's own day price, while a flat `OVERRIDE`
 * (one price whatever the span) still wins outright. */
const derivePriceRule = (
  listing: ListingWithCount,
  overrideMinor: number | undefined,
  dayOverrides?: ReadonlyMap<number, number> | undefined,
): PriceRule =>
  // Map the listing onto the shared precedence inputs and let
  // {@link selectPriceRule} pick the winning tier. A flat override outranks
  // pay-more, but the two never coexist: packages cannot contain
  // pay-what-you-want listings, so an overridden line is never PAY_MORE.
  selectPriceRule({
    customisableDays: listing.customisable_days,
    dayOverrides,
    overrideMinor,
    payMore: listing.can_pay_more
      ? { maxMinor: listing.max_price, minMinor: listing.unit_price }
      : undefined,
  });

/** A required child's date facet. Only a child that carries date/span semantics
 * — a daily or customisable listing — `INHERIT`s its parent's resolved span; a
 * standard child is date-less (`NONE`), matching `bookingDateFields` (which sets
 * a date only for daily listings) so its cumulative add-on capacity is counted
 * once, never re-checked per parent-date. */
const childDateSpan = (child: ListingWithCount): DateSpan =>
  child.listing_type === "daily" || child.customisable_days
    ? { kind: "INHERIT" }
    : { kind: "NONE" };

/** Build a required-child node under `parent` (`edgeRef: parent_child`). Its
 * `nodeKey` embeds the parent's full nodeKey (`parentNodeKey`) so the same child
 * under a standalone vs a package/group parent stays a distinct canonical
 * identity. Visibility is inherited: a child of a `HIDDEN` node (a member of a
 * hidden package) is itself `HIDDEN` regardless of its own `hidden` flag, so a
 * `HIDDEN`-dropping projection can never name a descendant of a hidden package
 * member (hidden-package privacy). A `HIDDEN` child is still a node, so the
 * fold/compat scripts keep driving off it. */
const buildChildNode =
  (parentNodeKey: string, parentId: number, parentHidden: boolean) =>
  (child: TicketListing): BookingNode => ({
    children: [],
    dateSpan: childDateSpan(child.listing),
    edgeRef: { kind: "parent_child", parentId },
    listing: child.listing,
    listingId: child.listing.id,
    nodeKey: childNodeKey(parentNodeKey, child.listing.id),
    priceRule: derivePriceRule(child.listing, undefined),
    quantityRule: { kind: "BUYER_CHOICE" },
    visibility: parentHidden || child.listing.hidden ? "HIDDEN" : "SHOWN",
  });

/** The required-child nodes of the parent addressed by `parentNodeKey`, or none
 * when it has no children — shared by every node kind so a parent is just a node
 * with `children`, including a package member that is itself a parent (the old
 * "auto-include"). `parentHidden` carries the parent node's own visibility down so
 * every descendant of a hidden package member is hidden too. */
const buildChildren = (
  input: BuildTreeInput,
  parentNodeKey: string,
  parentId: number,
  parentHidden: boolean,
): BookingNode[] =>
  map(buildChildNode(parentNodeKey, parentId, parentHidden))([
    ...(input.childrenByParentId?.get(parentId) ?? []),
  ]);

/** Build one top-level node for a standalone/cart/regular-group member, wiring in
 * any required children so a parent is just a node with `children`. */
const buildListingNode = (
  input: BuildTreeInput,
  info: TicketListing,
): BookingNode => {
  const { listing } = info;
  const edgeRef =
    input.root === undefined
      ? ({ kind: "none" } as const)
      : ({ groupId: input.root.groupId, kind: "group_member" } as const);
  const nodeKey =
    input.root === undefined
      ? listingNodeKey(listing.id)
      : groupMemberNodeKey(input.root.groupId, listing.id);
  return {
    // A top-level node is always SHOWN, so its children only hide themselves.
    children: buildChildren(input, nodeKey, listing.id, false),
    dateSpan: { kind: "NONE" },
    edgeRef,
    listing,
    listingId: listing.id,
    nodeKey,
    priceRule: derivePriceRule(listing, undefined),
    quantityRule: { kind: "BUYER_CHOICE" },
    visibility: "SHOWN",
  };
};

/** Build one package member node: a `FIXED(memberQty)` node priced by any
 * per-member override, `HIDDEN` when its package hides its listings. The
 * `× packageQty` multiply happens at fold time, so the render-time quantity is
 * the per-package fixed count. */
const buildPackageMemberNode =
  (input: BuildTreeInput, pkg: TreePackage) =>
  (info: TicketListing): BookingNode => {
    const { listing } = info;
    const fixedQty = pkg.quantities.get(listing.id) ?? 1;
    const overrideMinor = pkg.prices.get(listing.id);
    const visibility: Visibility = pkg.hideListings ? "HIDDEN" : "SHOWN";
    const quantityRule: QuantityRule = { kind: "FIXED", qty: fixedQty };
    const nodeKey = packageMemberNodeKey(pkg.groupId, listing.id);
    return {
      // A hidden package member hides its whole subtree: pass HIDDEN down so an
      // auto-included child of a hidden member is never named (privacy).
      children: buildChildren(
        input,
        nodeKey,
        listing.id,
        visibility === "HIDDEN",
      ),
      dateSpan: { kind: "NONE" },
      edgeRef: { groupId: pkg.groupId, kind: "group_member" },
      listing,
      listingId: listing.id,
      nodeKey,
      priceRule: derivePriceRule(
        listing,
        overrideMinor,
        pkg.dayPrices.get(listing.id),
      ),
      quantityRule,
      visibility,
    };
  };

/** The page identity a built tree records: a regular group keeps its explicit
 * root; a page that is exactly one package (every listing a member, nothing
 * sold standalone beside it) is that package; anything else — a plain listing
 * page or a mixed cart — is identified by its slugs. */
const deriveRootRef = (
  input: BuildTreeInput,
  memberByListingId: ReadonlyMap<number, TreePackage>,
): RootRef => {
  if (input.root !== undefined) return input.root;
  const [first] = input.packages ?? [];
  if (
    first !== undefined &&
    input.packages!.length === 1 &&
    (input.standaloneListingIds?.size ?? 0) === 0 &&
    input.listings.every((info) => memberByListingId.has(info.listing.id))
  ) {
    return { groupId: first.groupId, kind: "package" };
  }
  return { kind: "listing", slugs: input.slugs };
};

/** Construct the canonical {@link BookingTree} for a booking page: one node
 * per bookable path — a member node for EACH package that includes a listing,
 * plus a standalone node for a non-member (or a member also sold standalone). */
export const buildBookingTree = (input: BuildTreeInput): BookingTree => {
  const packages = input.packages ?? [];
  const nodes = [...input.listings].flatMap((info) => {
    const memberOf = packages.filter((pkg) =>
      pkg.memberListingIds.includes(info.listing.id),
    );
    const standalone =
      memberOf.length === 0 ||
      (input.standaloneListingIds?.has(info.listing.id) ?? false);
    return [
      ...map((pkg: TreePackage) => buildPackageMemberNode(input, pkg)(info))(
        memberOf,
      ),
      ...(standalone ? [buildListingNode(input, info)] : []),
    ];
  });
  return {
    nodes,
    rootRef: deriveRootRef(input, packageByMemberListingId(packages)),
  };
};
