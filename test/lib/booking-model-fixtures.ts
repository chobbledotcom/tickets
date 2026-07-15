import {
  buildTicketListing,
  type TicketListing,
} from "#shared/booking/model.ts";
import { DAY_NAMES, VALID_DAY_NAMES } from "#shared/day-names.ts";
import { todayInTz } from "#shared/timezone.ts";
import type { ListingWithCount } from "#shared/types.ts";
import { testListingWithCount } from "#test-utils/factories.ts";

/** Shared fixtures for the booking-model-*.test.ts suite (split across
 * several files to keep each test target narrow — see AGENTS.md's file-size
 * guidance). Not itself a test file. */

export const today = (): string => todayInTz("UTC");

export const weekdayOf = (dateStr: string): string =>
  DAY_NAMES[new Date(`${dateStr}T00:00:00Z`).getUTCDay()]!;

export const listing = (
  over: Partial<ListingWithCount> = {},
): ListingWithCount => testListingWithCount({ id: 1, ...over });

export const resolved = (
  over: Partial<ListingWithCount> = {},
  closed = false,
  groupRemaining?: number,
): TicketListing => buildTicketListing(listing(over), closed, groupRemaining);

export const dailyOverrides = (
  over: Partial<ListingWithCount> = {},
): Partial<ListingWithCount> => ({
  bookable_days: [...VALID_DAY_NAMES],
  listing_type: "daily",
  maximum_days_after: 10,
  minimum_days_before: 0,
  ...over,
});

/** One customisable child under parent id 1, supporting only a 2-day booking. */
export const oneChildSupportingDayTwo = (): ReadonlyMap<
  number,
  TicketListing[]
> =>
  new Map([
    [
      1,
      [
        resolved({
          customisable_days: true,
          day_prices: { 2: 200 },
          duration_days: 2,
          id: 10,
        }),
      ],
    ],
  ]);
