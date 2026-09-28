import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { ErrorCode } from "#shared/logger.ts";
import {
  isQualifyingTierListing,
  pickTierListing,
} from "#shared/renewal-tier.ts";
import {
  assignAndNotifyBuiltSites,
  validateSiteAssignmentConfig,
} from "#shared/site-assignment.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { withEnv } from "#test-utils/env.ts";
import { makeTestAttendee, makeTestEntry } from "#test-utils/factories.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";

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
