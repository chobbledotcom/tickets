import { map } from "#fp";
import {
  type BookingNode,
  type BookingTree,
  childNodeKey,
  type DateSpan,
  type EntryContext,
  groupMemberNodeKey,
  listingNodeKey,
  type PriceRule,
  packageMemberNodeKey,
  type QuantityRule,
  type RootRef,
  type Visibility,
} from "#shared/booking/tree.ts";
import type { ListingWithCount } from "#shared/types.ts";
import type { TicketListing } from "#templates/public/shared.tsx";

/**
 * The pure, DB-free builder that turns the data a booking page has already
 * resolved (its listings, package maps, and per-parent children) into the
 * canonical {@link BookingTree}. It is the one place that decides a node's
 * identity and facets, so render (Phase 1) and the fold/price/capacity walks
 * (Phase 2) build off the *same* tree instead of re-deriving membership from
 * scratch. No I/O — the caller loads the tables and hands the resolved shapes in.
 */

/** The resolved inputs a page already computed before render — mirrors what
 * `ticketPage`/`getTicketContext` produce, so building the tree needs no extra
 * queries. `groupId` is set for a group or package root; `isPackage` picks the
 * package root and its fixed-quantity/override member semantics. */
export type BuildTreeInput = {
  readonly slugs: readonly string[];
  readonly listings: readonly TicketListing[];
  readonly groupId?: number | undefined;
  readonly isPackage?: boolean | undefined;
  /** Fixed units of each member one package includes (by listing id). */
  readonly packageQuantities?: ReadonlyMap<number, number> | undefined;
  /** Per-member package price override in minor units (by listing id). */
  readonly packagePrices?: ReadonlyMap<number, number> | undefined;
  /** Members hidden from buyers (`hide_package_listings`). */
  readonly hidePackageListings?: boolean | undefined;
  /** Required children per parent listing id (already hydrated + availability). */
  readonly childrenByParentId?:
    | ReadonlyMap<number, readonly TicketListing[]>
    | undefined;
  readonly entry?: EntryContext | undefined;
};

/** Which price a listing charges, in the doc's precedence: a package `OVERRIDE`
 * wins, then pay-what-you-want (`PAY_MORE`), then a daily/customisable
 * `DAY_PRICE`, then `BASE`. */
const derivePriceRule = (
  listing: ListingWithCount,
  overrideMinor: number | undefined,
): PriceRule => {
  if (overrideMinor !== undefined) {
    return { amountMinor: overrideMinor, kind: "OVERRIDE" };
  }
  if (listing.can_pay_more) {
    return {
      kind: "PAY_MORE",
      maxMinor: listing.max_price,
      minMinor: listing.unit_price,
    };
  }
  if (listing.customisable_days || listing.listing_type === "daily") {
    return { kind: "DAY_PRICE" };
  }
  return { kind: "BASE" };
};

/** A top-level or child listing's own date facet at build time. A concrete
 * `DATE`/`SPAN` is only known once the buyer submits a `date`/`day_count`
 * (resolved in Phase 2's fold); at render a standalone daily/customisable node
 * therefore has no chosen span yet, and a child inherits its parent's. */
const ownDateSpan = (parentId: number | undefined): DateSpan =>
  parentId === undefined ? { kind: "NONE" } : { kind: "INHERIT" };

/** Build a required-child node under `parent` (`edgeRef: parent_child`). A hidden
 * child is `HIDDEN` (its name never shows) but still a node, so the fold/compat
 * scripts keep driving off it. */
const buildChildNode =
  (parentId: number) =>
  (child: TicketListing): BookingNode => ({
    children: [],
    dateSpan: ownDateSpan(parentId),
    edgeRef: { kind: "parent_child", parentId },
    listing: child.listing,
    listingId: child.listing.id,
    nodeKey: childNodeKey(parentId, child.listing.id),
    priceRule: derivePriceRule(child.listing, undefined),
    quantityRule: { kind: "BUYER_CHOICE" },
    visibility: child.listing.hidden ? "HIDDEN" : "SHOWN",
  });

/** Build one top-level node for a standalone/cart/regular-group member, wiring in
 * any required children so a parent is just a node with `children`. */
const buildListingNode = (
  input: BuildTreeInput,
  info: TicketListing,
): BookingNode => {
  const { listing } = info;
  const children = input.childrenByParentId?.get(listing.id) ?? [];
  const edgeRef =
    input.groupId === undefined
      ? ({ kind: "none" } as const)
      : ({ groupId: input.groupId, kind: "group_member" } as const);
  const nodeKey =
    input.groupId === undefined
      ? listingNodeKey(listing.id)
      : groupMemberNodeKey(input.groupId, listing.id);
  return {
    children: map(buildChildNode(listing.id))([...children]),
    dateSpan: ownDateSpan(undefined),
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
 * per-member override, `HIDDEN` when the package hides its listings. The
 * `× packageQty` multiply happens at fold time, so the render-time quantity is
 * the per-package fixed count. */
const buildPackageMemberNode =
  (input: BuildTreeInput, groupId: number) =>
  (info: TicketListing): BookingNode => {
    const { listing } = info;
    const fixedQty = input.packageQuantities?.get(listing.id) ?? 1;
    const overrideMinor = input.packagePrices?.get(listing.id);
    const visibility: Visibility = input.hidePackageListings
      ? "HIDDEN"
      : "SHOWN";
    const quantityRule: QuantityRule = { kind: "FIXED", qty: fixedQty };
    return {
      children: [],
      dateSpan: ownDateSpan(undefined),
      edgeRef: { groupId, kind: "group_member" },
      listing,
      listingId: listing.id,
      nodeKey: packageMemberNodeKey(groupId, listing.id),
      priceRule: derivePriceRule(listing, overrideMinor),
      quantityRule,
      visibility,
    };
  };

/** The tree's root/page identity from the resolved inputs. */
const buildRootRef = (input: BuildTreeInput): RootRef => {
  if (input.isPackage && input.groupId !== undefined) {
    return { groupId: input.groupId, kind: "package" };
  }
  if (input.groupId !== undefined) {
    return { groupId: input.groupId, kind: "group" };
  }
  return { kind: "listing", slugs: input.slugs };
};

/** Construct the canonical {@link BookingTree} for a booking page. */
export const buildBookingTree = (input: BuildTreeInput): BookingTree => {
  const rootRef = buildRootRef(input);
  const nodes =
    rootRef.kind === "package"
      ? map(buildPackageMemberNode(input, rootRef.groupId))([...input.listings])
      : map((info: TicketListing) => buildListingNode(input, info))([
          ...input.listings,
        ]);
  return { entry: input.entry ?? {}, nodes, rootRef };
};
