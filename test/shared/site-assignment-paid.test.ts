import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { bunnyCdnApi } from "#shared/bunny-cdn.ts";
import {
  builtSites,
  insertBuiltSite,
  updateBuiltSiteRenewalState,
} from "#shared/db/built-sites.ts";
import { execute } from "#shared/db/client.ts";
import {
  type EmailConfig,
  resetHostEmailConfig,
  setHostEmailConfigForTest,
} from "#shared/email.ts";
import type {
  SiteAssignmentDelivery,
  SiteAssignmentEmailDelivery,
} from "#shared/payment-completion-delivery.ts";
import type { SiteAssignmentEntry } from "#shared/site-assignment.ts";
import {
  applyPaidSiteAssignment,
  paidSiteAssignment,
  preparePaidSiteAssignmentDeliveries,
  sendPreparedSiteAssignmentEmail,
} from "#shared/site-assignment-paid.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  runSiteAssignment,
  useRenewalTier,
} from "#test-utils/db-helpers/built-sites.ts";
import { validEmail } from "#test-utils/email.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";

const HOST_EMAIL: EmailConfig = {
  apiKey: "key",
  fromAddress: validEmail("host@example.com"),
  provider: "resend",
};

/** One paid entry: a listing that hands out a site, bought `quantity` times. */
const entry = (
  overrides: {
    attendeeId?: number;
    email?: string;
    initialSiteMonths?: number;
    listingId?: number;
    quantity?: number;
  } = {},
): SiteAssignmentEntry => ({
  attendee: {
    email: overrides.email ?? "buyer@example.com",
    id: overrides.attendeeId ?? 41,
    quantity: overrides.quantity ?? 1,
  },
  listing: {
    assign_built_site: true,
    id: overrides.listingId ?? 7,
    initial_site_months: overrides.initialSiteMonths ?? 3,
    name: "Hosted ticket",
  },
});

const plainEntry = (): SiteAssignmentEntry => ({
  ...entry(),
  listing: { ...entry().listing, assign_built_site: false },
});

const assignmentDelivery = (
  site: SiteAssignmentDelivery["site"] = null,
): SiteAssignmentDelivery => ({
  attendeeId: 41,
  effectId: "payment-41:site-assignment:41:7:0",
  initialSiteMonths: 3,
  kind: "site_assignment",
  listingId: 7,
  listingName: "Hosted ticket",
  site,
});

describeWithEnv(
  "paid site assignment",
  { db: true, env: { CAN_BUILD_SITES: "true" } },
  () => {
    useRenewalTier();

    test("an order with no site listing asks for nothing", async () => {
      expect(
        await preparePaidSiteAssignmentDeliveries("pay_1", [plainEntry()]),
      ).toEqual([]);
    });

    test("each unit bought gets its own site, numbered from zero", async () => {
      setHostEmailConfigForTest(null);
      try {
        const deliveries = await preparePaidSiteAssignmentDeliveries("pay_2", [
          entry({ quantity: 2 }),
        ]);
        expect(deliveries.map(({ key }) => key)).toEqual([
          "site-assignment:41:7:0",
          "site-assignment:41:7:1",
        ]);
        expect(deliveries[0]?.data).toMatchObject({
          attendeeId: 41,
          effectId: "pay_2:site-assignment:41:7:0",
          initialSiteMonths: 3,
          kind: "site_assignment",
          listingId: 7,
          listingName: "Hosted ticket",
          site: null,
        });
      } finally {
        resetHostEmailConfig();
      }
    });

    test("two lines for the same listing keep counting up, never colliding", async () => {
      setHostEmailConfigForTest(null);
      try {
        const deliveries = await preparePaidSiteAssignmentDeliveries("pay_3", [
          entry({ quantity: 1 }),
          entry({ quantity: 2 }),
        ]);
        expect(deliveries.map(({ key }) => key)).toEqual([
          "site-assignment:41:7:0",
          "site-assignment:41:7:1",
          "site-assignment:41:7:2",
        ]);
      } finally {
        resetHostEmailConfig();
      }
    });

    test("the buyer is sent one email listing every site", async () => {
      setHostEmailConfigForTest(HOST_EMAIL);
      try {
        const deliveries = await preparePaidSiteAssignmentDeliveries("pay_4", [
          entry({ quantity: 2 }),
        ]);
        const email = deliveries.at(-1);
        expect(email?.key).toBe("site-assignment-email");
        expect(email?.data).toEqual({
          assignmentKeys: ["site-assignment:41:7:0", "site-assignment:41:7:1"],
          config: {
            fromAddress: HOST_EMAIL.fromAddress,
            provider: HOST_EMAIL.provider,
          },
          kind: "site_assignment_email",
          recipient: validEmail("buyer@example.com"),
        });
      } finally {
        resetHostEmailConfig();
      }
    });

    test("an address the site cannot read means no email, but the sites still go out", async () => {
      setHostEmailConfigForTest(HOST_EMAIL);
      try {
        const deliveries = await preparePaidSiteAssignmentDeliveries("pay_5", [
          entry({ email: "not-an-address" }),
        ]);
        expect(deliveries.map(({ key }) => key)).toEqual([
          "site-assignment:41:7:0",
        ]);
      } finally {
        resetHostEmailConfig();
      }
    });

    test("a site listing priced for no months is refused before anything is asked for", async () => {
      await expect(
        preparePaidSiteAssignmentDeliveries("pay_6", [
          entry({ initialSiteMonths: 0 }),
        ]),
      ).rejects.toThrow("Paid site assignment is not available");
    });

    test("a site that was taken over between the payment and the work is refused", async () => {
      await insertBuiltSite("Ready", "taken.example.com", "", "", true, "81");
      using _secrets = stub(bunnyCdnApi, "setEdgeScriptSecret", () =>
        Promise.resolve({ ok: true as const }),
      );
      const stored = await runSiteAssignment(assignmentDelivery());

      // The same site, but the work now claims a different buyer bought it.
      await expect(
        applyPaidSiteAssignment(
          { ...stored, attendeeId: stored.attendeeId + 1 },
          () => Promise.resolve(),
        ),
      ).rejects.toThrow("Paid site assignment facts changed after payment");
    });

    test("a site renewed by someone else after payment is refused", async () => {
      // Two renewals paid at the same time both write down the date the site
      // had when they started. If the other one moves that date first, this
      // work must stop rather than push the date back from a stale reading.
      await insertBuiltSite("Ready", "raced.example.com", "", "", true, "83");
      using _secrets = stub(bunnyCdnApi, "setEdgeScriptSecret", () =>
        Promise.resolve({ ok: true as const }),
      );
      const stored = await runSiteAssignment(assignmentDelivery());
      await updateBuiltSiteRenewalState(stored.site!.siteId, {
        readOnlyFrom: "2099-01-01T00:00:00.000Z",
        renewalTokenIndex: "another-renewal",
      });
      builtSites.invalidate();

      await expect(
        applyPaidSiteAssignment(stored, () => Promise.resolve()),
      ).rejects.toThrow("renewal facts changed after payment");
    });

    test("a site removed after it was reserved is reported, not replaced", async () => {
      await insertBuiltSite("Ready", "gone.example.com", "", "", true, "82");
      using _secrets = stub(bunnyCdnApi, "setEdgeScriptSecret", () =>
        Promise.resolve({ ok: true as const }),
      );
      const stored = await runSiteAssignment(assignmentDelivery());
      await execute("DELETE FROM built_sites WHERE id = ?", [
        stored.site!.siteId,
      ]);
      builtSites.invalidate();

      await expect(
        applyPaidSiteAssignment(stored, () => Promise.resolve()),
      ).rejects.toThrow("was removed");
    });

    test("the buyer's email names every site they bought", async () => {
      let body = "";
      using _fetch = stubFetch((_url, init) => {
        body = String(init?.body ?? "");
        return new Response('{"id":"sent"}', { status: 200 });
      });
      setHostEmailConfigForTest(HOST_EMAIL);
      try {
        const delivery: SiteAssignmentEmailDelivery = {
          assignmentKeys: ["site-assignment:41:7:0"],
          config: {
            fromAddress: HOST_EMAIL.fromAddress,
            provider: HOST_EMAIL.provider,
          },
          kind: "site_assignment_email",
          recipient: validEmail("buyer@example.com"),
        };
        await sendPreparedSiteAssignmentEmail(delivery, [
          { listingName: "First ticket", siteUrl: "https://one.example.com" },
          { listingName: "Second ticket", siteUrl: "https://two.example.com" },
        ]);
        expect(body).toContain("buyer@example.com");
        expect(body).toContain("https://one.example.com");
        expect(body).toContain("https://two.example.com");
      } finally {
        resetHostEmailConfig();
      }
    });

    test("a finished assignment reads out its listing and site address", () => {
      expect(
        paidSiteAssignment(
          assignmentDelivery({
            hostingId: "84",
            hostingProvider: "bunny",
            previousReadOnlyFrom: "",
            previousRenewalTokenIndex: null,
            readOnlyFrom: "2027-01-01T00:00:00.000Z",
            renewalToken: "tok",
            renewalTokenIndex: "idx",
            renewalUrl: "https://example.com/renew/tok",
            siteId: 1,
            siteName: "Ready",
            siteUrl: "https://ready.example.com",
          }),
        ),
      ).toEqual({
        listingName: "Hosted ticket",
        siteUrl: "https://ready.example.com",
      });
    });

    test("an assignment with no site yet cannot be read out", () => {
      expect(() => paidSiteAssignment(assignmentDelivery())).toThrow(
        "has no site facts",
      );
    });
  },
);

describeWithEnv(
  "paid site assignment without a builder",
  { db: true, env: { CAN_BUILD_SITES: "false" } },
  () => {
    test("an order for a site is refused when the site builder is off", async () => {
      await expect(
        preparePaidSiteAssignmentDeliveries("pay_off", [entry()]),
      ).rejects.toThrow("Site assignment settings changed after payment");
    });

    test("the builder being switched off after payment is reported", async () => {
      await expect(
        applyPaidSiteAssignment(assignmentDelivery(), () => Promise.resolve()),
      ).rejects.toThrow("Site assignment settings changed after payment");
    });
  },
);
