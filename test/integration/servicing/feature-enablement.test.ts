import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { settings } from "#shared/db/settings.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  adminPost,
  createServicingHold,
  getServicingEvent,
  servicingRowsForListing,
} from "#test-utils/servicing.ts";
import { withFeatureWriteFailure } from "#test-utils/settings.ts";

describeWithEnv("servicing feature enablement", { db: true }, () => {
  test("creating a servicing event enables the feature", async () => {
    const listing = await createTestListing({ maxAttendees: 10, name: "Room" });
    const response = await adminPost("/admin/servicing/new", {
      [`quantity_${listing.id}`]: "1",
      name: "Boiler service",
    });
    response.body?.cancel();
    expect(settings.features.servicing).toBe(true);
  });

  test("a feature write failure does not create a servicing event", async () => {
    const listing = await createTestListing({ maxAttendees: 10, name: "Room" });
    await withFeatureWriteFailure(async () => {
      const response = await adminPost("/admin/servicing/new", {
        [`quantity_${listing.id}`]: "1",
        name: "Boiler service",
      });
      response.body?.cancel();
    });
    expect(await servicingRowsForListing(listing.id)).toEqual([]);
  });

  test("a feature write failure does not update a servicing event", async () => {
    const { id, listing } = await createServicingHold({ name: "Before" });
    await withFeatureWriteFailure(async () => {
      const response = await adminPost(`/admin/servicing/${id}`, {
        [`quantity_${listing.id}`]: "2",
        name: "After",
      });
      response.body?.cancel();
    });
    const unchanged = await getServicingEvent(id);
    expect(unchanged?.name).toBe("Before");
    expect(unchanged?.bookings[0]?.quantity).toBe(1);
  });

  test("a feature write failure does not duplicate a servicing event", async () => {
    const { id, listing } = await createServicingHold();
    await withFeatureWriteFailure(async () => {
      const response = await adminPost(`/admin/servicing/${id}/duplicate`, {});
      response.body?.cancel();
    });
    expect(await servicingRowsForListing(listing.id)).toHaveLength(1);
  });
});
