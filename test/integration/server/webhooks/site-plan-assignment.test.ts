// jscpd:ignore-start
import { expect } from "@std/expect";
import { afterEach, beforeEach, it as test } from "@std/testing/bdd";
import { type Stub, stub } from "@std/testing/mock";
import { getAttendeesRaw } from "#db/attendees/queries.ts";
import { builtSites, insertBuiltSite } from "#db/built-sites.ts";
import { settings } from "#db/settings.ts";
import { builderApi } from "#shared/builder.ts";
import { bunnyCdnApi } from "#shared/bunny-cdn.ts";
import { addMonthsIso } from "#shared/dates.ts";
import { hostEmail } from "#shared/email.ts";
import { ErrorCode } from "#shared/logger.ts";
import { nowIso } from "#shared/now.ts";
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
    let secretStub: Stub;

    /** Assignment hands out pre-built sites only; building one here fails. */
    const forbidBuild = (): Stub =>
      stub(builderApi, "buildSite", () => {
        throw new Error(
          "Assignment must hand out pre-built sites, never build one",
        );
      });

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
      secretStub = stub(bunnyCdnApi, "setEdgeScriptSecret", () =>
        Promise.resolve({ ok: true as const }),
      );
      hostEmail.setOverride({
        apiKey: "re_test",
        fromAddress: validEmail("host@example.com"),
        provider: "resend",
      });
    });

    afterEach(() => {
      fetchStub.restore();
      secretStub.restore();
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

    test("a paid site plan assigns a pooled site, one term, and sends the setup email", async () => {
      using _build = forbidBuild();
      const plan = await createOneMonthPlan();
      await insertBuiltSite("Pooled", "pooled.b-cdn.net", "", "", true, "3001");

      await payForPlan(plan, "site_plan");

      const attendees = await getAttendeesRaw(plan.id);
      expect(attendees.length).toBe(1);
      const attendeeId = attendees[0]!.id;

      const sites = await builtSites.getAll();
      const assigned = sites.filter(
        (site) => site.assignedAttendeeId === attendeeId,
      );
      expect(assigned).toHaveLength(1);
      expect(assigned[0]!.readOnlyFrom?.slice(0, 10)).toBe(
        addMonthsIso(nowIso(), 1).slice(0, 10),
      );

      expect(
        sentBodies().some((body) => body.includes("Your new site is ready")),
      ).toBe(true);
    });

    test("an empty pool keeps the paid booking and warns the operator", async () => {
      using _build = forbidBuild();
      using _env = withEnv({ NTFY_URL: "https://ntfy.test/topic" });
      using _error = stub(console, "error", () => {});
      await settings.update.businessEmail("biz@example.com");
      const plan = await createOneMonthPlan();

      await payForPlan(plan, "site_plan_empty");

      // The money and the booking stand.
      expect((await getAttendeesRaw(plan.id)).length).toBe(1);
      // No site was assigned, and the buyer got no setup email.
      const sites = await builtSites.getAll();
      expect(sites.filter((site) => site.assignedAttendeeId !== null)).toEqual(
        [],
      );
      const bodies = sentBodies();
      expect(
        bodies.some((body) => body.includes("Your new site is ready")),
      ).toBe(false);
      // The empty pool is an incident the operator can see: the warning email,
      // the console line, and the ntfy ping.
      expect(
        bodies.some((body) =>
          body.includes("A site plan sold with no site available"),
        ),
      ).toBe(true);
      expect(
        _error.calls.some((call) =>
          String(call.args[0]).includes(ErrorCode.SITE_ASSIGNMENT),
        ),
      ).toBe(true);
      expect(bodies.some((body) => body === ErrorCode.SITE_ASSIGNMENT)).toBe(
        true,
      );
    });
  },
);
