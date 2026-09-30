import { expect } from "@std/expect";
import { afterEach, beforeEach, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { builtSites, insertBuiltSite } from "#db/built-sites.ts";
import { bunnyCdnApi } from "#shared/bunny-cdn.ts";
import { hostEmail } from "#shared/email.ts";
import { assignAndNotifyBuiltSites } from "#shared/site-assignment.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { validEmail } from "#test-utils/email.ts";
import { makeTestEntry } from "#test-utils/factories.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";
import { assignmentEntry, sendSetupEmail } from "./contracts-setup.ts";

describeWithEnv(
  "site assignment email contracts",
  { db: true, env: { CAN_BUILD_SITES: "true" } },
  () => {
    beforeEach(async () => {
      hostEmail.setOverride({
        apiKey: "re_test",
        fromAddress: validEmail("host@example.com"),
        provider: "resend",
      });
      await createTestListing({
        hidden: true,
        monthsPerUnit: 1,
        purchaseOnly: true,
      });
    });

    afterEach(hostEmail.resetOverride);

    test("sends the exact single-site setup message", async () => {
      const body = await sendSetupEmail(["A"]);
      expect(body.subject).toBe("Your new site is ready");
      expect(body.html).toBe(
        '<p>Your new site is ready!</p><p>Visit the setup link below to activate your site:</p><ul><li>Hosted listing: <a href="https://a.test/setup/">https://a.test/setup/</a></li></ul>',
      );
      expect(body.text).toBe(
        "Your new site is ready!\n\nVisit the setup link below to activate your site:\n\n- Hosted listing: https://a.test/setup/",
      );
    });

    test("separates every site in the exact multi-site setup message", async () => {
      const body = await sendSetupEmail(["A", "B"]);
      expect(body.subject).toBe("Your 2 new sites are ready");
      expect(body.html).toBe(
        '<p>Your new sites are ready!</p><p>Visit the setup links below to activate your sites:</p><ul><li>Hosted listing: <a href="https://a.test/setup/">https://a.test/setup/</a></li><li>Hosted listing: <a href="https://b.test/setup/">https://b.test/setup/</a></li></ul>',
      );
      expect(body.text).toBe(
        "Your new sites are ready!\n\nVisit the setup links below to activate your sites:\n\n- Hosted listing: https://a.test/setup/\n- Hosted listing: https://b.test/setup/",
      );
    });

    test("a no-quantity line books no site and sends no email", async () => {
      using fetchStub = stubFetch(new Response());
      using _secret = stub(bunnyCdnApi, "setEdgeScriptSecret", () =>
        Promise.resolve({ ok: true as const }),
      );
      await insertBuiltSite("Site Z", "z.test", "", "", true, "131");

      const noQuantity = assignmentEntry();
      noQuantity.attendee = {
        ...noQuantity.attendee,
        email: "buyer@example.com",
        quantity: 0,
      };
      await assignAndNotifyBuiltSites([noQuantity]);

      const site = (await builtSites.getAll()).find(
        ({ name }) => name === "Site Z",
      )!;
      expect(site.assignedAttendeeId).toBeNull();
      expect(fetchStub.calls).toEqual([]);
    });

    test("one email names every plan listing a multi-listing buyer booked", async () => {
      using fetchStub = stubFetch(new Response());
      using _secret = stub(bunnyCdnApi, "setEdgeScriptSecret", () =>
        Promise.resolve({ ok: true as const }),
      );
      await insertBuiltSite("Site J", "j.test", "", "", true, "141");

      const planEntry = (id: number, name: string) => ({
        attendee: {
          ...assignmentEntry().attendee,
          email: "buyer@example.com",
        },
        listing: makeTestEntry({
          assign_built_site: true,
          id,
          initial_site_months: 3,
          name,
        }).listing,
      });
      await assignAndNotifyBuiltSites([
        planEntry(72, "Bronze plan"),
        planEntry(73, "Gold plan"),
      ]);

      expect(fetchStub.calls).toHaveLength(1);
      const body = JSON.parse(fetchStub.calls[0]!.args[1].body);
      expect(body.text).toContain(
        "Bronze plan + Gold plan: https://j.test/setup/",
      );
    });
  },
);
