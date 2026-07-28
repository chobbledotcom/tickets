/**
 * Unified listing sorting — deterministic ordering for all listing lists.
 *
 * Tier 0: Standard listings with no date → sorted by name
 * Tier 1: Standard listings with dates  → sorted by date ASC, then name
 * Tier 2: Daily listings                → sorted by next bookable date ASC, then name
 */

import { getNextBookableDate } from "#shared/dates.ts";
import { getActiveHolidays } from "#shared/db/holidays.ts";
import { getAllListings } from "#shared/db/listings/records.ts";
import type {
  Holiday,
  ListingWithCount,
  SortableListing,
} from "#shared/types.ts";

export type { ListingWithCount };

/** Tier assignment: no-date standard=0, dated standard=1, daily=2 */
const listingTier = (listing: SortableListing): number => {
  if (listing.listing_type === "daily") return 2;
  return listing.date === "" ? 0 : 1;
};

const compareDateThenName = (
  dateA: string,
  dateB: string,
  a: SortableListing,
  b: SortableListing,
): number => {
  const cmp = dateA.localeCompare(dateB);
  return cmp !== 0 ? cmp : a.name.localeCompare(b.name);
};

/** Tier 1: dated standard — sort by date ASC, then name */
const compareDatedStandard = (a: SortableListing, b: SortableListing): number =>
  compareDateThenName(a.date, b.date, a, b);

/** Tier 2: daily — sort by next bookable date ASC, then name */
const compareDaily = (
  nextDates: Map<number, string | null>,
  a: SortableListing,
  b: SortableListing,
): number => {
  const dateA = nextDates.get(a.id) ?? null;
  const dateB = nextDates.get(b.id) ?? null;
  if (dateA === null && dateB === null) return a.name.localeCompare(b.name);
  if (dateA === null) return 1;
  if (dateB === null) return -1;
  return compareDateThenName(dateA, dateB, a, b);
};

/**
 * Create a comparator that uses pre-computed next-bookable-dates for daily listings.
 */
const compareListings =
  (nextDates: Map<number, string | null>) =>
  (a: SortableListing, b: SortableListing): number => {
    const tierA = listingTier(a);
    const tierB = listingTier(b);
    if (tierA !== tierB) return tierA - tierB;
    if (tierA === 0) return a.name.localeCompare(b.name);
    if (tierA === 1) return compareDatedStandard(a, b);
    return compareDaily(nextDates, a, b);
  };

/**
 * Sort listings in unified 3-tier order. Takes anything carrying the values the
 * order is built from, so a narrow picker read sorts the same way a full
 * listing record does.
 */
export const sortListings = <T extends SortableListing>(
  listings: T[],
  holidays: Holiday[],
): T[] => {
  const nextDates = new Map<number, string | null>();
  for (const listing of listings) {
    if (listing.listing_type === "daily") {
      nextDates.set(listing.id, getNextBookableDate(listing, holidays));
    }
  }
  return [...listings].sort(compareListings(nextDates));
};

/** Load all listings with holidays and return them sorted. With a filter, only
 * the listings it keeps are returned; without one, every listing is returned. */
export const loadSortedListings = async (
  keepListing: (listing: ListingWithCount) => boolean = () => true,
): Promise<{ listings: ListingWithCount[]; holidays: Holiday[] }> => {
  const [allListings, holidays] = await Promise.all([
    getAllListings(),
    getActiveHolidays(),
  ]);
  const listings = sortListings(allListings.filter(keepListing), holidays);
  return { holidays, listings };
};
