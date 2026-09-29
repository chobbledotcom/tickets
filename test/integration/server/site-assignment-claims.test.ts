import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { takePooledSiteForBuyer } from "#db/built-sites/claims.ts";
import { builtSites, insertBuiltSite } from "#db/built-sites.ts";
import { settings } from "#db/settings.ts";
import { builderApi } from "#shared/builder.ts";
import { addMonthsIso } from "#shared/dates.ts";
import { nowIso } from "#shared/now.ts";
/* jscpd:ignore-start -- imports */
import { assignAndNotifyBuiltSites } from "#shared/site-assignment.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  forbidBuildDuringAssignment,
  insertSitesAAndB,
  setUpAssignmentSuite,
  silencedErrors,
  siteEntry,
} from "./site-assignment-shared.ts";

/* jscpd:ignore-end */

describeWithEnv(
  "site-assignment claims",
  {
    db: true,
    env: { CAN_BUILD_SITES: "true" },
  },
  () => {
    const suite = setUpAssignmentSuite();

    describe("assignAndNotifyBuiltSites claims and resends", () => {
      /** The pool served exactly one site to the buyer, and Site B still waits. */
      const expectOneSiteServed = async () => {
        const sites = await builtSites.getAll();
        expect(sites.filter((s) => s.assignedAttendeeId !== null)).toHaveLength(
          1,
        );
        expect(sites.find((s) => s.name === "Site B")!.assignable).toBe(true);
      };

      test("a re-sent notification re-sends the served buyer's setup email without a second claim", async () => {
        await insertSitesAAndB();

        const resend = () =>
          assignAndNotifyBuiltSites([
            siteEntry({ attendeeId: 10, listingId: 1, listingName: "Plan" }),
          ]);
        await resend();
        await resend();

        await expectOneSiteServed();
        // The claim stood, and each run emailed the buyer the SAME site's
        // setup link — a lost first email must not need a second site.
        expect(suite.fetchStub.calls.length).toBe(2);
        for (const call of suite.fetchStub.calls) {
          const body = JSON.parse(call.args[1].body);
          expect(body.to).toEqual(["jane@example.com"]);
          expect(body.html).toContain("https://a.test.net/setup/");
        }
      });

      test("a resend re-sends the setup email after the first send failed at the provider", async () => {
        await insertSitesAAndB();
        using _error = silencedErrors();

        // The provider refuses the send after the claim and its token
        // reservation landed: the buyer keeps the booking and the site, but
        // no setup email went out.
        suite.reply(new Response(null, { status: 500 }));
        await assignAndNotifyBuiltSites([
          siteEntry({ attendeeId: 10, listingId: 1, listingName: "Plan" }),
        ]);
        const claimed = (await builtSites.getAll()).find(
          (s) => s.name === "Site A",
        )!;
        expect(claimed.assignedAttendeeId).toBe(10);
        expect(suite.fetchStub.calls.length).toBe(1);

        // The admin resend re-sends the SAME site's setup link and takes no
        // second site.
        suite.reply(() => new Response());
        await assignAndNotifyBuiltSites([
          siteEntry({ attendeeId: 10, listingId: 1, listingName: "Plan" }),
        ]);
        await expectOneSiteServed();
        expect(suite.fetchStub.calls.length).toBe(1);
        const body = JSON.parse(suite.fetchStub.calls[0]!.args[1].body);
        expect(body.html).toContain("https://a.test.net/setup/");
      });

      test("a repair resend grants the term the plan states today", async () => {
        // Empty pool first: the booking stood with no site. Days later the
        // owner stocks one and resends — after retuning the plan's months
        // for future buyers. The repair reads the plan's months live, so it
        // grants what the plan states today; a buyer whose bought term was
        // edited is corrected by hand from the payment record.
        await settings.update.businessEmail("biz@example.com");
        using _build = forbidBuildDuringAssignment();
        const errorSpy = silencedErrors();

        try {
          await assignAndNotifyBuiltSites([
            siteEntry({
              attendeeId: 10,
              initialSiteMonths: 3,
              quantity: 3,
            }),
          ]);
        } finally {
          errorSpy.restore();
        }

        await insertBuiltSite("Site A", "a.test.net", "", "", true, "2001");
        // The suite's own edge-secret stub answers the recovery push.
        await assignAndNotifyBuiltSites([
          siteEntry({
            attendeeId: 10,
            initialSiteMonths: 1,
            quantity: 3,
          }),
        ]);

        // The plan states 1 month today, and the buyer holds 3 units.
        await suite.expectFlagPushOutcome(
          "Site A",
          addMonthsIso(nowIso(), 3).slice(0, 10),
        );
      });

      test("the forbidBuild guard throws if anything builds during assignment", async () => {
        using _build = forbidBuildDuringAssignment();
        // The guard stands in for the pool-only contract, so prove it fires.
        expect(() => builderApi.buildSite({} as never, {} as never)).toThrow(
          "never build",
        );
      });

      test("two racing notification runs for one buyer take a single site", async () => {
        await insertSitesAAndB();

        // Both runs read the pool before either claims. The check-then-claim
        // pair runs in one write transaction, so the runs serialize: the
        // first claims, and the second reads the buyer already served.
        const run = () =>
          assignAndNotifyBuiltSites([
            siteEntry({ attendeeId: 10, listingId: 1, listingName: "Plan" }),
          ]);
        await Promise.all([run(), run()]);

        await expectOneSiteServed();
        expect(suite.fetchStub.calls.length).toBe(2);
      });

      test("a second claim for the same site finds it already taken", async () => {
        await insertBuiltSite("Site A", "a.test.net", "", "", true);
        const site = (await builtSites.getAll())[0]!;

        // Sequential claims, not a race: after the first takes the site, the
        // second's conditional UPDATE matches no row, so the take reports
        // an empty pool.
        expect((await takePooledSiteForBuyer([site], 42, [7], 7)).kind).toBe(
          "claimed",
        );
        expect((await takePooledSiteForBuyer([site], 43, [7], 7)).kind).toBe(
          "empty",
        );

        const sites = await builtSites.getAll();
        expect(sites[0]!.assignedAttendeeId).toBe(42);
        expect(sites[0]!.assignable).toBe(false);
      });

      test("a resend whose first listing is not the claimed one still serves the buyer", async () => {
        await insertSitesAAndB();
        // The claim records the first listing; the resend lists the other
        // one first, so the completion lookup must span both listings.
        const entries = [
          siteEntry({ attendeeId: 10, listingId: 1, listingName: "Plan One" }),
          siteEntry({ attendeeId: 10, listingId: 2, listingName: "Plan Two" }),
        ];
        await assignAndNotifyBuiltSites(entries);
        await assignAndNotifyBuiltSites([...entries].reverse());
        await expectOneSiteServed();
        expect(suite.fetchStub.calls.length).toBe(2);
      });
    });
  },
);
