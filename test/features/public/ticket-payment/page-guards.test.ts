/**
 * The gates a booking page runs before it renders: which listings may start a
 * booking of their own, which are folded under a parent, and which dates a
 * daily parent can still offer once its add-ons are considered.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { listingChildren } from "#db/listing-parents.ts";
import { listingsTable } from "#db/listings/records.ts";
import { map } from "#fp";
import {
  dropChildListings,
  keepParentDailyDatesChildrenCanServe,
  lacksStandalonePublicPage,
  withActiveListings,
} from "#routes/public/ticket-payment.ts";
import { addDays } from "#shared/dates.ts";
import { requireValue } from "#shared/required-value.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createHiddenPackageGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import type { ListingWithCount } from "#types";

/** A parent listing with one child, linked. */
const parentWithChild = async (
  label: string,
  childOverrides: Parameters<typeof createTestListing>[0] = {},
): Promise<{ parent: ListingWithCount; child: ListingWithCount }> => {
  const parent = await createTestListing({
    maxAttendees: 10,
    name: `${label} parent`,
  });
  const child = await createTestListing({
    maxAttendees: 10,
    name: `${label} child`,
    ...childOverrides,
  });
  await listingChildren.setIds(parent.id, [child.id]);
  return { child, parent };
};

/** The next date on the given weekday (1 = Monday) at least a week out, so it
 * sits inside a 30-day booking window whichever timezone "today" is read in. */
const comingWeekday = (weekday: number): string => {
  const weekStart = addDays(new Date().toISOString().slice(0, 10), 7);
  const week = map((step: number) => addDays(weekStart, step))([
    0, 1, 2, 3, 4, 5, 6,
  ]);
  return requireValue(
    week.find((date) => new Date(`${date}T00:00:00Z`).getUTCDay() === weekday),
    `No day ${weekday} in the week from ${weekStart}`,
  );
};

describeWithEnv("booking page guards", { db: true }, () => {
  test("drops a listing that any parent adopts", async () => {
    const { child, parent } = await parentWithChild("Dropped");

    const kept = await dropChildListings([parent, child]);
    expect(kept.map((listing) => listing.id)).toEqual([parent.id]);
  });

  test("keeps listings no parent adopts", async () => {
    const alone = await createTestListing({ name: "Unadopted" });

    const kept = await dropChildListings([alone]);
    expect(kept.map((listing) => listing.id)).toEqual([alone.id]);
  });

  test("says an add-on child has no page of its own", async () => {
    const { child } = await parentWithChild("Addon");

    expect(await lacksStandalonePublicPage(child.id)).toBe(true);
  });

  test("says a hidden package's member has no page of its own", async () => {
    const group = await createHiddenPackageGroup("Concealed bundle");
    const member = await createTestListing({
      groupId: group.id,
      maxAttendees: 10,
      name: "Concealed member",
    });

    expect(await lacksStandalonePublicPage(member.id)).toBe(true);
  });

  test("says an ordinary listing does have its own page", async () => {
    const listing = await createTestListing({ name: "Public listing" });

    expect(await lacksStandalonePublicPage(listing.id)).toBe(false);
  });

  test("renders a page for a single active slug", async () => {
    const listing = await createTestListing({
      maxAttendees: 10,
      name: "Single slug",
    });

    const response = await withActiveListings([listing.slug], (listings) => {
      expect(listings).toHaveLength(1);
      return Promise.resolve(new Response("rendered"));
    });
    expect(await response.text()).toBe("rendered");
  });

  test("404s when every slug names a listing that is off sale", async () => {
    const listing = await createTestListing({ name: "Withdrawn slug" });
    await listingsTable.update(listing.id, { active: false });

    const response = await withActiveListings([listing.slug], () =>
      Promise.resolve(new Response("rendered")),
    );
    expect(response.status).toBe(404);
  });

  test("narrows a parent's dates to those its one child can serve", async () => {
    const { parent } = await parentWithChild("Dated", {
      bookableDays: ["Monday"],
      listingType: "daily",
      maxAttendees: 10,
      maximumDaysAfter: 30,
      minimumDaysBefore: 0,
    });
    const monday = comingWeekday(1);
    const tuesday = comingWeekday(2);

    // The child only opens on Mondays, so the parent's Tuesday goes.
    expect(
      await keepParentDailyDatesChildrenCanServe(parent, [monday, tuesday], []),
    ).toEqual([monday]);
  });

  test("leaves a childless parent's dates alone", async () => {
    const parent = await createTestListing({
      listingType: "daily",
      maxAttendees: 10,
      maximumDaysAfter: 30,
      minimumDaysBefore: 0,
      name: "Childless parent",
    });

    expect(
      await keepParentDailyDatesChildrenCanServe(parent, ["2099-01-01"], []),
    ).toEqual(["2099-01-01"]);
  });
});
