import type { ListingWithCount } from "#types";

/** The listing fields used by group-capacity lookups. */
export type ListingForGroupLookup = Pick<
  ListingWithCount,
  "id" | "listingType"
>;

/** A listing's identity, capacity, and current booked quantity. */
export type ListingCapacityRow = ListingForGroupLookup &
  Pick<ListingWithCount, "attendeeCount" | "maxAttendees">;

/** Load values keyed by listing or group id for a set of days. */
export type PerIdDayLoader<Value> = (
  ids: number[],
  days: string[],
) => Promise<Map<number, Value>>;
