import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getAllListings, getListingWithCount } from "#db/listings/records.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createTestListing,
  updateTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { withEnv } from "#test-utils/env.ts";
import { submitListingCreate } from "#test-utils/listing-submits.ts";

describeWithEnv("server listings > assign_built_site", { db: true }, () => {
  describe("assign_built_site", () => {
    test("saves assign_built_site as asked, false by default, when CAN_BUILD_SITES is true", async () => {
      using _env = withEnv({ CAN_BUILD_SITES: "true" });
      const plan = await createTestListing({ assignBuiltSite: true });
      const plain = await createTestListing({ name: "Plain listing" });
      expect([
        (await getListingWithCount(plan.id))?.assignBuiltSite,
        (await getListingWithCount(plain.id))?.assignBuiltSite,
      ]).toEqual([true, false]);
    });

    test("refuses assign_built_site when CAN_BUILD_SITES is not set", async () => {
      using _env = withEnv({ CAN_BUILD_SITES: undefined });
      const { response } = await submitListingCreate({
        assignBuiltSite: "1",
      });
      expect([response.status, await getAllListings()]).toEqual([400, []]);
    });

    test("updates listing to enable assign_built_site", async () => {
      using _env = withEnv({ CAN_BUILD_SITES: "true" });
      const listing = await createTestListing();
      await updateTestListing(listing.id, { assignBuiltSite: true });
      const updated = await getListingWithCount(listing.id);
      expect(updated?.assignBuiltSite).toBe(true);
    });
  });
});
