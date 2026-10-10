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
import type { Holiday } from "#db/holidays.ts";
import { loadParentAndChildLinks } from "#db/listing-parents.ts";
import { uniqueBy } from "#fp";
import { minimumUnservable } from "#shared/capacity-fit.ts";
import { getBookableStartDates } from "#shared/dates.ts";
import { clampDurationDays, type ListingWithCount } from "#types";
import {
  type ChildDateCapacityCtx,
  childDateCapacityParts,
} from "./discovery/child-date-capacity.ts";
import { parentOfferedDayCounts } from "./discovery/child-offered.ts";

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
    // The child's own ceiling folds its stored minimum and its gates the
    // same way the public cards do: a child with a minimum of 3 and 10
    // places left can serve 1 unit, not 10. An inactive child, a closed
    // child, or a daily child that cannot start on this date serves none.
    // Raw remaining lets the date filter advertise a parent the discovery
    // cards read as sold out.
    const dayCounts = parentOfferedDayCounts(listing);
    const children = links.childrenByParent.get(listing.id) ?? [];
    const childCapacityCtx: ChildDateCapacityCtx = {
      date,
      dayCounts,
      holidays,
      // The fold consumes each child over the parent's booked span, so the
      // child's remaining reads over that span, not the child's own card's.
      remaining: remainingFromSnapshot(snapshot, children, () =>
        cardSpanDays(listing),
      ),
    };
    const parts = childDateCapacityParts(
      children,
      memberships,
      childCapacityCtx,
    );
    if (
      minimumUnservable(
        remaining.get(listing.id)!,
        listing.min_quantity,
        memberships.get(listing.id)!,
        parts,
        groupRemainingForSpan(snapshot, cardSpanDays(listing)),
      )
    ) {
      soldOut.add(listing.id);
    }
  }
  return soldOut;
};
