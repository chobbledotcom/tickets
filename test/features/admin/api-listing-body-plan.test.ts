import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getListingWithCount } from "#db/listings/records.ts";
import { t } from "#i18n";
import { bodyToUpdateInput } from "#routes/admin/api-listing-body.ts";
import { requireSuccess } from "#shared/result.ts";
import { recurringPlanError } from "#shared/subscriptions/listing-rules.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { withMonthlyPlan } from "#test-utils/db-helpers/subscriptions.ts";
import { withEnv } from "#test-utils/env.ts";

/** The update input that `body` merges over the stored listing. */
const mergedUpdate = async (listingId: number, body: Record<string, unknown>) =>
  requireSuccess(
    await bodyToUpdateInput(body, (await getListingWithCount(listingId))!),
  );

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

      const input = await mergedUpdate(listing.id, { name: "Plain Update" });
      expect(input.assignBuiltSite).toBe(false);
    });

    test("an update that omits the plan keeps the stored plan for the save rules", async () => {
      const listing = await withMonthlyPlan(await createTestListing());
      const input = await mergedUpdate(listing.id, { unit_price: 0 });
      expect([
        input.recurringPrice,
        input.recurringInterval,
        recurringPlanError(input),
      ]).toEqual([500, "month", t("error.recurring_needs_ticket_price")]);
    });
  },
);
