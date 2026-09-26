import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { type Stub, stub } from "@std/testing/mock";
import { builtSites, insertBuiltSite } from "#db/built-sites.ts";
import { bunnyCdnApi } from "#shared/bunny-cdn.ts";
import { addMonthsIso } from "#shared/dates.ts";
import { nowIso } from "#shared/now.ts";
import {
  syncReadOnlyFrom,
  validateSiteAssignmentConfig,
} from "#shared/site-assignment.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { withEnv } from "#test-utils/env.ts";
import {
  deactivateAllTierListings,
  siteEntry,
} from "./site-assignment-shared.ts";

const stubEdgeSecretSuccess = (): Stub =>
  stub(bunnyCdnApi, "setEdgeScriptSecret", () =>
    Promise.resolve({ ok: true as const }),
  );

describeWithEnv(
  "site assignment configuration",
  {
    db: true,
    env: { CAN_BUILD_SITES: "true" },
  },
  () => {
    let secretStub: Stub;

    beforeEach(async () => {
      secretStub = stubEdgeSecretSuccess();
      // The hidden monthly tier the assignment's validation gate requires.
      await createTestListing({
        hidden: true,
        monthsPerUnit: 1,
        purchaseOnly: true,
        unitPrice: 300,
      });
    });

    afterEach(() => {
      if (!secretStub.restored) secretStub.restore();
    });

    describe("syncReadOnlyFrom", () => {
      test("pushes RENEWAL_URL alongside READ_ONLY_FROM when given a renewalUrl", async () => {
        await insertBuiltSite(
          "Sync A",
          "sync-a.test.net",
          "",
          "",
          false,
          "5001",
        );
        const site = (await builtSites.getAll()).find(
          (s) => s.name === "Sync A",
        )!;

        await syncReadOnlyFrom(
          site,
          addMonthsIso(nowIso(), 3),
          "https://example.test/renew/?t=abc",
        );

        const keys = secretStub.calls.map((c) => c.args[1]);
        expect(keys).toContain("RENEWAL_URL");
        expect(keys).toContain("READ_ONLY_FROM");
      });

      test("pushes only READ_ONLY_FROM when no renewalUrl is given", async () => {
        await insertBuiltSite(
          "Sync B",
          "sync-b.test.net",
          "",
          "",
          false,
          "5002",
        );
        const site = (await builtSites.getAll()).find(
          (s) => s.name === "Sync B",
        )!;

        await syncReadOnlyFrom(site, addMonthsIso(nowIso(), 3));

        const keys = secretStub.calls.map((c) => c.args[1]);
        expect(keys).not.toContain("RENEWAL_URL");
        expect(keys).toContain("READ_ONLY_FROM");
      });
    });

    describe("validateSiteAssignmentConfig", () => {
      test("passes when no selected listing needs a site", async () => {
        const result = await validateSiteAssignmentConfig([
          siteEntry({ assignBuiltSite: false }),
        ]);
        expect(result.ok).toBe(true);
      });

      test("rejects missing renewal tier before checkout", async () => {
        await deactivateAllTierListings();

        const result = await validateSiteAssignmentConfig([siteEntry()]);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toBe("missing_tier");
      });

      test("rejects invalid initial site months before checkout", async () => {
        const result = await validateSiteAssignmentConfig([
          siteEntry({ initialSiteMonths: 0 }),
        ]);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toBe("initial_months");
      });
    });
  },
);

describe("validateSiteAssignmentConfig without builder", () => {
  test("rejects when CAN_BUILD_SITES is disabled", async () => {
    using _env = withEnv({ CAN_BUILD_SITES: undefined });
    const result = await validateSiteAssignmentConfig([siteEntry()]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("builder_disabled");
  });
});
