import { createTestListing } from "#test-utils/db-helpers.ts";

/** Creates a daily listing bookable on every day of the week, from today up to
 *  14 days out. This is the shared fixture behind the daily-view roster and the
 *  date-filter tests, which each need a listing that accepts a booking on any
 *  near-future date. */
export const createEveryDayDailyListing = () =>
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
