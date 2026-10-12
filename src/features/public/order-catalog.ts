/**
 * The order gallery's catalog: the listing cards, the packages, and the
 * judged options for both. Each option's demand comes from the one judge
 * (`#booking/option-demand.ts`). The demand covers its own units, the child
 * units the booking form auto-folds, and the days the form's own span rules
 * give them. The gallery and the form can therefore never disagree about
 * what a booking takes.
 */

import type { TicketListing } from "#booking/model.ts";
import {
  judgeOptionDemand,
  type OptionVerdict,
} from "#booking/option-demand.ts";
import {
  getGroupPackagePricesByGroupIds,
  packageMemberMaps,
} from "#db/groups.ts";
import type { Holiday } from "#db/holidays.ts";
import { requiredMapValue, uniqueBy } from "#fp";
import { isPublicListing } from "#shared/listing-visibility.ts";
import {
  listingOption,
  type OrderOption,
  packageOption,
} from "#shared/order/options.ts";
import { loadSortedListings } from "#shared/sort-listings.ts";
import type { Group, ListingWithCount } from "#types";
import { allChildListings, loadChildrenByParentId } from "./child-listings.ts";
import { applyParentSoldOut, classifyForDiscovery } from "./discovery.ts";
import { loadBookablePackages } from "./group-liveness.ts";
import { buildTicketListingsWithGroupCapacity } from "./ticket-listings.ts";
import type { ChildrenByParentId } from "./types.ts";

/** Load the bookable listings for the order page, in the standard sorted order. */
const loadOrderListings = async (): Promise<ListingWithCount[]> =>
  (await loadSortedListings(isPublicListing)).listings;

/** One selectable package with everything its card and its option need. */
type OrderPackage = {
  group: Group;
  members: ListingWithCount[];
  /** How many units of each member one package books. */
  quantities: ReadonlyMap<number, number>;
};

/** Everything the order surfaces share: the listing cards, the packages, and
 * the availability-resolved listings the options' judge reads. The options
 * themselves are judged per request (their demand depends on the chosen
 * date) — see {@link judgeOrderOptions}. */
export type OrderCatalog = {
  /** The children the options' folded demand draws from. */
  childListings: ListingWithCount[];
  childrenByParentId: ChildrenByParentId;
  /** Every parent's availability-resolved listing, cards and package
   * members alike. */
  parentInfoById: ReadonlyMap<number, TicketListing>;
  packages: OrderPackage[];
  ticketListings: TicketListing[];
};

/** Merge one option's card gate with the judge's verdict. The judge decides
 * whether the form can book the option. Its demand — the units and the days
 * they occupy — replaces the card's own. */
const judgedOption = (
  option: OrderOption,
  verdict: OptionVerdict,
): OrderOption => ({
  ...option,
  bookableAlone: option.bookableAlone && verdict.outcome.state === "bookable",
  spanDaysByListingId: verdict.spanDaysByListingId,
  unitsByListingId:
    verdict.outcome.state === "bookable"
      ? verdict.outcome.unitsByListingId
      : option.unitsByListingId,
});

/** Judge every option in gallery order: the bookable packages lead, then the
 * listing cards. Each option asks the one judge what the booking form folds
 * for it, at the chosen date (or date-less, in the form's render phase). */
export const judgeOrderOptions = (
  catalog: OrderCatalog,
  date: string | null,
  holidays: Holiday[],
): OrderOption[] => [
  ...catalog.packages.map((pkg) =>
    judgedOption(
      packageOption(pkg.group, pkg.members, pkg.quantities, true),
      judgeOptionDemand({
        childrenByParentId: catalog.childrenByParentId,
        date,
        holidays,
        isPackage: true,
        parents: pkg.members.map((member) =>
          requiredMapValue(
            catalog.parentInfoById,
            member.id,
            `Package member ${member.id} left the catalog`,
          ),
        ),
        quantities: pkg.quantities,
      }),
    ),
  ),
  ...catalog.ticketListings.map((info) =>
    judgedOption(
      listingOption(info.listing, !info.isSoldOut && !info.isClosed),
      judgeOptionDemand({
        childrenByParentId: catalog.childrenByParentId,
        date,
        holidays,
        isPackage: false,
        parents: [info],
        quantities: new Map([[info.listing.id, info.listing.min_quantity]]),
      }),
    ),
  ),
];

/** Load the order page's catalog: the selectable listing cards, bookable
 * packages with their members, and the children the options' demand folds.
 * Reads are flat in the catalog's size: one hydration covers every parent's
 * children, and judging adds no reads. */
export const loadOrderCatalog = async (): Promise<OrderCatalog> => {
  const [listings, packageGroups] = await Promise.all([
    loadOrderListings(),
    loadBookablePackages(),
  ]);
  const [classification, priceRowsByGroupId] = await Promise.all([
    classifyForDiscovery(listings),
    getGroupPackagePricesByGroupIds(packageGroups.map(({ group }) => group.id)),
  ]);
  // Drop non-standalone children (not selectable). Then build the cards, and
  // project a parent to sold out when no child can be booked. A
  // `bookable_alone` child keeps its card and joins the cart like any listing.
  // When its parent reaches a booking page, alone or inside a package, the
  // form re-folds it there. The parent's child selector then chooses its
  // units.
  const offered = listings.filter(
    (e) => !classification.nonStandaloneChildIds.has(e.id),
  );
  const ticketListings = applyParentSoldOut(
    await buildTicketListingsWithGroupCapacity(offered),
    classification,
  );
  // A bookable bundle always has membership price rows.
  const packages = packageGroups.map(
    ({ group, members }): OrderPackage => ({
      group,
      members,
      quantities: packageMemberMaps(
        requiredMapValue(
          priceRowsByGroupId,
          group.id,
          `Package prices missing for group ${group.id}`,
        ),
      ).quantities,
    }),
  );
  // Every option's children load once here, so the judge can answer the
  // demand the form will fold for each option without reading again.
  const memberListings = uniqueBy((listing: ListingWithCount) => listing.id)(
    packages.flatMap((pkg) => pkg.members),
  );
  const cardIds = new Set(ticketListings.map((info) => info.listing.id));
  const parentInfos = [
    ...ticketListings,
    ...(await buildTicketListingsWithGroupCapacity(
      memberListings.filter((listing) => !cardIds.has(listing.id)),
    )),
  ];
  const childrenByParentId = await loadChildrenByParentId(parentInfos);
  return {
    childListings: allChildListings(childrenByParentId),
    childrenByParentId,
    packages,
    parentInfoById: new Map(
      parentInfos.map((info): [number, TicketListing] => [
        info.listing.id,
        info,
      ]),
    ),
    ticketListings,
  };
};
