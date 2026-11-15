import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getAllListings, getListingWithCount } from "#db/listings/records.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { buildCreateListingForm } from "#test-utils/db-helpers/listing-forms.ts";
import {
  createTestListing,
  updateTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { withEnv } from "#test-utils/env.ts";
import { testListingInput } from "#test-utils/factories.ts";
import { adminMultipartPost } from "#test-utils/session.ts";

describeWithEnv("server listings > assign_built_site", { db: true }, () => {
  describe("assign_built_site", () => {
    test("saves assign_built_site when CAN_BUILD_SITES is true", async () => {
      using _env = withEnv({ CAN_BUILD_SITES: "true" });
      const listing = await createTestListing({ assignBuiltSite: true });
      const saved = await getListingWithCount(listing.id);
      expect(saved?.assign_built_site).toBe(true);
    });

    test("refuses assign_built_site when CAN_BUILD_SITES is not set", async () => {
      using _env = withEnv({ CAN_BUILD_SITES: undefined });
      const { response } = await adminMultipartPost("/admin/listing", {
        ...buildCreateListingForm(testListingInput({ name: "No builder" })),
        assign_built_site: "1",
      });
      expect([response.status, await getAllListings()]).toEqual([400, []]);
    });

    test("defaults to false even when CAN_BUILD_SITES is true", async () => {
      using _env = withEnv({ CAN_BUILD_SITES: "true" });
      const listing = await createTestListing();
      const saved = await getListingWithCount(listing.id);
      expect(saved?.assign_built_site).toBe(false);
    });

    test("updates listing to enable assign_built_site", async () => {
      using _env = withEnv({ CAN_BUILD_SITES: "true" });
      const listing = await createTestListing();
      await updateTestListing(listing.id, { assignBuiltSite: true });
      const updated = await getListingWithCount(listing.id);
      expect(updated?.assign_built_site).toBe(true);
    });
  });
});
