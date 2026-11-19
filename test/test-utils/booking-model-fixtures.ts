import { buildTicketListing, type TicketListing } from "#booking/model.ts";
import { DAY_NAMES, VALID_DAY_NAMES } from "#shared/day-names.ts";
import { todayInTz } from "#shared/timezone.ts";
import { testListingWithCount } from "#test-utils/factories.ts";
import type { ListingWithCount } from "#types";

/** Shared fixtures for the booking-model-*.test.ts suite (split across
 * several files to keep each test target narrow — see AGENTS.md's file-size
 * guidance). Not itself a test file. */

export const today = (): string => todayInTz("UTC");

export const weekdayOf = (dateStr: string): (typeof DAY_NAMES)[number] =>
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
  bookableDays: [...VALID_DAY_NAMES],
  listingType: "daily",
  maximumDaysAfter: 10,
  minimumDaysBefore: 0,
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
          customisableDays: true,
          dayPrices: { 2: 200 },
          durationDays: 2,
          id: 10,
        }),
      ],
    ],
  ]);
