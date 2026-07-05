import { createTestListing } from "#test-utils";

/** Every weekday, so a daily listing is bookable any day of the week — the
 * base setup shared by every daily-listing test in this folder that isn't
 * specifically testing a restricted `bookableDays` set. */
export const ALL_WEEKDAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

/** A daily listing bookable any day, 0-14 days out. Colocated here rather
 * than duplicating the `bookableDays`/`listingType`/`minimumDaysBefore`/
 * `maximumDaysAfter` quartet across `daily-listings-single.test.ts`,
 * `daily-listings-multi.test.ts`, and `custom-questions-single.test.ts`. */
export const createDailyListing = (overrides: Record<string, unknown> = {}) =>
  createTestListing({
    bookableDays: ALL_WEEKDAYS,
    listingType: "daily",
    maximumDaysAfter: 14,
    minimumDaysBefore: 0,
    ...overrides,
  });
