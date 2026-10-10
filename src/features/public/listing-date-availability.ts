/**
 * The `/listings` date filter's per-listing availability: ONE capacity
 * snapshot over the union of daily listing cards and package members,
 * whatever their booking spans. Each listing's result reads only its own
 * span's prefix of that snapshot. The widest-span read answers the page, and
 * adding packages adds no database round trips.
 */

import { buildTicketListing, childSupportsDays } from "#booking/model.ts";
import {
  groupRemainingForSpan,
  loadCapacitySnapshot,
  remainingFromSnapshot,
} from "#db/attendees/capacity/snapshot.ts";
import type { Holiday } from "#db/holidays.ts";
import { loadParentAndChildLinks } from "#db/listing-parents.ts";
import { uniqueBy } from "#fp";
import { isRegistrationClosed } from "#routes/format.ts";
import { minimumUnservable } from "#shared/capacity-fit.ts";
import { getBookableStartDates } from "#shared/dates.ts";
import { clampDurationDays, type ListingWithCount } from "#types";
import { childDateCapacityParts } from "./discovery/child-date-capacity.ts";
import { dailyOfferedDayCounts } from "./discovery/child-offered.ts";

/** The booked span a daily listing's card availability is judged over. A
 *  customisable listing offers per-day starts, so the span is chosen later.
 *  A fixed daily listing books its whole duration. */
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
  // A parent with required children needs the children's combined capacity on
  // the date, not merely its own places: a minimum its children cannot serve
  // makes the date as unavailable as an empty row. A hidden or standard child
  // is no public card, so the links load it here and the snapshot reads its
  // capacity beside the cards.
  const links = await loadParentAndChildLinks(rows.map((row) => row.id));
  const linkedChildren = uniqueBy((listing: ListingWithCount) => listing.id)(
    [...links.childrenByParent.values()].flat(),
  );
  const judged = uniqueBy((listing: ListingWithCount) => listing.id)([
    ...rows,
    ...linkedChildren,
  ]);
  const widestSpan = Math.max(...judged.map(cardSpanDays));
  const snapshot = await loadCapacitySnapshot([...judged], date, widestSpan);
  const remaining = remainingFromSnapshot(snapshot, judged, cardSpanDays);
  // The snapshot's own membership: the same read the figures were built
  // from, so the allocation ledger and the capacity figures cannot disagree.
  const memberships = snapshot.membership;
  const soldOut = new Set<number>();
  for (const listing of rows) {
    if (!getBookableStartDates(listing, [...holidays]).includes(date)) {
      soldOut.add(listing.id);
      continue;
    }
    // The fold consumes each child over the span the buyer's day count
    // books, and a child only rides a count it supports. Each offered count
    // answers on its own, and the date is available when any one of them
    // serves the minimum. A count no child supports books no fold at all.
    const children = links.childrenByParent.get(listing.id) ?? [];
    const dayCounts = dailyOfferedDayCounts(listing);
    const childInfos = children.map((child) =>
      buildTicketListing(child, isRegistrationClosed(child), undefined),
    );
    const compatibleCounts = dayCounts.filter((count) =>
      childInfos.every((info) => childSupportsDays(info, count)),
    );
    const spanRemaining = groupRemainingForSpan(
      snapshot,
      cardSpanDays(listing),
    );
    const unservable =
      compatibleCounts.length === 0 ||
      compatibleCounts.every((count) =>
        minimumUnservable(
          remaining.get(listing.id)!,
          listing.min_quantity,
          memberships.get(listing.id)!,
          childDateCapacityParts(children, memberships, {
            date,
            dayCounts,
            holidays,
            remaining: remainingFromSnapshot(snapshot, children, () => count),
          }),
          spanRemaining,
        ),
      );
    if (unservable) {
      soldOut.add(listing.id);
    }
  }
  return soldOut;
};
