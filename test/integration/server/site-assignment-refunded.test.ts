import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { builtSites, insertBuiltSite } from "#db/built-sites.ts";
import { addMonthsIso } from "#shared/dates.ts";
import { nowIso } from "#shared/now.ts";
import { assignAndNotifyBuiltSites } from "#shared/site-assignment.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  expectOneSiteClaimed,
  setUpAssignmentSuite,
  siteEntry,
} from "./site-assignment-shared.ts";

/** Stock two sites (a hosting id each, so renewal pushes can land). */
const stockTwoSites = async (): Promise<void> => {
  await insertBuiltSite("Site A", "a.test.net", "", "", true, "2001");
  await insertBuiltSite("Site B", "b.test.net", "", "", true, "2002");
};

/** One buyer's two plan rows, the first optionally refunded. */
const twoPlanEntries = (firstRefunded: boolean) => [
  siteEntry({
    attendeeId: 10,
    listingId: 1,
    listingName: "Plan One",
    refunded: firstRefunded,
  }),
  siteEntry({ attendeeId: 10, listingId: 2, listingName: "Plan Two" }),
];

describeWithEnv(
  "site-assignment for refunded plan rows",
  {
    db: true,
    env: { CAN_BUILD_SITES: "true" },
  },
  () => {
    setUpAssignmentSuite();

    describe("assignAndNotifyBuiltSites", () => {
      test("a claim recorded on a listing later refunded serves the resend", async () => {
        await stockTwoSites();

        // First run: both plans active, so the claim records the first.
        await assignAndNotifyBuiltSites(twoPlanEntries(false));

        // Resend with the claimed listing refunded: the served check must
        // still see the claim, so the buyer keeps exactly one site.
        await assignAndNotifyBuiltSites(twoPlanEntries(true));

        await expectOneSiteClaimed();
      });

      test("a refunded plan row books no site and adds no months", async () => {
        await stockTwoSites();

        // The buyer's refunded plan row comes first; only the active row may
        // claim, and its months must stand alone.
        await assignAndNotifyBuiltSites(twoPlanEntries(true));

        const sites = await builtSites.getAll();
        const assigned = sites.find((s) => s.assignedAttendeeId !== null)!;
        expect(assigned.assignedListingId).toBe(2);
        const expectedCutoff = addMonthsIso(nowIso(), 3).slice(0, 10);
        expect(assigned.readOnlyFrom.slice(0, 10)).toBe(expectedCutoff);
      });
    });
  },
);
