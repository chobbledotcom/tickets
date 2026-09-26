import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { claimBuiltSiteForAttendee, insertBuiltSite } from "#db/built-sites.ts";
import { setupListingAndAttendee } from "#test-utils/attendees/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { withEnv } from "#test-utils/env.ts";
import { adminGet } from "#test-utils/session.ts";

const setupPlanAttendee = async () => {
  using _env = withEnv({ CAN_BUILD_SITES: "true" });
  // The hidden monthly tier the plan's booking validation requires.
  await createTestListing({
    hidden: true,
    monthsPerUnit: 1,
    purchaseOnly: true,
    unitPrice: 300,
  });
  const { attendee, listing } = await setupListingAndAttendee({
    listing: {
      assignBuiltSite: true,
      initialSiteMonths: 3,
      maxAttendees: 100,
      name: "Site Plan",
    },
  });
  return { attendee, listing };
};

describeWithEnv(
  "server (admin attendees) > plan bookings without a site",
  { db: true },
  () => {
    describe("GET /admin/attendees/:attendeeId overview", () => {
      test("a plan booking shows no site assigned yet until a site is claimed", async () => {
        const { attendee, listing } = await setupPlanAttendee();

        const owed = await adminGet(`/admin/attendees/${attendee.id}`);
        const before = await owed.text();
        expect(before).toContain("Site Plan");
        expect(before).toContain("No site assigned yet");

        const pooled = await insertBuiltSite(
          "Pooled",
          "pooled.test",
          "",
          "",
          true,
        );
        await claimBuiltSiteForAttendee(pooled.id, attendee.id, listing.id);

        const served = await adminGet(`/admin/attendees/${attendee.id}`);
        const after = await served.text();
        expect(after).toContain("Site Plan");
        expect(after).not.toContain("No site assigned yet");
      });
    });
  },
);
