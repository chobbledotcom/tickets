// jscpd:ignore-start
import { expect } from "@std/expect";
import { afterEach, beforeEach, it as test } from "@std/testing/bdd";
import { type Stub, stub } from "@std/testing/mock";
import { builtSites } from "#db/built-sites.ts";
import { type BuildSiteInput, builderApi } from "#shared/builder.ts";
import { bunnyCdnApi } from "#shared/bunny-cdn.ts";
import { addMonthsIso } from "#shared/dates.ts";
import { hostEmail } from "#shared/email.ts";
import { ErrorCode } from "#shared/logger.ts";
import { nowIso } from "#shared/now.ts";
import { generateScheduledTaskKey } from "#shared/scheduled-keys.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { validEmail } from "#test-utils/email.ts";
import { withEnv } from "#test-utils/env.ts";
import { signedMeta, singleItem } from "#test-utils/factories.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";
import { setupStripe } from "#test-utils/settings.ts";
import {
  checkoutSessionEvent,
  expectWebhookProcessed,
} from "#test-utils/webhooks.ts";

// jscpd:ignore-end

describeWithEnv(
  "server webhooks > site plan assignment",
  { db: true, env: { CAN_BUILD_SITES: "true" }, triggers: true },
  () => {
    let fetchStub: Stub;
    let buildStub: Stub;

    beforeEach(async () => {
      await setupStripe();
      // The hidden monthly tier a site plan's checkout validation requires.
      await createTestListing({
        hidden: true,
        monthsPerUnit: 1,
        purchaseOnly: true,
        unitPrice: 300,
      });
      fetchStub = stubFetch(() => new Response());
      hostEmail.setOverride({
        apiKey: "re_test",
        fromAddress: validEmail("host@example.com"),
        provider: "resend",
      });
      buildStub = stub(
        builderApi,
        "buildSite",
        async (_input: BuildSiteInput, retain) => {
          const result = {
            dbProvider: "bunny" as const,
            dbToken: "token-paid",
            dbUrl: "libsql://paid.test",
            defaultHostname: "paid.b-cdn.net",
            hostingId: "2001",
            hostingProvider: "bunny" as const,
            ok: true as const,
          };
          await retain({
            ...result,
            scheduledTaskKey: generateScheduledTaskKey(),
          });
          return result;
        },
      );
    });

    afterEach(() => {
      fetchStub.restore();
      if (!buildStub.restored) buildStub.restore();
      hostEmail.resetOverride();
    });

    /** Complete a paid purchase of one unit of the plan through the webhook,
     * the way a real checkout session would be processed. */
    const payForPlan = async (
      plan: { id: number },
      sessionId: string,
    ): Promise<void> => {
      await expectWebhookProcessed(
        checkoutSessionEvent({
          amountTotal: 1000,
          eventId: `evt_${sessionId}`,
          metadata: signedMeta(
            {
              email: "sitebuyer@example.com",
              items: singleItem(plan.id, 1, 1000),
              name: "Site Buyer",
            },
            1000,
          ),
          paymentIntent: `pi_${sessionId}`,
          sessionId: `cs_${sessionId}`,
        }),
      );
    };

    const createOneMonthPlan = () =>
      createTestListing({
        assignBuiltSite: true,
        initialSiteMonths: 1,
        maxAttendees: 50,
        name: "One Month Site",
        unitPrice: 1000,
      });

    /** The body of every external call the purchase made — emails and ntfy. */
    const sentBodies = (): string[] =>
      fetchStub.calls.map((call) => String(call.args[1]?.body ?? ""));

    test("a paid site plan books one site, one term, and sends the setup email", async () => {
      using _secretStub = stub(bunnyCdnApi, "setEdgeScriptSecret", () =>
        Promise.resolve({ ok: true as const }),
      );
      const plan = await createOneMonthPlan();

      await payForPlan(plan, "site_plan");

      const { getAttendeesRaw } = await import("#db/attendees/queries.ts");
      const attendees = await getAttendeesRaw(plan.id);
      expect(attendees.length).toBe(1);
      const attendeeId = attendees[0]!.id;

      const sites = await builtSites.getAll();
      const assigned = sites.filter(
        (site) => site.assignedAttendeeId === attendeeId,
      );
      expect(buildStub.calls.length).toBe(1);
      expect(assigned).toHaveLength(1);
      expect(assigned[0]!.readOnlyFrom?.slice(0, 10)).toBe(
        addMonthsIso(nowIso(), 1).slice(0, 10),
      );

      expect(
        sentBodies().some((body) => body.includes("Your new site is ready")),
      ).toBe(true);
    });

    test("a build that throws keeps the paid booking and reports the failure", async () => {
      using _env = withEnv({ NTFY_URL: "https://ntfy.test/site-plan" });
      using _error = stub(console, "error", () => {});
      const crash = new Error("edge budget spent mid-build");
      buildStub.restore();
      using _crashingBuild = stub(builderApi, "buildSite", () =>
        Promise.reject(crash),
      );
      const plan = await createOneMonthPlan();

      await payForPlan(plan, "site_plan_crash");

      // The money and the booking stand.
      const { getAttendeesRaw } = await import("#db/attendees/queries.ts");
      expect((await getAttendeesRaw(plan.id)).length).toBe(1);
      // No site was assigned and no setup email was sent.
      const sites = await builtSites.getAll();
      expect(sites.filter((site) => site.assignedAttendeeId !== null)).toEqual(
        [],
      );
      const bodies = sentBodies();
      expect(
        bodies.some((body) => body.includes("Your new site is ready")),
      ).toBe(false);
      // The vanished assignment is now an incident an operator can see:
      // console error, ntfy ping, and the raw error kept for Sentry.
      expect(
        _error.calls.some(
          (call) =>
            String(call.args[0]).includes(ErrorCode.SITE_ASSIGNMENT) &&
            String(call.args[0]).includes(
              "Site assignment failed after a completed booking",
            ),
        ),
      ).toBe(true);
      expect(bodies.some((body) => body === ErrorCode.SITE_ASSIGNMENT)).toBe(
        true,
      );
    });
  },
);
