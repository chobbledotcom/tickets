// test-groups: run-alone
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { queryAll, withTransaction } from "#db/client.ts";
import { holidays } from "#db/holidays.ts";
import { moveUndatedBookingsToDayTx } from "#db/listings/daily-switch.ts";
import { listingsTable } from "#db/listings/records.ts";
import { t } from "#i18n";
import {
  planListingTypeSwitch,
  probeAssignDates,
  type SwitchStep,
  wouldBeStartDates,
} from "#routes/admin/listings-switch.ts";
import type { ListingInput } from "#shared/catalog-fields/fields.ts";
import { getBookableStartDates } from "#shared/dates.ts";
import { inputFor } from "#test/shared/listings-actions/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { buildUpdateListingForm } from "#test-utils/db-helpers/listing-forms.ts";
import {
  allDays,
  bookableStartDates,
  createTestListing,
  listingWithTwoUndatedBookings,
} from "#test-utils/db-helpers/listings.ts";
import { testFormParams } from "#test-utils/form-values.ts";
import { adminMultipartPost } from "#test-utils/session.ts";
import type { ListingWithCount } from "#types";

/** Set a listing's stored capacity, so a test can seat a dated booking past
 * the cap the switch later judges against. */
const setCapacity = (listingId: number, max: number) =>
  queryAll("UPDATE listings SET max_attendees = ? WHERE id = ?", [
    max,
    listingId,
  ]);

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
  extra: Record<string, string | string[]> = {},
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

/** The plan for a save that names its day: the confirmed pick's step. */
const confirmedPickStep = (
  listing: ListingWithCount,
  day: string,
): Promise<SwitchStep> =>
  planListingTypeSwitch(
    listing,
    switchForm(listing, { assign_undated_to: day }),
  );

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
    const offered = await wouldBeStartDates(stored, inputFor({}));
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

  test("wouldBeStartDates keeps a submitted false or zero over the stored value", async () => {
    // The stored row lets the visitor choose the span, so its own start
    // dates take a one-day stay.
    const stored = {
      ...(await createTestListing({
        bookableDays: allDays,
        listingType: "daily",
        maximumDaysAfter: 30,
        minimumDaysBefore: 2,
      })),
      customisable_days: true,
    };
    const submitted = {
      bookableDays: ["Monday", "Tuesday"],
      customisableDays: false,
      durationDays: 2,
      maximumDaysAfter: 0,
      minimumDaysBefore: 0,
    };
    // A two-day stay over Monday and Tuesday starts only on a Monday, and an
    // open-ended window from today reaches past the stored thirty days.
    const expected = getBookableStartDates(
      {
        ...stored,
        bookable_days: submitted.bookableDays,
        customisable_days: false,
        duration_days: 2,
        maximum_days_after: 0,
        minimum_days_before: 0,
      },
      await holidays.getAll(),
    );
    expect(
      await wouldBeStartDates(stored, wouldBeInput(stored, submitted)),
    ).toEqual(expected);
  });

  test("the probe judges each offered date with the production per-day cap SQL", async () => {
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

  test("the probe asks for the places the bookings hold, not their rows", async () => {
    const listing = await listingWithTwoUndatedBookings({ maxAttendees: 5 });
    const day = (await bookableStartDates(listing.id))[0]!;
    // One dated place occupies the day; the cap only widens while it is set.
    const { queryAll } = await import("#db/client.ts");
    await queryAll("UPDATE listings SET max_attendees = 6 WHERE id = ?", [
      listing.id,
    ]);
    await bookAttendee(listing, {
      date: day,
      email: "z@example.com",
      name: "Z",
    });
    await queryAll("UPDATE listings SET max_attendees = 5 WHERE id = ?", [
      listing.id,
    ]);
    // The two bookings hold five places against four free: asking for their
    // row count (2) would wrongly fit.
    const fits = await probeAssignDates(
      listing,
      wouldBeInput(listing, { listingType: "daily" }),
      [day],
      5,
      1,
    );
    expect(fits).toEqual([false]);
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

  test("the card and the plan count the bookings, not the places they hold", async () => {
    // Two bookings hold five places between them: the warning names the two.
    const listing = await listingWithTwoUndatedBookings();
    const [day] = await bookableStartDates(listing.id);
    const step = await confirmedPickStep(listing, day!);
    expect(step).toMatchObject({
      kind: "assign",
      plan: { count: 2, date: day },
    });
    if (step.kind !== "assign") return;
    expect(step.page.card.count).toBe(2);
    expect(step.page.card.noneFits).toBe(false);
  });

  test("a pick outside the offered dates is refused with the pick error", async () => {
    const listing = await hallWithOneUndatedBooking();
    const step = await planListingTypeSwitch(
      listing,
      switchForm(listing, { assign_undated_to: "2020-01-01" }),
    );
    expect(step).toMatchObject({ kind: "page", status: 400 });
  });

  test("a listing with no bookable dates offers none and asks for none", async () => {
    const listing = await createTestListing({
      maxAttendees: 2,
      name: "Hall",
    });
    await bookAttendee(listing, { quantity: 1 });
    // The submission checks no bookable day, so the would-be calendar is
    // empty and there is no date to pick.
    const step = await planListingTypeSwitch(
      listing,
      switchForm(listing, { bookable_days: [] }),
    );
    expect(step).toMatchObject({ kind: "page", status: 200 });
    if (step.kind !== "page") return;
    expect(step.page.card.noDates).toBe(true);
    expect(step.page.card.noneFits).toBe(false);
    expect(step.page.card.dates).toEqual([]);
  });

  test("the card says no date fits only when every offered date is full", async () => {
    const listing = await hallWithOneUndatedBooking();
    // One offered day: tomorrow, for a one-day stay.
    const oneDay = { duration_days: "1", maximum_days_after: "1" };
    const open = await planListingTypeSwitch(
      listing,
      switchForm(listing, oneDay),
    );
    expect(open).toMatchObject({ kind: "page" });
    if (open.kind !== "page") return;
    expect(open.page.card.noneFits).toBe(false);
    const [day] = open.page.card.dates;

    await setCapacity(listing.id, 4);
    await bookAttendee(listing, {
      date: day,
      email: "z@example.com",
      name: "Z",
      quantity: 2,
    });
    await setCapacity(listing.id, 2);

    const full = await planListingTypeSwitch(
      listing,
      switchForm(listing, oneDay),
    );
    expect(full).toMatchObject({
      kind: "page",
      page: { card: { dates: [day], noneFits: true } },
    });
  });

  test("a full pick is refused with the places the bookings hold", async () => {
    const listing = await listingWithTwoUndatedBookings({ maxAttendees: 5 });
    const [day] = await bookableStartDates(listing.id);
    await setCapacity(listing.id, 6);
    await bookAttendee(listing, {
      date: day,
      email: "z@example.com",
      name: "Z",
    });
    await setCapacity(listing.id, 5);

    const step = await confirmedPickStep(listing, day!);

    expect(step).toMatchObject({
      error: t("listings_table.switch_daily_undated_refused", {
        count: 5,
        date: day,
        name: listing.name,
      }),
      kind: "page",
      page: { card: { noneFits: false } },
      status: 400,
    });
  });

  test("serves the Edit tab with the assign card and the submitted groups", async () => {
    const listing = await hallWithOneUndatedBooking();
    const group = await createTestGroup({ name: "Chosen group" });

    const { response } = await adminMultipartPost(
      `/admin/listing/${listing.id}/edit`,
      {
        ...buildUpdateListingForm(
          { bookableDays: allDays, listingType: "daily" },
          listing,
        ),
        group_ids: String(group.id),
      },
    );

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('name="assign_undated_to"');
    expect(html).toContain(
      `checked name="group_ids" type="checkbox" value="${group.id}"`,
    );
  });

  test("a confirmed pick carries the move into the save", async () => {
    const listing = await hallWithOneUndatedBooking();
    const [day] = await bookableStartDates(listing.id);
    const step = await confirmedPickStep(listing, day!);
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
