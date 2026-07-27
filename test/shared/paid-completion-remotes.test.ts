import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { bunnyCdnApi } from "#shared/bunny-cdn.ts";
import { builtSites, insertBuiltSite } from "#shared/db/built-sites.ts";
import { type EmailConfig, sendEmailStrict } from "#shared/email.ts";
import type { SiteAssignmentDelivery } from "#shared/payment-completion-delivery.ts";
import { applyPaidRenewal, paidRenewalDeliveriesFor } from "#shared/renewal.ts";
import { applyPaidSiteAssignment } from "#shared/site-assignment-paid.ts";
import { sendWebhookStrict } from "#shared/webhook-paid.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  provisionTestBuiltSite,
  runSiteAssignment,
} from "#test-utils/db-helpers/built-sites.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { validEmail } from "#test-utils/email.ts";
import { makeTestEntry } from "#test-utils/factories.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";

const assignmentDelivery = (): SiteAssignmentDelivery => ({
  attendeeId: 41,
  effectId: "payment-41:site:41:7:0",
  initialSiteMonths: 3,
  kind: "site_assignment",
  listingId: 7,
  listingName: "Hosted ticket",
  site: null,
});

const renewalDelivery = async (hostingId: string) => {
  const site = await insertBuiltSite(
    "Renew",
    `renew-${hostingId}.example.com`,
    "",
    "",
    false,
    hostingId,
  );
  const previousReadOnlyFrom = "2027-01-15T00:00:00.000Z";
  const { tokenIndex } = await provisionTestBuiltSite(site.id, {
    readOnlyFrom: previousReadOnlyFrom,
  });
  const tier = await createTestListing({
    hidden: true,
    monthsPerUnit: 2,
    purchaseOnly: true,
  });
  const [prepared] = await paidRenewalDeliveriesFor(tokenIndex)([
    makeTestEntry(
      {
        active: true,
        hidden: true,
        id: tier.id,
        months_per_unit: 2,
        purchase_only: true,
      },
      { quantity: 2 },
    ),
  ]);
  if (prepared?.data.kind !== "renewal") {
    throw new Error("Expected a renewal delivery");
  }
  return { data: prepared.data, previousReadOnlyFrom, site };
};

describeWithEnv(
  "paid completion remote effects",
  { db: true, env: { CAN_BUILD_SITES: "true" } },
  () => {
    test("a site assignment replay keeps one assigned site", async () => {
      await insertBuiltSite("Ready", "ready.example.com", "", "", true, "91");
      using secrets = stub(bunnyCdnApi, "setEdgeScriptSecret", () =>
        Promise.resolve({ ok: true as const }),
      );
      const stored = await runSiteAssignment(assignmentDelivery());
      await applyPaidSiteAssignment(stored, () => {
        throw new Error("A staged assignment must not be replaced");
      });

      const assigned = (await builtSites.getAll()).filter(
        (site) => site.assignmentEffect === stored.effectId,
      );
      expect(assigned).toHaveLength(1);
      expect(assigned[0]).toMatchObject({
        assignedAttendeeId: 41,
        assignedListingId: 7,
      });
      expect(secrets.calls).toHaveLength(2);
    });

    test("a site assignment 500 propagates without assigning another site", async () => {
      await insertBuiltSite("Ready", "ready.example.com", "", "", true, "92");
      using _secrets = stub(bunnyCdnApi, "setEdgeScriptSecret", () =>
        Promise.resolve({ error: "status 500", ok: false as const }),
      );
      let stored = assignmentDelivery();

      await expect(
        applyPaidSiteAssignment(stored, (next) => {
          stored = next;
          return Promise.resolve();
        }),
      ).rejects.toThrow("Paid site assignment failed: status 500");

      expect(
        (await builtSites.getAll()).filter(
          (site) => site.assignmentEffect === stored.effectId,
        ),
      ).toHaveLength(1);
    });

    test("a renewal replay applies its absolute deadline once", async () => {
      const { data, previousReadOnlyFrom, site } = await renewalDelivery("93");
      using secrets = stub(bunnyCdnApi, "setEdgeScriptSecret", () =>
        Promise.resolve({ ok: true as const }),
      );

      await applyPaidRenewal(data);
      await applyPaidRenewal(data);

      const renewed = (await builtSites.getAll()).find(
        (stored) => stored.id === site.id,
      );
      expect(renewed?.readOnlyFrom).toBe(data.readOnlyFrom);
      expect(renewed?.readOnlyFrom).not.toBe(previousReadOnlyFrom);
      expect(secrets.calls).toHaveLength(1);
    });

    test("a renewal 500 leaves its stored deadline unchanged", async () => {
      const { data, previousReadOnlyFrom, site } = await renewalDelivery("94");
      using _secrets = stub(bunnyCdnApi, "setEdgeScriptSecret", () =>
        Promise.resolve({ error: "status 500", ok: false as const }),
      );

      await expect(applyPaidRenewal(data)).rejects.toThrow(
        "Paid renewal failed: status 500",
      );

      const stored = (await builtSites.getAll()).find(
        (candidate) => candidate.id === site.id,
      );
      expect(stored?.readOnlyFrom).toBe(previousReadOnlyFrom);
    });

    test("remote 500 responses propagate from strict email and webhook sends", async () => {
      const fetch = stubFetch(() => new Response("failed", { status: 500 }));
      const config: EmailConfig = {
        apiKey: "test",
        fromAddress: validEmail("from@example.com"),
        provider: "resend",
      };
      try {
        await expect(
          sendEmailStrict(config, {
            html: "<p>Ticket</p>",
            subject: "Ticket",
            text: "Ticket",
            to: validEmail("buyer@example.com"),
          }),
        ).rejects.toThrow("Email delivery failed with status 500");
        await expect(
          sendWebhookStrict("https://hooks.example.com/register", {
            address: "",
            amount_owed: 0,
            business_email: "",
            currency: "GBP",
            email: "buyer@example.com",
            name: "Buyer",
            notification_type: "registration.completed",
            payment_id: "payment-1",
            phone: "",
            price_paid: 100,
            special_instructions: "",
            ticket_url: "https://tickets.example.com/t/one",
            tickets: [],
            timestamp: "2026-07-26T12:00:00.000Z",
          }),
        ).rejects.toThrow("Webhook delivery failed with status 500");
      } finally {
        fetch.restore();
      }
    });
  },
);
