import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { FakeTime } from "@std/testing/time";
import { hmacHash } from "#crypto/hashing.ts";
import { builtSites, insertBuiltSite } from "#db/built-sites.ts";
import { bunnyCdnApi } from "#shared/bunny-cdn.ts";
import { ErrorCode } from "#shared/logger.ts";
import {
  isQualifyingTierListing,
  pickTierListing,
} from "#shared/renewal-tier.ts";
import {
  assignAndNotifyBuiltSites,
  parseReadOnlyFromMs,
  renewalDeadlineBaseMs,
  rotateRenewalToken,
  syncReadOnlyFrom,
  validateSiteAssignmentConfig,
} from "#shared/site-assignment.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { withEnv } from "#test-utils/env.ts";
import {
  makeTestAttendee,
  makeTestEntry,
  testBuiltSite,
} from "#test-utils/factories.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";
import { assignmentEntry } from "./contracts-setup.ts";

const configMessage =
  "Site assignment is not configured. Please contact the administrator.";

const buyerBlank = (attendeeId = 81) =>
  makeTestAttendee({
    email: "buyer@example.com",
    id: attendeeId,
    name: "Buyer",
    quantity: 1,
  });

const configEntry = (initialSiteMonths = 3) => ({
  listing: {
    assign_built_site: true,
    id: 71,
    initial_site_months: initialSiteMonths,
    name: "Hosted listing",
  },
});

const tierFields = (
  overrides: Partial<Parameters<typeof isQualifyingTierListing>[0]> = {},
) => ({
  active: true,
  assign_built_site: false,
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
    { attendee: buyerBlank(), listing: makeTestEntry(entry.listing).listing },
  ]);

  expect(fetchStub.calls.map(({ args }) => args[1].body)).toEqual([
    notification,
  ]);
};

describe("site assignment configuration contracts", () => {
  test("requires every renewal-tier condition", () => {
    expect([
      isQualifyingTierListing(tierFields()),
      isQualifyingTierListing(tierFields({ assign_built_site: true })),
      isQualifyingTierListing(tierFields({ purchase_only: false })),
      isQualifyingTierListing(tierFields({ hidden: false })),
      isQualifyingTierListing(tierFields({ months_per_unit: 0 })),
      isQualifyingTierListing(tierFields({ active: false })),
    ]).toEqual([true, false, false, false, false, false]);
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
      await expectBlockedNotification(configEntry(0), ErrorCode.DATA_INVALID);
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
      await expectBlockedNotification(configEntry(), ErrorCode.CONFIG_MISSING);
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
      using _time = new FakeTime("2030-01-15T12:00:00.000Z");

      await assignAndNotifyBuiltSites([assignmentEntry()]);

      const site = (await builtSites.getAll()).find(
        ({ name }) => name === "Renewable site",
      )!;
      expect(site).toMatchObject({
        assignedAttendeeId: 81,
        assignedListingId: 71,
        readOnlyFrom: "2030-04-15T12:00:00.000Z",
      });
      const token = site.renewalToken;
      if (token === null) throw new Error("renewal token was not saved");
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(site.renewalTokenIndex).toBe(await hmacHash(token));
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
      expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(fetchStub.calls.map(({ args }) => args[1].body)).toEqual([
        "CDN_REQUEST",
      ]);
    });
  },
);
