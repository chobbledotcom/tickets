/** isBookingRangeValid is a validity predicate over user-submitted input: a
 *  date the strict parser refuses must answer false, never throw, so the
 *  caller reports the listing's own not-available message. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { isBookingRangeValid } from "#shared/dates.ts";
import { VALID_DAY_NAMES } from "#shared/day-names.ts";
import { testListing } from "#test-utils/factories.ts";

const dailyAllDays = () =>
  testListing({
    bookableDays: [...VALID_DAY_NAMES],
    listingType: "daily",
    maximumDaysAfter: 10,
    minimumDaysBefore: 0,
  });

describe("isBookingRangeValid malformed submitted dates", () => {
  test("returns false for a malformed submitted date instead of throwing", () => {
    expect(isBookingRangeValid(dailyAllDays(), "not-a-date", 3, [])).toBe(
      false,
    );
    expect(isBookingRangeValid(dailyAllDays(), "2027-2-30", 3, [])).toBe(false);
  });

  test("returns false for an empty submitted date", () => {
    expect(isBookingRangeValid(dailyAllDays(), "", 3, [])).toBe(false);
  });
});
