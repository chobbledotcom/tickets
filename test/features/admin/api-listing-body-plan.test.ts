import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getListingWithCount } from "#db/listings/records.ts";
import { bodyToUpdateInput } from "#routes/admin/api-listing-body.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { withEnv } from "#test-utils/env.ts";

describeWithEnv(
  "built-site plan fields in a merged update input",
  { db: true },
  () => {
    test("an absent assign_built_site in the body keeps the stored flag", async () => {
      using _env = withEnv({ CAN_BUILD_SITES: "true" });
      const plan = await createTestListing({
        assignBuiltSite: true,
        initialSiteMonths: 4,
      });

      const storedPlan = await getListingWithCount(plan.id);
      if (!storedPlan) throw new Error(`created plan ${plan.id} is missing`);
      const result = await bodyToUpdateInput({ max_attendees: 12 }, storedPlan);

      expect(result.ok).toBe(true);
      if (result.ok) {
        // The API cannot set these fields, so the merged input must fold in
        // the stored ones — validators downstream read the final facts.
        expect(result.value.assignBuiltSite).toBe(true);
        expect(result.value.initialSiteMonths).toBe(4);
        expect(result.value.monthsPerUnit).toBe(0);
        expect(result.value.purchaseOnly).toBe(false);
      }
    });

    test("a listing that assigns no site folds its stored defaults", async () => {
      const listing = await createTestListing({ monthsPerUnit: 0 });

      const result = await bodyToUpdateInput(
        { name: "Plain Update" },
        (await getListingWithCount(listing.id))!,
      );

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.assignBuiltSite).toBe(false);
    });
  },
);
