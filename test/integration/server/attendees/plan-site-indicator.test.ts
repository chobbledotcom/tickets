import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { takePooledSiteForBuyer } from "#db/built-sites/claims.ts";
import { getAssignableBuiltSites, insertBuiltSite } from "#db/built-sites.ts";
import { setupListingAndAttendee } from "#test-utils/attendees/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createPaidTestAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { bookTestAttendee } from "#test-utils/db-helpers/attendees.ts";
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

        await insertBuiltSite("Pooled", "pooled.test", "", "", true);
        const pool = await getAssignableBuiltSites();
        await takePooledSiteForBuyer(
          pool,
          attendee.id,
          [listing.id],
          listing.id,
        );

        const served = await adminGet(`/admin/attendees/${attendee.id}`);
        const after = await served.text();
        expect(after).toContain("Site Plan");
        expect(after).not.toContain("No site assigned yet");
      });

      test("an incomplete payment shows no repair cue", async () => {
        using _env = withEnv({ CAN_BUILD_SITES: "true" });
        await createTestListing({
          hidden: true,
          monthsPerUnit: 1,
          purchaseOnly: true,
          unitPrice: 300,
        });
        const plan = await createTestListing({
          assignBuiltSite: true,
          initialSiteMonths: 3,
          maxAttendees: 100,
          name: "Site Plan",
          unitPrice: 300,
        });
        // A sale leg with no payment reference: the payment never completed,
        // so the notification never ran and no repair is owed yet.
        const attendee = await createPaidTestAttendee(
          plan.id,
          "Unpaid Buyer",
          "unpaid@test.com",
          "",
          300,
        );

        const page = await adminGet(`/admin/attendees/${attendee.id}`);
        const html = await page.text();
        expect(html).toContain("Site Plan");
        expect(html).not.toContain("No site assigned yet");
      });

      test("one site serves a combined purchase of two plan listings", async () => {
        using _env = withEnv({ CAN_BUILD_SITES: "true" });
        await createTestListing({
          hidden: true,
          monthsPerUnit: 1,
          purchaseOnly: true,
          unitPrice: 300,
        });
        const first = await createTestListing({
          assignBuiltSite: true,
          initialSiteMonths: 3,
          maxAttendees: 100,
          name: "First Plan",
        });
        const second = await createTestListing({
          assignBuiltSite: true,
          initialSiteMonths: 3,
          maxAttendees: 100,
          name: "Second Plan",
        });
        const attendee = await bookTestAttendee([
          { listingId: first.id },
          { listingId: second.id },
        ]);

        await insertBuiltSite("Combined", "combined.test", "", "", true);
        const pool = await getAssignableBuiltSites();
        // The claim records the first listing only, so the cue must judge
        // the buyer as a whole — the second row may not keep its warning.
        await takePooledSiteForBuyer(pool, attendee.id, [first.id], first.id);

        const served = await adminGet(`/admin/attendees/${attendee.id}`);
        const after = await served.text();
        expect(after).toContain("First Plan");
        expect(after).toContain("Second Plan");
        expect(after).not.toContain("No site assigned yet");
      });
    });
  },
);
