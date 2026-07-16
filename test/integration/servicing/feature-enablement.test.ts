import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { expectRedirectWithFlash } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  adminPost,
  createServicingHold,
  getServicingEvent,
  servicingRowsForListing,
} from "#test-utils/servicing.ts";
import {
  enableFeature,
  storedFeatureEnabled,
  withFeatureWriteFailure,
} from "#test-utils/settings.ts";

describeWithEnv("servicing feature enablement", { db: true }, () => {
  test("creating a servicing event enables the feature", async () => {
    const listing = await createTestListing({ maxAttendees: 10, name: "Room" });
    const response = await adminPost("/admin/servicing/new", {
      [`quantity_${listing.id}`]: "1",
      name: "Boiler service",
    });
    response.body?.cancel();
    expect(await storedFeatureEnabled("servicing")).toBe(true);
  });

  test("a feature write failure does not create a servicing event", async () => {
    const listing = await createTestListing({ maxAttendees: 10, name: "Room" });
    await enableFeature("servicing");
    await withFeatureWriteFailure(async () => {
      const response = await adminPost("/admin/servicing/new", {
        [`quantity_${listing.id}`]: "1",
        name: "Boiler service",
      });
      expectRedirectWithFlash(
        "/admin/servicing/new",
        expect.stringContaining("feature enable failed"),
        false,
      )(response);
      response.body?.cancel();
    });
    expect(await servicingRowsForListing(listing.id)).toEqual([]);
  });

  test("a feature write failure does not update a servicing event", async () => {
    const { id, listing } = await createServicingHold({ name: "Before" });
    await enableFeature("servicing");
    await withFeatureWriteFailure(async () => {
      const response = await adminPost(`/admin/servicing/${id}`, {
        [`quantity_${listing.id}`]: "2",
        name: "After",
      });
      expectRedirectWithFlash(
        `/admin/servicing/${id}`,
        expect.stringContaining("feature enable failed"),
        false,
      )(response);
      response.body?.cancel();
    });
    const unchanged = await getServicingEvent(id);
    expect(unchanged?.name).toBe("Before");
    expect(unchanged?.bookings[0]?.quantity).toBe(1);
  });

  test("a feature write failure does not duplicate a servicing event", async () => {
    const { id, listing } = await createServicingHold();
    await enableFeature("servicing");
    await withFeatureWriteFailure(async () => {
      const response = await adminPost(`/admin/servicing/${id}/duplicate`, {});
      expectRedirectWithFlash(
        `/admin/servicing/${id}`,
        expect.stringContaining("feature enable failed"),
        false,
      )(response);
      response.body?.cancel();
    });
    expect(await servicingRowsForListing(listing.id)).toHaveLength(1);
  });
});
