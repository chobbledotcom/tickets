import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { attendeesApi } from "#db/attendees/api.ts";
import { takePooledSiteForBuyer } from "#db/built-sites/claims.ts";
import { getAssignableBuiltSites, insertBuiltSite } from "#db/built-sites.ts";
import { expectIncludesAll } from "#test-utils/assertions.ts";
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

/** The words of the warning about a plan with no site. */
const PLAN_WARNING =
  "Site Plan: no site is assigned yet. Add or build sites on the Built Sites page, then send the notification again.";

const nothingMore = (): Promise<void> => Promise.resolve();

/** A paid plan sale: its payment reference (empty for none), what happens
 * after the sale, and whether the attendee page warns. A sale with no
 * payment reference never completed, so it owes no site yet. A refunded
 * sale owes none. */
const PAID_PLAN_CASES: [
  string,
  string,
  (attendeeId: number, listingId: number) => Promise<unknown>,
  boolean,
][] = [
  ["an incomplete payment shows no warning", "", nothingMore, false],
  [
    "a fully paid plan sale with one payment reference warns that no site is assigned",
    "pi_site_plan_paid",
    nothingMore,
    true,
  ],
  [
    "a refunded plan sale shows no warning",
    "pi_site_plan_refunded",
    refundBookedOrder,
    false,
  ],
];

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
        expectIncludesAll(before, ["Site Plan", "no site is assigned yet"]);

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
        assertStringIncludes(after, "Site Plan");
        assert(!after.includes("no site is assigned yet"));
      });

      for (const [name, paymentId, afterSale, shown] of PAID_PLAN_CASES) {
        test(name, async () => {
          using _env = withEnv({ CAN_BUILD_SITES: "true" });
          await createTierListing();
          const plan = await planListing("Site Plan");
          const attendee = await createPaidTestAttendee(
            plan.id,
            "Plan Buyer",
            "buyer@test.com",
            paymentId,
            300,
          );
          await afterSale(attendee.id, plan.id);

          const page = await adminGet(`/admin/attendees/${attendee.id}`);
          const html = await page.text();
          assertStringIncludes(html, "Site Plan");
          expect(html.includes(PLAN_WARNING)).toBe(shown);
        });
      }

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
        assertStringIncludes(await owed.text(), "no site is assigned yet");

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
        assert(!html.includes("no site is assigned yet"));
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
        expectIncludesAll(after, ["First Plan", "Second Plan"]);
        assert(!after.includes("no site is assigned yet"));
      });
    });
  },
);
