import type { GroupIdsByListingId } from "#shared/group-capacity.ts";

/**
 * The **order selection model** — the pure core behind ordering surfaces. The
 * public order gallery uses it today, and an admin "start a booking on this
 * day" surface can reuse it. An {@link OrderOption} is one selectable thing:
 * a listing or a whole package, described purely by data. The data names the
 * listing units one selection books, whether judging needs a chosen date, and
 * whether the option is bookable at all right now. The evaluator (see
 * ./evaluate.ts) subtracts a visitor's selections from shared capacity pools,
 * in added order, to decide what else still fits. It is context-agnostic and
 * IO-free, so any surface can drive it.
 */

/** One selectable thing on an ordering surface. */
export type OrderOption = {
  /** Stable key ("listing:5" / "package:3") — the wire id for selections. */
  key: string;
  /** Buyer-facing name, used in "Remove <name> to add" messages. */
  name: string;
  /** Listing units ONE selection of this option books (listing id → units). */
  unitsByListingId: ReadonlyMap<number, number>;
  /** The days each listing's units occupy from the chosen start date — the
   * form's own span rules, from the option's demand judge (listing id →
   * days; a listing absent from the map occupies one day). Only read when a
   * date is chosen. */
  spanDaysByListingId: ReadonlyMap<number, number>;
  /** The realisable bookings one selection can make, per span the form can
   * book, as the demand judge answered them. An option is available when
   * any alternative fits beside the cart. */
  alternatives: ReadonlyArray<{
    spanDaysByListingId: ReadonlyMap<number, number>;
    unitsByListingId: ReadonlyMap<number, number>;
  }>;
  /** Whether availability can only be judged once a date is chosen (the
   * option books a daily listing). */
  needsDate: boolean;
  /** Whether the option is bookable at all right now, before any cart demand
   * (its own sold-out/closed state, or a package's whole-bundle gate). */
  bookableAlone: boolean;
};

/** The shared capacity pools selections draw from, resolved by the caller for
 * the chosen date, or datelessly when none is chosen. A listing or group
 * absent from its maps is unlimited. Day-judged listings and groups carry
 * per-day remaining over the chosen date's span. Everything else carries its
 * running-total remaining. */
export type OrderPools = {
  /** The chosen date's span days, earliest first. Empty when no date is
   * chosen — every pool then reads datelessly. */
  days: readonly string[];
  /** Remaining units per listing (its own cap ∩ its groups' caps). */
  remainingByListingId: ReadonlyMap<number, number>;
  /** Remaining units per day-judged listing, per day. */
  remainingByListingDay: ReadonlyMap<number, ReadonlyMap<string, number>>;
  /** Remaining units per capped group (undated). */
  remainingByGroupId: ReadonlyMap<number, number>;
  /** Remaining units per capped group, per day. */
  remainingByGroupDay: ReadonlyMap<number, ReadonlyMap<string, number>>;
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

/** One option's shared shell: the preview demand, which is also the base
 * alternative the demand judge replaces. */
const optionWithDemand = (
  option: Pick<OrderOption, "bookableAlone" | "key" | "name" | "needsDate">,
  units: ReadonlyMap<number, number>,
): OrderOption => ({
  alternatives: [{ spanDaysByListingId: new Map(), unitsByListingId: units }],
  ...option,
  spanDaysByListingId: new Map(),
  unitsByListingId: units,
});

/** Build a listing's order option from its availability-resolved card facts.
 *  The option's demand is the listing's minimum. The Continue prefill opens
 *  the booking page at that quantity, so the cart is judged at what the
 *  visitor actually gets. */
export const listingOption = (
  listing: {
    id: number;
    name: string;
    listing_type: string;
    min_quantity: number;
  },
  bookableAlone: boolean,
): OrderOption =>
  optionWithDemand(
    {
      bookableAlone,
      key: listingOptionKey(listing.id),
      name: listing.name,
      needsDate: listing.listing_type === "daily",
    },
    new Map([[listing.id, listing.min_quantity]]),
  );

/** Build a package's order option: one selection books every member at its
 * fixed per-package quantity. */
export const packageOption = (
  group: { id: number; name: string },
  members: readonly { id: number; listing_type: string }[],
  quantities: ReadonlyMap<number, number>,
  bookableAlone: boolean,
): OrderOption =>
  optionWithDemand(
    {
      bookableAlone,
      key: packageOptionKey(group.id),
      name: group.name,
      needsDate: members.some((member) => member.listing_type === "daily"),
    },
    new Map(
      members.map((member) => [member.id, quantities.get(member.id) ?? 1]),
    ),
  );
