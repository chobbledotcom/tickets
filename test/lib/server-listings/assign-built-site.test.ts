// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getListingWithCount } from "#shared/db/listings.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createTestListing,
  updateTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { setTestEnv } from "#test-utils/env.ts";

// jscpd:ignore-end

describeWithEnv("server listings > assign_built_site", { db: true }, () => {
  describe("assign_built_site", () => {
    test("saves assign_built_site when CAN_BUILD_SITES is true", async () => {
      const restore = setTestEnv({ CAN_BUILD_SITES: "true" });
      try {
        const listing = await createTestListing({ assignBuiltSite: true });
        const saved = await getListingWithCount(listing.id);
        expect(saved?.assign_built_site).toBe(true);
      } finally {
        restore();
      }
    });

    test("ignores assign_built_site when CAN_BUILD_SITES is not set", async () => {
      const listing = await createTestListing({ assignBuiltSite: true });
      const saved = await getListingWithCount(listing.id);
      expect(saved?.assign_built_site).toBe(false);
    });

    test("defaults to false even when CAN_BUILD_SITES is true", async () => {
      const restore = setTestEnv({ CAN_BUILD_SITES: "true" });
      try {
        const listing = await createTestListing();
        const saved = await getListingWithCount(listing.id);
        expect(saved?.assign_built_site).toBe(false);
      } finally {
        restore();
      }
    });

    test("updates listing to enable assign_built_site", async () => {
      const restore = setTestEnv({ CAN_BUILD_SITES: "true" });
      try {
        const listing = await createTestListing();
        await updateTestListing(listing.id, { assignBuiltSite: true });
        const updated = await getListingWithCount(listing.id);
        expect(updated?.assign_built_site).toBe(true);
      } finally {
        restore();
      }
    });
  });
});
