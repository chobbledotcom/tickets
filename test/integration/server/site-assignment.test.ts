import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { takePooledSiteForBuyer } from "#db/built-sites/claims.ts";
import { builtSites, insertBuiltSite } from "#db/built-sites.ts";
import { settings } from "#db/settings.ts";
import { builderApi } from "#shared/builder.ts";
import { addMonthsIso } from "#shared/dates.ts";
import { hostEmail } from "#shared/email.ts";
import { ErrorCode } from "#shared/logger.ts";
import { nowIso } from "#shared/now.ts";
/* jscpd:ignore-start -- imports */
import { assignAndNotifyBuiltSites } from "#shared/site-assignment.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { withEnv } from "#test-utils/env.ts";
import {
  forbidBuildDuringAssignment,
  setUpAssignmentSuite,
  silencedErrors,
  siteEntry,
} from "./site-assignment-shared.ts";

/* jscpd:ignore-end */

describeWithEnv(
  "site-assignment",
  {
    db: true,
    env: { CAN_BUILD_SITES: "true" },
  },
  () => {
    const suite = setUpAssignmentSuite();

    const expectSetupEmailBody = async (setupUrl: string) => {
      await assignAndNotifyBuiltSites([siteEntry()]);
      const body = JSON.parse(suite.fetchStub.calls[0]!.args[1].body);
      expect(body.html).toContain(`href="${setupUrl}"`);
      expect(body.text).toContain(setupUrl);
      return body;
    };

    /** Assert the first built site was assigned an attendee but no email fired. */
    const expectAssignedNoEmail = async (): Promise<void> => {
      const sites = await builtSites.getAll();
      expect(sites[0]!.assignedAttendeeId).not.toBeNull();
      expect(suite.fetchStub.calls.length).toBe(0);
    };

    /** The two live sites every multi-site assignment test starts from. */
    const insertSitesAAndB = async () => {
      await insertBuiltSite("Site A", "a.test.net", "", "", true);
      await insertBuiltSite("Site B", "b.test.net", "", "", true);
    };

    describe("assignAndNotifyBuiltSites", () => {
      test("assigns one site per booking and sends email", async () => {
        await insertSitesAAndB();

        await assignAndNotifyBuiltSites([siteEntry({ quantity: 2 })]);

        const sites = await builtSites.getAll();
        const assigned = sites.filter((s) => s.assignedAttendeeId !== null);
        expect(assigned).toHaveLength(1);
        expect(assigned.every((s) => !s.assignable)).toBe(true);
        expect(suite.fetchStub.calls.length).toBe(1);
      });

      test("skips listings without assign_built_site", async () => {
        await insertBuiltSite("Site A", "a.test.net", "", "", true);

        await assignAndNotifyBuiltSites([
          siteEntry({ assignBuiltSite: false }),
        ]);

        const sites = await builtSites.getAll();
        expect(sites[0]!.assignable).toBe(true);
        expect(sites[0]!.assignedAttendeeId).toBeNull();
        expect(suite.fetchStub.calls.length).toBe(0);
      });

      test("combines one buyer's plan listings into one site with summed months", async () => {
        await insertBuiltSite("Site A", "a.test.net", "", "", true, "2005");
        await insertBuiltSite("Site B", "b.test.net", "", "", true, "2006");

        await assignAndNotifyBuiltSites([
          siteEntry({
            attendeeId: 10,
            initialSiteMonths: 12,
            listingId: 1,
            listingName: "12 Month Plan",
          }),
          siteEntry({
            attendeeId: 10,
            initialSiteMonths: 3,
            listingId: 2,
            listingName: "3 Month Plan",
          }),
        ]);

        const sites = await builtSites.getAll();
        expect(sites.filter((s) => s.assignedAttendeeId !== null)).toHaveLength(
          1,
        );
        // 12 + 3: the buyer's two plans buy 15 months on their one site.
        const assigned = await suite.expectFlagPushOutcome(
          "Site A",
          addMonthsIso(nowIso(), 15).slice(0, 10),
        );
        expect(assigned.assignedAttendeeId).toBe(10);
        expect(assigned.assignedListingId).toBe(1);
        const body = JSON.parse(suite.fetchStub.calls[0]!.args[1].body);
        expect(body.subject).toBe("Your new site is ready");
        expect(body.html).toContain("12 Month Plan + 3 Month Plan");
        expect(body.html).toContain("https://a.test.net/setup/");
      });

      test("a no-quantity plan line beside a booked one adds no site and no months", async () => {
        await insertBuiltSite("Site A", "a.test.net", "", "", true, "2007");

        await assignAndNotifyBuiltSites([
          siteEntry({
            attendeeId: 10,
            initialSiteMonths: 3,
            listingId: 1,
            quantity: 0,
          }),
          siteEntry({
            attendeeId: 10,
            initialSiteMonths: 3,
            listingId: 2,
            quantity: 2,
          }),
        ]);

        const remaining = await builtSites.getAll();
        expect(
          remaining.filter((s) => s.assignedAttendeeId !== null),
        ).toHaveLength(1);
        // 2 units of the 3-month plan: the 0-quantity line adds nothing.
        await suite.expectFlagPushOutcome(
          "Site A",
          addMonthsIso(nowIso(), 6).slice(0, 10),
        );
      });

      /** The one warning email this run sent, parsed for its assertions. */
      const warningEmailBody = (): Record<string, unknown> => {
        expect(suite.fetchStub.calls.length).toBe(1);
        return JSON.parse(suite.fetchStub.calls[0]!.args[1].body);
      };

      test("an empty pool keeps the booking and warns the business email", async () => {
        await insertBuiltSite("Site A", "a.test.net", "", "", false);
        await settings.update.businessEmail("biz@example.com");
        using _build = forbidBuildDuringAssignment();
        const errorSpy = silencedErrors();

        try {
          await assignAndNotifyBuiltSites([siteEntry()]);

          const sites = await builtSites.getAll();
          const existing = sites.find((s) => s.name === "Site A")!;
          expect(existing.assignedAttendeeId).toBeNull();
          // The buyer's booking stands with no setup email, and one warning
          // email reaches the business address.
          const body = warningEmailBody();
          expect(body.subject).toBe("A site plan sold with no site available");
          expect(body.to).toEqual(["biz@example.com"]);
          expect(body.html).toContain(
            "Test Listing — Jane Doe (jane@example.com)",
          );
          expect(body.text).toContain("/admin/built-sites");
          expect(
            errorSpy.calls.some((c) =>
              String(c.args[0]).includes(ErrorCode.SITE_ASSIGNMENT),
            ),
          ).toBe(true);
        } finally {
          errorSpy.restore();
        }
      });

      test("one warning email names every buyer the pool could not serve", async () => {
        await settings.update.businessEmail("biz@example.com");
        using _build = forbidBuildDuringAssignment();

        await assignAndNotifyBuiltSites([
          siteEntry({ attendeeId: 11 }),
          siteEntry({ attendeeId: 12, listingName: "Second Plan" }),
        ]);
        const body = warningEmailBody();
        for (const buyer of [
          "Test Listing — Jane Doe (jane@example.com)",
          "Second Plan — Jane Doe (jane@example.com)",
        ]) {
          expect(body.html).toContain(buyer);
        }
      });

      test("no-ops for empty entries", async () => {
        await assignAndNotifyBuiltSites([]);
        expect(suite.fetchStub.calls.length).toBe(0);
      });

      test("leaves later buyers unassigned when the pool runs short", async () => {
        await insertBuiltSite("Site A", "a.test.net", "", "", true);
        await settings.update.businessEmail("biz@example.com");
        using _build = forbidBuildDuringAssignment();

        await assignAndNotifyBuiltSites([
          siteEntry({ attendeeId: 11 }),
          siteEntry({ attendeeId: 12 }),
          siteEntry({ attendeeId: 13 }),
        ]);

        const sites = await builtSites.getAll();
        expect(sites.filter((s) => s.assignedAttendeeId !== null)).toHaveLength(
          1,
        );
        // One warning email for the two unserved buyers, then the setup email.
        expect(suite.fetchStub.calls.length).toBe(2);
        const warning = JSON.parse(suite.fetchStub.calls[0]!.args[1].body);
        expect(warning.subject).toBe("A site plan sold with no site available");
        expect(warning.html.match(/<li>/g)?.length).toBe(2);
        expect(JSON.parse(suite.fetchStub.calls[1]!.args[1].body).subject).toBe(
          "Your new site is ready",
        );
      });

      /** The pool served exactly one site to the buyer, and emailed once. */
      const expectOneSiteServed = async () => {
        const sites = await builtSites.getAll();
        expect(sites.filter((s) => s.assignedAttendeeId !== null)).toHaveLength(
          1,
        );
        expect(sites.find((s) => s.name === "Site B")!.assignable).toBe(true);
        expect(suite.fetchStub.calls.length).toBe(1);
      };

      test("a re-sent notification does not take a second site for a served buyer", async () => {
        await insertSitesAAndB();

        const resend = () =>
          assignAndNotifyBuiltSites([
            siteEntry({ attendeeId: 10, listingId: 1, listingName: "Plan" }),
          ]);
        await resend();
        await resend();

        await expectOneSiteServed();
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
      });

      test("sends email with plural subject for multiple sites", async () => {
        await insertSitesAAndB();

        // Two buyers in one order, each with their own site.
        await assignAndNotifyBuiltSites([
          siteEntry({
            attendeeId: 10,
            listingId: 1,
            listingName: "Listing 1",
          }),
          siteEntry({
            attendeeId: 11,
            listingId: 2,
            listingName: "Listing 2",
          }),
        ]);

        expect(suite.fetchStub.calls.length).toBe(1);
        const body = JSON.parse(suite.fetchStub.calls[0]!.args[1].body);
        expect(body.subject).toContain("2 new sites");
      });

      test("sends email with singular subject for one site", async () => {
        await insertBuiltSite("Site A", "a.test.net", "", "", true);

        await assignAndNotifyBuiltSites([siteEntry()]);

        suite.expectLastEmailBody({ subject: "Your new site is ready" });
      });

      test("email links to the assigned site's /setup/ page", async () => {
        await insertBuiltSite("Site A", "a.test.net", "", "", true);

        const body = await expectSetupEmailBody("https://a.test.net/setup/");
        expect(body.html).toContain("activate your site");
      });

      test("email setup link keeps the scheme when the site URL already has one", async () => {
        await insertBuiltSite("Site C", "https://c.test.net/", "", "", true);

        await expectSetupEmailBody("https://c.test.net/setup/");
      });

      test("email setup link names a bunny.run site by its stable b-cdn.net address", async () => {
        await insertBuiltSite("Site D", "newbooking.bunny.run", "", "", true);

        await expectSetupEmailBody("https://newbooking.b-cdn.net/setup/");
      });

      test("uses DB email config when available and includes reply-to", async () => {
        // Configure email via DB settings (not host config) so getEmailConfig()
        // returns non-null, covering the left branch of the ?? operator
        await settings.update.email.provider("resend");
        await settings.update.email.apiKey("re_db_key");
        await settings.update.email.fromAddress("db@example.com");
        await settings.update.businessEmail("biz@example.com");
        hostEmail.setOverride(null);

        await insertBuiltSite("Site A", "a.test.net", "", "", true);
        await assignAndNotifyBuiltSites([siteEntry()]);

        suite.expectLastEmailBody({ reply_to: "biz@example.com" });
      });

      test("skips email when no email config", async () => {
        hostEmail.setOverride(null);

        await insertBuiltSite("Site A", "a.test.net", "", "", true);
        await assignAndNotifyBuiltSites([siteEntry()]);

        await expectAssignedNoEmail();
      });

      test("assigns the site but skips email when the attendee email is invalid", async () => {
        await insertBuiltSite("Site A", "a.test.net", "", "", true);
        await assignAndNotifyBuiltSites([siteEntry({ email: "not-an-email" })]);

        await expectAssignedNoEmail();
      });
    });

    describe("feature flag", () => {
      test("no-ops when CAN_BUILD_SITES is disabled", async () => {
        using _env = withEnv({ CAN_BUILD_SITES: undefined });
        await insertBuiltSite("Site A", "a.test.net", "", "", true);
        await assignAndNotifyBuiltSites([siteEntry()]);
        const sites = await builtSites.getAll();
        expect(sites[0]!.assignable).toBe(true);
        expect(sites[0]!.assignedAttendeeId).toBeNull();
      });
    });
  },
);
