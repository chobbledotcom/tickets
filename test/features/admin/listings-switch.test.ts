import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { withTransaction } from "#db/client.ts";
import { moveUndatedBookingsToDayTx } from "#db/listings/daily-switch.ts";
import { listingsTable } from "#db/listings/records.ts";
import {
  planListingTypeSwitch,
  probeAssignDates,
  wouldBeStartDates,
} from "#routes/admin/listings-switch.ts";
import type { ListingInput } from "#shared/catalog-fields/fields.ts";
import { inputFor } from "#test/shared/listings-actions/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import {
  allDays,
  bookableStartDates,
  createTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { testFormParams } from "#test-utils/form-values.ts";
import type { ListingWithCount } from "#types";

/** A would-be daily input over the stored row: the row's own fields with the
 * caller's submitted daily fields on top. */
const wouldBeInput = (
  stored: ListingWithCount,
  overrides: Partial<ListingInput> = {},
): ListingInput => ({
  ...(listingsTable.rowToInput(stored) as ListingInput),
  groupIds: [],
  ...overrides,
});

/** The booking rows of one listing, with their day windows. */
const rawRows = async (
  listingId: number,
): Promise<{ start_at: string | null }[]> => {
  const { queryAll } = await import("#db/client.ts");
  return queryAll(
    "SELECT start_at FROM listing_attendees WHERE listing_id = ?",
    [listingId],
  );
};

/** The switch form values an organiser submits for `stored`: the minimal valid
 * edit form, switched to daily, with the offered day under the assign field. */
const switchForm = (
  stored: ListingWithCount,
  extra: Record<string, string> = {},
): ReturnType<typeof testFormParams> =>
  testFormParams({
    assign_undated_to: "",
    bookable_days: [
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
      "Sunday",
    ],
    duration_days: "2",
    listing_type: "daily",
    max_attendees: String(stored.max_attendees),
    max_quantity: "1",
    maximum_days_after: "90",
    minimum_days_before: "1",
    name: stored.name,
    slug: stored.slug,
    thank_you_url: "https://example.com",
    ...extra,
  });

/** A two-place listing holding one undated booking — the switch's subject. */
const hallWithOneUndatedBooking = async (): Promise<ListingWithCount> => {
  const listing = await createTestListing({ maxAttendees: 2, name: "Hall" });
  await bookAttendee(listing, { quantity: 1 });
  return listing;
};

describeWithEnv("admin: the switch plan and its probe", { db: true }, () => {
  test("wouldBeStartDates falls back to the stored fields the submission omits", async () => {
    const stored = await createTestListing({
      bookableDays: allDays,
      listingType: "daily",
      maximumDaysAfter: 30,
      minimumDaysBefore: 2,
    });
    // The input carries none of the calendar fields, so the stored row's
    // window and days stand in for everything the submission left out.
    const offered = await wouldBeStartDates(
      stored,
      inputFor({ customisableDays: false, durationDays: 1 }),
    );
    const fromStored = await bookableStartDates(stored.id);
    expect(offered).toEqual(fromStored);
  });

  test("wouldBeStartDates uses the submitted fields when it carries them", async () => {
    const stored = await createTestListing({
      bookableDays: allDays,
      listingType: "daily",
      maximumDaysAfter: 30,
      minimumDaysBefore: 0,
    });
    const offered = await wouldBeStartDates(
      stored,
      wouldBeInput(stored, {
        bookableDays: ["Monday", "Tuesday"],
        customisableDays: false,
        durationDays: 1,
        maximumDaysAfter: 5,
        minimumDaysBefore: 0,
      }),
    );
    expect(offered.length).toBeGreaterThan(0);
    expect(offered).not.toEqual(await bookableStartDates(stored.id));
  });

  test("the probe judges each offered date with the production capacity SQL", async () => {
    const listing = await createTestListing({ maxAttendees: 2 });
    await bookAttendee(listing, { date: "2026-11-05", quantity: 2 });
    const fits = await probeAssignDates(
      listing,
      wouldBeInput(listing, { listingType: "daily" }),
      ["2026-11-05", "2026-11-06"],
      1,
      1,
    );
    expect(fits).toEqual([false, true]);
  });

  test("a probe write that fails for another reason propagates untouched", async () => {
    const listing = await createTestListing({ name: "Mine" });
    const taken = await createTestListing({ name: "Taken" });
    // The same blind slug index as the other listing: the probe's row write
    // violates the unique index, and the failure is no capacity verdict.
    const clash = wouldBeInput(listing, {
      slug: taken.slug,
      slugIndex: taken.slug_index,
    });
    await expect(
      probeAssignDates(listing, clash, ["2026-11-05"], 1, 1),
    ).rejects.toThrow();
  });

  test("the plan reads none when the save touches no undated booking", async () => {
    const listing = await createTestListing({ name: "Hall" });
    const step = await planListingTypeSwitch(
      listing,
      switchForm(listing, { listing_type: "standard" }),
    );
    expect(step.kind).toBe("none");
  });

  test("a form that fails validation stops the switch with the edit error", async () => {
    const listing = await hallWithOneUndatedBooking();
    const step = await planListingTypeSwitch(
      listing,
      switchForm(listing, { name: "" }),
    );
    expect(step.kind).toBe("invalid");
  });

  test("an unconfirmed plan serves the page and names the missing pick", async () => {
    const listing = await hallWithOneUndatedBooking();
    const step = await planListingTypeSwitch(listing, switchForm(listing));
    expect(step).toMatchObject({ kind: "page", status: 200 });
    if (step.kind !== "page") return;
    expect(step.error).toContain("Pick a date to move the bookings to.");
    expect(step.page.card.count).toBe(1);
    expect(step.page.card.dates.length).toBeGreaterThan(0);
    expect(step.page.submittedValues.listing_type).toBe("daily");
  });

  test("a pick outside the offered dates is refused with the pick error", async () => {
    const listing = await hallWithOneUndatedBooking();
    const step = await planListingTypeSwitch(
      listing,
      switchForm(listing, { assign_undated_to: "2020-01-01" }),
    );
    expect(step).toMatchObject({ kind: "page", status: 400 });
  });

  test("a confirmed pick carries the move into the save", async () => {
    const listing = await hallWithOneUndatedBooking();
    const [day] = await bookableStartDates(listing.id);
    const step = await planListingTypeSwitch(
      listing,
      switchForm(listing, { assign_undated_to: day! }),
    );
    expect(step).toMatchObject({
      kind: "assign",
      plan: { count: 1, date: day },
    });
    if (step.kind !== "assign") return;
    await withTransaction(async (tx) => {
      const moved = await moveUndatedBookingsToDayTx(
        tx,
        listing.id,
        listing.name,
        step.plan.date,
        1,
      );
      expect(moved).toBe(1);
    });
    const rows = await rawRows(listing.id);
    expect(rows[0]!.start_at).toContain(day!);
  });
});
