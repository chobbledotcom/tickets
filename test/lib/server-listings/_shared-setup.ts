import type { Listing } from "#shared/types.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

/** Creates a daily listing bookable on every day of the week, open from today
 *  up to two weeks out. The shared starting point for the daily-view and
 *  date-filter tests in this folder. */
export const createDailyListing = (): Promise<Listing> =>
  createTestListing({
    bookableDays: [
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
      "Sunday",
    ],
    listingType: "daily",
    maximumDaysAfter: 14,
    minimumDaysBefore: 0,
  });
