import type { GroupIdsByListingId } from "#shared/types.ts";

/**
 * The **order selection model** — the pure core behind ordering surfaces (the
 * public order gallery today; an admin "start a booking on this day" surface
 * can reuse it). An {@link OrderOption} is one selectable thing (a listing or
 * a whole package) described purely by data: which listing units one selection
 * books, whether judging it needs a chosen date, and whether it is bookable at
 * all right now. The evaluator (see ./evaluate.ts) subtracts a visitor's
 * selections from shared capacity pools, in added order, to decide what else
 * still fits —
 * context-agnostic and IO-free, so any surface can drive it.
 */

/** One selectable thing on an ordering surface. */
export type OrderOption = {
  /** Stable key ("listing:5" / "package:3") — the wire id for selections. */
  key: string;
  /** Buyer-facing name, used in "Remove <name> to add" messages. */
  name: string;
  /** Listing units ONE selection of this option books (listing id → units). */
  unitsByListingId: ReadonlyMap<number, number>;
  /** Whether availability can only be judged once a date is chosen (the
   * option books a daily listing). */
  needsDate: boolean;
  /** Whether the option is bookable at all right now, before any cart demand
   * (its own sold-out/closed state, or a package's whole-bundle gate). */
  bookableAlone: boolean;
};

/** The shared capacity pools selections draw from, resolved by the caller for
 * the chosen date (or datelessly when none is chosen). A listing/group absent
 * from its map is unlimited. */
export type OrderPools = {
  /** Remaining units per listing (its own cap ∩ its groups' caps). */
  remainingByListingId: ReadonlyMap<number, number>;
  /** Remaining units per capped group. */
  remainingByGroupId: ReadonlyMap<number, number>;
  /** Group ids each listing belongs to. */
  groupIdsByListingId: GroupIdsByListingId;
};

/** How one option currently stands, given the cart so far. */
export type OrderOptionState =
  | { kind: "selected" }
  | { kind: "available" }
  /** Needs a chosen date before availability can be judged. */
  | { kind: "needs_date" }
  /** Not bookable regardless of the cart (sold out / closed / bundle dead). */
  | { kind: "unavailable" }
  /** Fits on its own, but not alongside the current selection — removing the
   * named selected option would free the contested capacity. */
  | { kind: "blocked"; byKey: string; byName: string };

export const listingOptionKey = (listingId: number): string =>
  `listing:${listingId}`;

export const packageOptionKey = (groupId: number): string =>
  `package:${groupId}`;

/** Build a listing's order option from its availability-resolved card facts. */
export const listingOption = (
  listing: { id: number; name: string; listing_type: string },
  bookableAlone: boolean,
): OrderOption => ({
  bookableAlone,
  key: listingOptionKey(listing.id),
  name: listing.name,
  needsDate: listing.listing_type === "daily",
  unitsByListingId: new Map([[listing.id, 1]]),
});

/** Build a package's order option: one selection books every member at its
 * fixed per-package quantity. */
export const packageOption = (
  group: { id: number; name: string },
  members: readonly { id: number; listing_type: string }[],
  quantities: ReadonlyMap<number, number>,
  bookableAlone: boolean,
): OrderOption => ({
  bookableAlone,
  key: packageOptionKey(group.id),
  name: group.name,
  needsDate: members.some((member) => member.listing_type === "daily"),
  unitsByListingId: new Map(
    members.map((member) => [member.id, quantities.get(member.id) ?? 1]),
  ),
});
