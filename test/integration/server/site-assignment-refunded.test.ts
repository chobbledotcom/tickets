import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { builtSites, insertBuiltSite } from "#db/built-sites.ts";
import { addMonthsIso } from "#shared/dates.ts";
import { nowIso } from "#shared/now.ts";
import { assignAndNotifyBuiltSites } from "#shared/site-assignment.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { setUpAssignmentSuite, siteEntry } from "./site-assignment-shared.ts";

describeWithEnv(
  "site-assignment for refunded plan rows",
  {
    db: true,
    env: { CAN_BUILD_SITES: "true" },
  },
  () => {
    setUpAssignmentSuite();

    describe("assignAndNotifyBuiltSites", () => {
      test("a refunded plan row books no site and adds no months", async () => {
        // A hosting id, so the renewal push can land and persist its cutoff.
        await insertBuiltSite("Site A", "a.test.net", "", "", true, "2001");
        await insertBuiltSite("Site B", "b.test.net", "", "", true, "2002");

        // The buyer's refunded plan row comes first; only the active row may
        // claim, and its months must stand alone.
        await assignAndNotifyBuiltSites([
          siteEntry({
            attendeeId: 10,
            listingId: 1,
            listingName: "Refunded Plan",
            refunded: true,
          }),
          siteEntry({
            attendeeId: 10,
            listingId: 2,
            listingName: "Active Plan",
          }),
        ]);

        const sites = await builtSites.getAll();
        const assigned = sites.find((s) => s.assignedAttendeeId !== null)!;
        expect(assigned.assignedListingId).toBe(2);
        const expectedCutoff = addMonthsIso(nowIso(), 3).slice(0, 10);
        expect(assigned.readOnlyFrom.slice(0, 10)).toBe(expectedCutoff);
      });
    });
  },
);
