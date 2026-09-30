import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { attendeesApi } from "#db/attendees/api.ts";
import { takePooledSiteForBuyer } from "#db/built-sites/claims.ts";
import { getAssignableBuiltSites, insertBuiltSite } from "#db/built-sites.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  bookedAttendee,
  createPaidTestAttendee,
  resaveAttendee,
} from "#test-utils/db-helpers/attendee-payments.ts";
import {
  bookTestAttendee,
  createTestAttendee,
} from "#test-utils/db-helpers/attendees.ts";
import {
  createTierListing,
  planListing,
} from "#test-utils/db-helpers/site-plans.ts";
import { withEnv } from "#test-utils/env.ts";
import { postListingSale, refundBookedOrder } from "#test-utils/ledger.ts";
import { adminGet } from "#test-utils/session.ts";

describeWithEnv(
  "server (admin attendees) > plan bookings without a site",
  { db: true },
  () => {
    describe("GET /admin/attendees/:attendeeId overview", () => {
      test("a plan booking shows no site assigned yet until a site is claimed", async () => {
        using _env = withEnv({ CAN_BUILD_SITES: "true" });
        await createTierListing();
        const listing = await planListing("Site Plan");
        const attendee = await createTestAttendee(
          listing.id,
          listing.slug,
          "John Doe",
          "john@example.com",
        );

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
        await createTierListing();
        const plan = await planListing("Site Plan");
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

      test("a fully paid plan sale with one payment reference still shows the cue", async () => {
        using _env = withEnv({ CAN_BUILD_SITES: "true" });
        await createTierListing();
        const plan = await planListing("Site Plan");
        // One payment reference completes the sale, so the buyer is owed a
        // site even though the pool is empty.
        const attendee = await createPaidTestAttendee(
          plan.id,
          "Paid Buyer",
          "paid@test.com",
          "pi_site_plan_paid",
          300,
        );

        const page = await adminGet(`/admin/attendees/${attendee.id}`);
        const html = await page.text();
        expect(html).toContain("Site Plan");
        expect(html).toContain("No site assigned yet");
      });

      test("a claim on a refunded plan row still serves the active plan", async () => {
        using _env = withEnv({ CAN_BUILD_SITES: "true" });
        await createTierListing();
        const refundedPlan = await planListing("Refunded Plan");
        const activePlan = await planListing("Active Plan");
        // A payment reference completes the sale, so the buyer is owed a site
        // and the cue shows until a claim serves them.
        const attendee = bookedAttendee(
          await attendeesApi.createAttendeeAtomic({
            bookings: [
              { listingId: refundedPlan.id },
              { listingId: activePlan.id },
            ],
            email: "alice@test.com",
            name: "Alice",
            paymentId: "pi_two_plans",
          }),
        );
        await resaveAttendee(attendee);
        // The refunded plan was paid and served before its refund.
        await postListingSale({
          attendeeId: attendee.id,
          gross: 300,
          listingId: refundedPlan.id,
        });
        const owed = await adminGet(`/admin/attendees/${attendee.id}`);
        expect(await owed.text()).toContain("No site assigned yet");

        await insertBuiltSite("Stale Claim", "stale.test", "", "", true);
        const pool = await getAssignableBuiltSites();
        await takePooledSiteForBuyer(
          pool,
          attendee.id,
          [refundedPlan.id],
          refundedPlan.id,
        );
        await refundBookedOrder(attendee.id, refundedPlan.id);

        const page = await adminGet(`/admin/attendees/${attendee.id}`);
        const html = await page.text();
        // The claim on the refunded plan holds the buyer's one site, so no
        // row asks for a second one.
        expect(html).not.toContain("No site assigned yet");
      });

      test("one site serves a combined purchase of two plan listings", async () => {
        using _env = withEnv({ CAN_BUILD_SITES: "true" });
        await createTierListing();
        const first = await planListing("First Plan");
        const second = await planListing("Second Plan");
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
