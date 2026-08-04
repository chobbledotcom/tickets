/**
 * The gates a booking page runs before it renders: which listings may start a
 * booking of their own, which are folded under a parent, and which dates a
 * daily parent can still offer once its add-ons are considered.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  dropChildListings,
  keepParentDailyDatesChildrenCanServe,
  lacksStandalonePublicPage,
  withActiveListings,
} from "#routes/public/ticket-payment.ts";
import { listingChildren } from "#shared/db/listing-parents.ts";
import { listingsTable } from "#shared/db/listings/records.ts";
import type { ListingWithCount } from "#shared/types.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createHiddenPackageGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

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

  test("narrows a daily parent's dates to those its one child can serve", async () => {
    const { parent } = await parentWithChild("Dated", {
      listingType: "daily",
      maxAttendees: 0,
      maximumDaysAfter: 30,
      minimumDaysBefore: 0,
    });

    // The only child is sold out, so no date it would be booked on survives.
    expect(
      await keepParentDailyDatesChildrenCanServe(
        parent,
        ["2099-01-01", "2099-01-02"],
        [],
      ),
    ).toEqual([]);
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
