import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { attendeesApi } from "#db/attendees/api.ts";
import { listingChildren } from "#db/listing-parents.ts";
import type { ParsedAttendeeForm } from "#routes/admin/attendee-form-model.ts";
import {
  buildCreateForm,
  type PackagePath,
} from "#routes/admin/attendee-page-data.ts";
import { computeWarnings } from "#routes/admin/booking-warnings.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createDailyTestListing,
  createTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { testListingWithCount } from "#test-utils/factories.ts";
import type { ListingWithCount } from "#types";

/** Book places on one listing through the same atomic create the ticket page
 * uses, so the capacity checks in the warnings read real stored rows. */
const bookPlaces = async (
  listingId: number,
  bookings: readonly { date: string; quantity: number }[],
): Promise<void> => {
  const result = await attendeesApi.createAttendeeAtomic({
    bookings: bookings.map((booking) => ({ ...booking, listingId })),
    email: "seeded-bookings@example.com",
    name: "Seeded booking",
  });
  expect(result.success).toBe(true);
};

/** The warnings the manual form shows for a booking that takes one place on
 * the first listing, over the shared start date and day count. `paths` adds
 * package paths; `edit` adjusts the parsed form for the cases the arguments
 * cannot express. */
const warningsForBooking = async (
  listings: readonly ListingWithCount[],
  opts: {
    dayCount?: number;
    edit?: (parsed: ParsedAttendeeForm) => void;
    paths?: PackagePath[];
    startDate?: string;
  } = {},
) => {
  const parsed = buildCreateForm(
    listings.map(testListingWithCount),
    opts.paths ?? [],
    new Map([[listings[0]!.id, 1]]),
    opts.startDate ?? "",
  );
  if (opts.dayCount !== undefined) parsed.dayCount = opts.dayCount;
  opts.edit?.(parsed);
  return computeWarnings(parsed, undefined);
};

/** Book places on one listing through the same atomic create the ticket page
 * uses, so the capacity checks in the warnings read real stored rows. */
const bookPlaces = async (
  listingId: number,
  bookings: readonly { date: string; quantity: number }[],
): Promise<void> => {
  const result = await attendeesApi.createAttendeeAtomic({
    bookings: bookings.map((booking) => ({ ...booking, listingId })),
    email: "seeded-bookings@example.com",
    name: "Seeded booking",
  });
  expect(result.success).toBe(true);
};

describeWithEnv("booking warnings", { db: true }, () => {
  test("names every required child when a parent is booked alone", async () => {
    const parent = await createTestListing({ name: "Main pass" });
    const firstChild = await createTestListing({ name: "Morning child" });
    const secondChild = await createTestListing({ name: "Evening child" });
    await listingChildren.setIds(parent.id, [firstChild.id, secondChild.id]);

    const warnings = await warningsForBooking([
      parent,
      firstChild,
      secondChild,
    ]);

    const warning =
      "Main pass requires one of its child listings to be booked too (Morning child, Evening child) — public bookings choose one automatically; add it here.";
    expect(warnings.top).toEqual([warning]);
    expect(warnings.byListing).toEqual(new Map([[parent.id, [warning]]]));
  });

  test("sums standalone and package quantities into one capacity warning", async () => {
    const listing = await createTestListing({
      maxAttendees: 2,
      name: "Shared capacity",
    });
    const paths: PackagePath[] = [
      {
        groupId: 42,
        memberListingIds: [listing.id],
        memberPrices: new Map(),
        packageName: "Capacity package",
      },
    ];

    const warnings = await warningsForBooking([listing], {
      edit: (parsed) => {
        parsed.lines.find((line) => line.packageGroupId === 42)!.quantity = 2;
      },
      paths,
    });

    const warning =
      "Shared capacity is overbooked — there isn't capacity for 3 on these dates.";
    expect(warnings.top).toEqual([warning]);
    expect(warnings.byListing).toEqual(new Map([[listing.id, [warning]]]));
  });

  test("warns when a daily booking spans more days than its duration allows", async () => {
    const listing = await createDailyTestListing({
      durationDays: 1,
      name: "Long weekend",
    });

    const warnings = await warningsForBooking([listing], {
      dayCount: 2,
      startDate: "2026-07-01",
    });

    expect(warnings.top).toEqual([
      "Long weekend is designed for up to 1 day, but the booking spans 2.",
    ]);
    expect(warnings.byListing).toEqual(
      new Map([
        [
          listing.id,
          [
            "Long weekend is designed for up to 1 day, but the booking spans 2.",
          ],
        ],
      ]),
    );
  });

  test("stays quiet when a daily booking fits its duration", async () => {
    const listing = await createDailyTestListing({
      durationDays: 3,
      name: "Week pass",
    });

    const warnings = await warningsForBooking([listing], {
      dayCount: 2,
      startDate: "2026-07-01",
    });

    expect(warnings.top).toEqual([]);
  });

  test("never warns about a standard listing's day span", async () => {
    const listing = await createTestListing({
      durationDays: 1,
      name: "Standard entry",
    });

    const warnings = await warningsForBooking([listing], {
      dayCount: 2,
      startDate: "2026-07-01",
    });

    expect(warnings.top).toEqual([]);
  });

  test("judges a daily booking against its own booked day", async () => {
    const listing = await createDailyTestListing({
      maxAttendees: 2,
      name: "Two a day",
    });
    await bookPlaces(listing.id, [{ date: "2026-07-01", quantity: 2 }]);

    const warnings = await warningsForBooking([listing], {
      startDate: "2026-07-02",
    });

    expect(warnings.top).toEqual([]);
  });

  test("spans a daily booking's whole range when checking capacity", async () => {
    const listing = await createDailyTestListing({
      durationDays: 5,
      maxAttendees: 1,
      name: "One a day",
    });
    await bookPlaces(listing.id, [{ date: "2026-07-02", quantity: 1 }]);

    const warnings = await warningsForBooking([listing], {
      dayCount: 2,
      startDate: "2026-07-01",
    });

    expect(warnings.top).toEqual([
      "One a day is overbooked — there isn't capacity for 1 on these dates.",
    ]);
  });

  test("counts one booked line once when checking capacity", async () => {
    const listing = await createTestListing({
      maxAttendees: 1,
      name: "Single place",
    });

    const warnings = await warningsForBooking([listing]);

    expect(warnings.top).toEqual([]);
  });
});
