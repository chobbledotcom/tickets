import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { FakeTime } from "@std/testing/time";
import { bunnyCdnApi } from "#shared/bunny-cdn.ts";
import { builtSites, insertBuiltSite } from "#shared/db/built-sites.ts";
import {
  resetHostEmailConfig,
  setHostEmailConfigForTest,
} from "#shared/email.ts";
import {
  assignAndNotifyBuiltSites,
  isQualifyingTierListing,
  parseReadOnlyFromMs,
  pickTierListing,
  renewalDeadlineBaseMs,
  rotateRenewalToken,
  syncReadOnlyFrom,
  validateSiteAssignmentConfig,
} from "#shared/site-assignment.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { validEmail } from "#test-utils/email.ts";
import { withEnv } from "#test-utils/env.ts";
import { testBuiltSite } from "#test-utils/factories.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";

const configMessage =
  "Site assignment is not configured. Please contact the administrator.";

const configEntry = (initialSiteMonths = 3) => ({
  listing: {
    assign_built_site: true,
    id: 71,
    initial_site_months: initialSiteMonths,
    name: "Hosted listing",
  },
});

const assignmentEntry = (quantity: number) => ({
  attendee: { email: "buyer@example.com", id: 81, quantity },
  listing: {
    assign_built_site: true,
    id: 71,
    initial_site_months: 3,
    name: "Hosted listing",
  },
});

const tierFields = (
  overrides: Partial<Parameters<typeof isQualifyingTierListing>[0]> = {},
) => ({
  active: true,
  hidden: true,
  months_per_unit: 1,
  purchase_only: true,
  ...overrides,
});

const expectBlockedNotification = async (
  entry: ReturnType<typeof configEntry>,
  notification: string,
): Promise<void> => {
  using _env = withEnv({ NTFY_URL: "https://ntfy.test/site-assignment" });
  using fetchStub = stubFetch(new Response());
  using _error = stub(console, "error", () => {});

  await assignAndNotifyBuiltSites([
    { attendee: { email: "buyer@example.com", id: 81, quantity: 1 }, ...entry },
  ]);

  expect(fetchStub.calls.map(({ args }) => args[1].body)).toEqual([
    notification,
  ]);
};

const sendSetupEmail = async (siteNames: readonly string[]) => {
  using fetchStub = stubFetch(new Response());
  using _secret = stub(bunnyCdnApi, "setEdgeScriptSecret", () =>
    Promise.resolve({ ok: true as const }),
  );
  for (const [index, name] of siteNames.entries()) {
    await insertBuiltSite(
      `Site ${name}`,
      `${name.toLowerCase()}.test`,
      "",
      "",
      true,
      String(101 + index),
    );
  }

  await assignAndNotifyBuiltSites([assignmentEntry(siteNames.length)]);

  return JSON.parse(fetchStub.calls[0]!.args[1].body);
};

describe("site assignment configuration contracts", () => {
  test("requires every renewal-tier condition", () => {
    expect([
      isQualifyingTierListing(tierFields()),
      isQualifyingTierListing(tierFields({ purchase_only: false })),
      isQualifyingTierListing(tierFields({ hidden: false })),
      isQualifyingTierListing(tierFields({ months_per_unit: 0 })),
      isQualifyingTierListing(tierFields({ active: false })),
    ]).toEqual([true, false, false, false, false]);
  });

  test("returns the complete builder-disabled error", async () => {
    using _env = withEnv({ CAN_BUILD_SITES: undefined });

    expect(await validateSiteAssignmentConfig([configEntry()])).toEqual({
      message: configMessage,
      ok: false,
      reason: "builder_disabled",
    });
  });

  test("uses the Unix epoch as the empty deadline base at the epoch", () => {
    using _time = new FakeTime(0);

    expect(renewalDeadlineBaseMs({ readOnlyFrom: "" })).toBe(0);
  });

  test("parses a stored read-only deadline", () => {
    const deadline = "2035-06-07T08:09:10.000Z";
    expect(parseReadOnlyFromMs({ readOnlyFrom: deadline })).toBe(
      Date.parse(deadline),
    );
  });

  test("returns an exact missing-hosting-id error", async () => {
    const result = await syncReadOnlyFrom(
      testBuiltSite({ hostingId: "" }),
      "2099-01-01T00:00:00.000Z",
    );

    expect(result).toEqual({ error: "No hostingId", ok: false });
  });
});

describeWithEnv(
  "site assignment validation contracts",
  { db: true, env: { CAN_BUILD_SITES: "true" } },
  () => {
    test("returns the complete invalid-months error", async () => {
      expect(await validateSiteAssignmentConfig([configEntry(0)])).toEqual({
        listingId: 71,
        message: configMessage,
        ok: false,
        reason: "initial_months",
      });
    });

    test("reports invalid initial months after checkout", async () => {
      await expectBlockedNotification(configEntry(0), "DATA_INVALID");
    });

    test("accepts an initial term of one month", async () => {
      await createTestListing({
        hidden: true,
        monthsPerUnit: 1,
        purchaseOnly: true,
      });

      expect(await validateSiteAssignmentConfig([configEntry(1)])).toEqual({
        ok: true,
      });
    });

    test("returns the complete missing-tier error", async () => {
      expect(await validateSiteAssignmentConfig([configEntry()])).toEqual({
        message: configMessage,
        ok: false,
        reason: "missing_tier",
      });
    });

    test("reports a missing renewal tier after checkout", async () => {
      await expectBlockedNotification(configEntry(), "CONFIG_MISSING");
    });

    test("picks the cheapest qualifying tier regardless of insert order", async () => {
      const cheap = await createTestListing({
        hidden: true,
        monthsPerUnit: 1,
        name: "Cheap Tier",
        purchaseOnly: true,
        unitPrice: 300,
      });
      await createTestListing({
        hidden: true,
        monthsPerUnit: 1,
        name: "Expensive Tier",
        purchaseOnly: true,
        unitPrice: 900,
      });

      expect((await pickTierListing())?.id).toBe(cheap.id);
    });
  },
);

describeWithEnv(
  "site renewal push contracts",
  { db: true, env: { CAN_BUILD_SITES: "true" } },
  () => {
    test("persists a successfully pushed read-only deadline", async () => {
      using _secret = stub(bunnyCdnApi, "setEdgeScriptSecret", () =>
        Promise.resolve({ ok: true as const }),
      );
      const cutoff = "2099-04-05T06:07:08.000Z";
      const renewalUrl = "https://example.test/renew/?t=renewal-token";
      await insertBuiltSite(
        "Persistent cutoff",
        "cutoff.test",
        "",
        "",
        false,
        "42",
      );
      const site = (await builtSites.getAll()).find(
        ({ name }) => name === "Persistent cutoff",
      )!;

      expect(await syncReadOnlyFrom(site, cutoff, renewalUrl)).toEqual({
        ok: true,
      });
      expect(_secret.calls.map(({ args }) => [args[1], args[2]])).toEqual([
        ["RENEWAL_URL", renewalUrl],
        ["READ_ONLY_FROM", cutoff],
      ]);
      const stored = (await builtSites.getAll()).find(
        ({ name }) => name === "Persistent cutoff",
      )!;
      expect(stored.readOnlyFrom).toBe(cutoff);
    });

    test("provisions renewal state when assigning a site", async () => {
      using _secret = stub(bunnyCdnApi, "setEdgeScriptSecret", () =>
        Promise.resolve({ ok: true as const }),
      );
      await createTestListing({
        hidden: true,
        monthsPerUnit: 1,
        purchaseOnly: true,
      });
      await insertBuiltSite(
        "Renewable site",
        "renewable.test",
        "",
        "",
        true,
        "43",
      );

      await assignAndNotifyBuiltSites([assignmentEntry(1)]);

      const site = (await builtSites.getAll()).find(
        ({ name }) => name === "Renewable site",
      )!;
      expect(site.assignedAttendeeId).toBe(81);
      expect(site.assignedListingId).toBe(71);
      expect(site.readOnlyFrom).not.toBe("");
      expect(site.renewalToken).not.toBeNull();
      expect(site.renewalTokenIndex).not.toBeNull();
    });

    test("reports a failed renewal push to ntfy", async () => {
      using _env = withEnv({ NTFY_URL: "https://ntfy.test/site-errors" });
      using fetchStub = stubFetch(new Response());
      using _secret = stub(bunnyCdnApi, "setEdgeScriptSecret", () =>
        Promise.resolve({
          error: "provider rejected secret",
          ok: false as const,
        }),
      );
      using _error = stub(console, "error", () => {});

      const result = await rotateRenewalToken(
        testBuiltSite({ hostingId: "42" }),
        "Token rotation failed",
      );

      expect(result.pushOk).toBe(false);
      expect(
        fetchStub.calls.some(
          ({ args }) =>
            (args[1] as RequestInit | undefined)?.body === "CDN_REQUEST",
        ),
      ).toBe(true);
    });
  },
);

describeWithEnv(
  "site assignment email contracts",
  { db: true, env: { CAN_BUILD_SITES: "true" } },
  () => {
    beforeEach(async () => {
      setHostEmailConfigForTest({
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

    afterEach(resetHostEmailConfig);

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
  },
);
