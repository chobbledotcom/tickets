import type { ListingType } from "#shared/types.ts";

/** The listing fields used by group-capacity lookups. */
export interface ListingForGroupLookup {
  id: number;
  listing_type: ListingType;
}

/** A listing's identity, capacity, and current booked quantity. */
export interface ListingCapacityRow extends ListingForGroupLookup {
  attendee_count: number;
  max_attendees: number;
}

/** Load values keyed by listing or group id for a set of days. */
export type PerIdDayLoader<Value> = (
  ids: number[],
  days: string[],
) => Promise<Map<number, Value>>;
