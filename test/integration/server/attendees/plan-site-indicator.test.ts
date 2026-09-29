import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { takePooledSiteForBuyer } from "#db/built-sites/claims.ts";
import { getAssignableBuiltSites, insertBuiltSite } from "#db/built-sites.ts";
import { addMonthsIso } from "#shared/dates.ts";
import { nowIso } from "#shared/now.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createPaidTestAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
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
          addMonthsIso(nowIso(), 3),
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

      test("a refunded plan's stale assignment does not hide an active plan's cue", async () => {
        using _env = withEnv({ CAN_BUILD_SITES: "true" });
        await createTierListing();
        const refundedPlan = await planListing("Refunded Plan");
        const activePlan = await planListing("Active Plan");
        const attendee = await bookTestAttendee([
          { listingId: refundedPlan.id },
          { listingId: activePlan.id },
        ]);
        // The refunded plan was paid and served before its refund.
        await postListingSale({
          attendeeId: attendee.id,
          gross: 300,
          listingId: refundedPlan.id,
        });
        await insertBuiltSite("Stale Claim", "stale.test", "", "", true);
        const pool = await getAssignableBuiltSites();
        await takePooledSiteForBuyer(
          pool,
          attendee.id,
          [refundedPlan.id],
          refundedPlan.id,
          addMonthsIso(nowIso(), 3),
        );
        await refundBookedOrder(attendee.id, refundedPlan.id);

        const page = await adminGet(`/admin/attendees/${attendee.id}`);
        const html = await page.text();
        // Scope to each row: the active plan row carries the cue, the
        // refunded one does not.
        const rows = html.split("<tr>").filter((row) => row.includes("Plan"));
        const activeRow = rows.find((row) => row.includes("Active Plan"))!;
        const refundedRow = rows.find((row) => row.includes("Refunded Plan"))!;
        expect(activeRow).toContain("No site assigned yet");
        expect(refundedRow).not.toContain("No site assigned yet");
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
        await takePooledSiteForBuyer(
          pool,
          attendee.id,
          [first.id],
          first.id,
          addMonthsIso(nowIso(), 3),
        );

        const served = await adminGet(`/admin/attendees/${attendee.id}`);
        const after = await served.text();
        expect(after).toContain("First Plan");
        expect(after).toContain("Second Plan");
        expect(after).not.toContain("No site assigned yet");
      });
    });
  },
);
