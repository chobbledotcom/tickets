/**
 * The `/listings` date filter's per-listing availability: ONE capacity
 * snapshot over the union of daily listing cards and package members,
 * whatever their booking spans. Each listing's result reads only its own
 * span's prefix of that snapshot. The widest-span read answers the page, and
 * adding packages adds no database round trips.
 */

import {
  groupRemainingForSpan,
  loadCapacitySnapshot,
  remainingFromSnapshot,
} from "#db/attendees/capacity/snapshot.ts";
import { listingGroups } from "#db/groups/table.ts";
import type { Holiday } from "#db/holidays.ts";
import { loadParentAndChildLinks } from "#db/listing-parents.ts";
import { filter, map, pipe, uniqueBy } from "#fp";
import { getBookableStartDates } from "#shared/dates.ts";
import {
  childCapacityPartsFor,
  combinedChildCapacityForParent,
} from "#shared/group-capacity.ts";
import { clampDurationDays, type ListingWithCount } from "#types";

/** The booked span a daily listing's card availability is judged over: a
 * customisable listing offers per-day starts (the span is chosen later), a
 * fixed daily listing books its whole duration. */
const cardSpanDays = (listing: ListingWithCount): number =>
  listing.customisable_days ? 1 : clampDurationDays(listing.duration_days);

/** The daily listings NOT bookable on `date`: outside their bookable calendar,
 * or without capacity for their span starting that day. One snapshot per
 * request answers every span in play. */
export const loadDailyDateAvailability = async (
  daily: readonly ListingWithCount[],
  date: string,
  holidays: readonly Holiday[],
): Promise<ReadonlySet<number>> => {
  const rows = uniqueBy((listing: ListingWithCount) => listing.id)([...daily]);
  if (rows.length === 0) return new Set();
  const widestSpan = Math.max(...rows.map(cardSpanDays));
  const snapshot = await loadCapacitySnapshot([...rows], date, widestSpan);
  const remaining = remainingFromSnapshot(snapshot, rows, cardSpanDays);
  // A parent with required children needs the children's combined capacity on
  // the date, not merely its own places: a minimum its children cannot serve
  // makes the date as unavailable as an empty row.
  const links = await loadParentAndChildLinks(rows.map((row) => row.id));
  const memberships = await listingGroups.getIdsByKeys(
    rows.map((row) => row.id),
  );
  const belowMinimumFor = (listing: ListingWithCount): boolean => {
    if (remaining.get(listing.id)! < listing.min_quantity) {
      return true;
    }
    const children = links.childrenByParent.get(listing.id);
    if (!children || children.length === 0) return false;
    const combined = combinedChildCapacityForParent(
      memberships.get(listing.id) ?? [],
      childCapacityPartsFor(memberships)(
        children,
        (child) => child.id,
        (child) => remaining.get(child.id) ?? 0,
      ),
      groupRemainingForSpan(snapshot, cardSpanDays(listing)),
    );
    return combined < listing.min_quantity;
  };
  return new Set(
    pipe(
      filter(
        (listing: ListingWithCount) =>
          !getBookableStartDates(listing, [...holidays]).includes(date) ||
          belowMinimumFor(listing),
      ),
      map((listing: ListingWithCount) => listing.id),
    )(rows),
  );
};
