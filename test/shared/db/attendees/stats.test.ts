import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import type { ActiveListingStats } from "#db/attendee-types.ts";
import { getActiveListingStats } from "#db/attendees/stats.ts";
import { getAllListings } from "#db/listings/records.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createPaidTestAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

/** One booking to place: the attendee's name, the listing's ticket price, and
 *  what the attendee paid, both in minor units. */
type Booking = readonly [name: string, unitPrice: number, amount: number];

/** One case: the bookings to place, the listings to read as inactive, and the
 *  stats that must come back. */
type StatsCase = readonly [
  name: string,
  bookings: readonly Booking[],
  inactive: readonly string[],
  expected: ActiveListingStats,
];

/** Read the active-listing stats after placing each booking on a listing of
 *  its own. A listing named in `inactive` reads as an inactive row. */
const statsFor = async (
  bookings: readonly Booking[],
  inactive: readonly string[] = [],
) => {
  for (const [name, unitPrice, amount] of bookings) {
    const listing = await createTestListing({
      maxAttendees: 50,
      name,
      unitPrice,
    });
    const slug = name.toLowerCase().replaceAll(" ", "-");
    await createPaidTestAttendee(
      listing.id,
      name,
      `${slug}@example.com`,
      amount === 0 ? "" : `pay_${slug}`,
      amount,
    );
  }
  const listings = await getAllListings();
  return getActiveListingStats(
    listings.map((listing) =>
      inactive.includes(listing.name) ? { ...listing, active: false } : listing,
    ),
  );
};

describeWithEnv(
  "db > attendees > getActiveListingStats",
  {
    db: true,
    triggers: true,
  },
  () => {
    test("returns zeros for empty listings", async () => {
      expect(await getActiveListingStats([])).toEqual({
        attendees: 0,
        income: 0,
        tickets: 0,
      });
    });

    const cases: readonly StatsCase[] = [
      [
        "returns zeros when all listings inactive",
        [["Alice", 500, 1000]],
        ["Alice"],
        { attendees: 0, income: 0, tickets: 0 },
      ],
      [
        "counts tickets and sums income for active listings",
        [
          ["Alice", 500, 1000],
          ["Bob", 500, 2000],
        ],
        [],
        { attendees: 2, income: 3000, tickets: 2 },
      ],
      [
        "excludes inactive listings",
        [
          ["Alice", 500, 1000],
          ["Bob", 500, 2000],
        ],
        ["Bob"],
        { attendees: 1, income: 1000, tickets: 1 },
      ],
      [
        "includes a free booking with zero income",
        [["Free Alice", 0, 0]],
        [],
        { attendees: 1, income: 0, tickets: 1 },
      ],
    ];

    for (const [name, bookings, inactive, expected] of cases) {
      test(name, async () => {
        expect(await statsFor(bookings, inactive)).toEqual(expected);
      });
    }
  },
);
