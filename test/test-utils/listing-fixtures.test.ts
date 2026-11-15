import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { getListingWithActivityLogOrNull } from "#test-utils/activity-log.ts";
import { createTestDbWithSetup, resetDb } from "#test-utils/db.ts";
import {
  createTestGroup,
  listingGroupIdsOf,
} from "#test-utils/db-helpers/groups.ts";
import {
  createTestListing,
  createTestListingDirect,
} from "#test-utils/db-helpers/listings.ts";

describe("createTestListingDirect", () => {
  afterEach(() => {
    resetDb();
  });

  beforeEach(async () => {
    await createTestDbWithSetup();
  });

  test("writes the stored defaults through the record", async () => {
    const listing = await createTestListingDirect({ name: "Direct Hall" });
    expect(listing).toMatchObject({
      active: true,
      max_attendees: 100,
      name: "Direct Hall",
      tickets_count: 0,
    });
    expect(listing.slug).not.toBe("");
  });

  test("leaves the record's create line in the activity log", async () => {
    const listing = await createTestListingDirect({ name: "Logged Direct" });
    const logged = await getListingWithActivityLogOrNull(listing.id);
    expect(logged!.entries[0]!.message).toBe("Listing 'Logged Direct' created");
  });

  test("sets the group from groupIds and from one groupId", async () => {
    const group = await createTestGroup({ name: "Direct Group" });
    const first = await createTestListingDirect({ groupIds: [group.id] });
    const second = await createTestListingDirect({ groupId: group.id });
    expect([
      await listingGroupIdsOf(first.id),
      await listingGroupIdsOf(second.id),
    ]).toEqual([[group.id], [group.id]]);
  });

  test("writes the per-day prices", async () => {
    const listing = await createTestListingDirect({
      customisableDays: true,
      dayPrices: { 1: 1200 },
    });
    expect(listing.day_prices).toEqual({ 1: 1200 });
  });

  test("stores a zero capacity the form would refuse", async () => {
    const listing = await createTestListingDirect({ maxAttendees: 0 });
    expect(listing.max_attendees).toBe(0);
    const { getListingWithCount } = await import("#db/listings/records.ts");
    expect((await getListingWithCount(listing.id))!.max_attendees).toBe(0);
  });

  test("hands back a refusal as an error", async () => {
    await createTestListingDirect({ name: "Taken By Direct" });
    await expect(
      createTestListingDirect({ name: "Taken By Direct" }),
    ).rejects.toThrow(
      "Failed to create listing: Name is already in use by another listing or group",
    );
  });

  test("hands back a missing row as an error", async () => {
    const { listingRecord } = await import("#shared/records/listings.ts");
    using _missing = stub(listingRecord, "create", () =>
      Promise.resolve({ kind: "not-found" as const }),
    );
    await expect(createTestListingDirect()).rejects.toThrow(
      "Failed to create listing: the new row is missing",
    );
  });
});

describe("createTestListing", () => {
  afterEach(() => {
    resetDb();
  });

  beforeEach(async () => {
    await createTestDbWithSetup();
  });

  test("posts the create form, which refuses a quantity below one", async () => {
    // `max_quantity` is a form-schema rule; the listing record accepts the
    // column. The refusal proves this helper uses the routed form.
    await expect(createTestListing({ maxQuantity: 0 })).rejects.toThrow(
      "Failed to create listing: 400",
    );
    const { getAllListings } = await import("#db/listings/records.ts");
    expect(await getAllListings()).toEqual([]);
  });
});
