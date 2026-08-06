import { useListingById } from "./listing.ts";
import { loadCapacitySnapshot, remainingFromSnapshot } from "./snapshot.ts";
import type { ListingCapacityRow } from "./types.ts";

/** Remaining bookable units for each listing over a date range. */
export function getListingRemainingForRange(
  listings: ListingCapacityRow[],
  date: string | null,
  durationDays?: number,
): Promise<Map<number, number>>;
export function getListingRemainingForRange(
  listingId: number,
  date: string | null,
  durationDays?: number,
): Promise<number | undefined>;
export async function getListingRemainingForRange(
  listingsOrId: ListingCapacityRow[] | number,
  date: string | null,
  durationDays = 1,
): Promise<Map<number, number> | number | undefined> {
  if (typeof listingsOrId === "number") {
    return useListingById(listingsOrId, undefined, async (listing) =>
      (await getListingRemainingForRange([listing], date, durationDays)).get(
        listingsOrId,
      ),
    );
  }
  // Every listing here shares one span, so the widest-span snapshot is that
  // span and each listing reads all of its days.
  const snapshot = await loadCapacitySnapshot(listingsOrId, date, durationDays);
  return remainingFromSnapshot(snapshot, listingsOrId, () => durationDays);
}
