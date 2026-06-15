import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { checkBatchAvailability } from "#shared/db/attendees.ts";
import { addDays } from "#shared/dates.ts";
import { getAttendeesByListingIds } from "#shared/db/listings.ts";
import { todayInTz } from "#shared/timezone.ts";
import {
  assertPublicHtml,
  bookAttendee,
  createTestListing,
  describeWithEnv,
  expectRedirect,
  submitMultiTicketForm,
} from "#test-utils";

const ALL_DAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

/** A daily listing bookable every day within a two-week window. */
const createDaily = (name: string, overrides = {}) =>
  createTestListing({
    bookableDays: ALL_DAYS,
    listingType: "daily",
    maximumDaysAfter: 14,
    minimumDaysBefore: 0,
    name,
    ...overrides,
  });

describeWithEnv("server (mixed standard + daily order)", { db: true }, () => {
  test("books a standard and a daily item together in one order", async () => {
    const standard = await createTestListing({ name: "Mug" });
    const daily = await createDaily("Day Pass");
    const date = addDays(todayInTz("UTC"), 1);

    const response = await submitMultiTicketForm(
      `${standard.slug}+${daily.slug}`,
      {
        date,
        email: "buyer@example.com",
        name: "Buyer",
        [`quantity_${standard.id}`]: "1",
        [`quantity_${daily.id}`]: "1",
      },
    );

    expectRedirect(response, /^\/ticket\/reserved/);

    const [standardAttendees, dailyAttendees] = await Promise.all([
      getAttendeesByListingIds([standard.id]),
      getAttendeesByListingIds([daily.id]),
    ]);
    expect(standardAttendees.length).toBe(1);
    expect(dailyAttendees.length).toBe(1);
    // The order-wide date applies to the daily item only; the standard is dateless.
    expect(standardAttendees[0]?.date).toBeNull();
    expect(dailyAttendees[0]?.date).toBe(date);
  });

  test("the availability checker accepts a mixed order that fits", async () => {
    const standard = await createTestListing({ maxAttendees: 5, name: "Mug" });
    const daily = await createDaily("Day Pass", { maxAttendees: 5 });
    const date = addDays(todayInTz("UTC"), 1);

    const fits = await checkBatchAvailability(
      [
        { date: null, durationDays: 1, listingId: standard.id, quantity: 2 },
        { date, durationDays: 1, listingId: daily.id, quantity: 2 },
      ],
      date,
    );
    expect(fits).toBe(true);
  });

  test("the whole mixed order is rejected when the daily line is full on the date", async () => {
    const standard = await createTestListing({ maxAttendees: 5, name: "Mug" });
    const daily = await createDaily("Day Pass", { maxAttendees: 1 });
    const date = addDays(todayInTz("UTC"), 1);
    // Fill the daily listing's single seat on that date.
    await bookAttendee(daily, { date, quantity: 1 });

    const fits = await checkBatchAvailability(
      [
        { date: null, durationDays: 1, listingId: standard.id, quantity: 1 },
        { date, durationDays: 1, listingId: daily.id, quantity: 1 },
      ],
      date,
    );
    // The standard line fits, but one failing line rejects the whole order.
    expect(fits).toBe(false);
  });

  test("daily items with no shared date cannot be booked together", async () => {
    const mon = await createDaily("Monday Pass", {
      bookableDays: ["Monday"],
      maximumDaysAfter: 21,
    });
    const tue = await createDaily("Tuesday Pass", {
      bookableDays: ["Tuesday"],
      maximumDaysAfter: 21,
    });
    await assertPublicHtml(
      `/ticket/${mon.slug}+${tue.slug}`,
      "No dates are currently available for booking",
    );
  });
});
