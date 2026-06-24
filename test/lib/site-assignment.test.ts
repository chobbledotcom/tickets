import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { type BuildSiteInput, builderApi } from "#shared/builder.ts";
import { bunnyCdnApi } from "#shared/bunny-cdn.ts";
import { addMonthsIso } from "#shared/dates.ts";
import {
  getAllBuiltSites,
  getAssignableBuiltSites,
  insertBuiltSite,
} from "#shared/db/built-sites.ts";
import {
  resetHostEmailConfig,
  setHostEmailConfigForTest,
} from "#shared/email.ts";
import { ErrorCode } from "#shared/logger.ts";
import { nowIso } from "#shared/now.ts";
import {
  assignAndNotifyBuiltSites,
  parseReadOnlyFromMs,
  pickTierListing,
  syncReadOnlyFrom,
  validateSiteAssignmentConfig,
} from "#shared/site-assignment.ts";
import {
  createTestListing,
  describeWithEnv,
  makeTestEntry,
  setTestEnv,
  validEmail,
} from "#test-utils";

const stubBuildSiteSuccess = (onCall?: (input: BuildSiteInput) => void) => {
  let counter = 0;
  return stub(builderApi, "buildSite", (input: BuildSiteInput) => {
    counter++;
    onCall?.(input);
    return Promise.resolve({
      dbToken: `token-${counter}`,
      dbUrl: `libsql://auto-${counter}.test`,
      defaultHostname: `auto-${counter}.b-cdn.net`,
      ok: true as const,
      scriptId: 1000 + counter,
    });
  });
};

const stubBuildSiteFailure = () =>
  stub(builderApi, "buildSite", () =>
    Promise.resolve({ error: "build failed", ok: false as const }),
  );

const stubEdgeSecretSuccess = () =>
  stub(bunnyCdnApi, "setEdgeScriptSecret", () =>
    Promise.resolve({ ok: true as const }),
  );

/** Deactivate every active, hidden, purchase-only, monthly listing — the
 *  "renewal tier" set — so tests can exercise the no-qualifying-tier path.
 *  Both the "skips assignment" and "rejects missing renewal tier" tests
 *  need this exact teardown. */
const deactivateAllTierListings = async (): Promise<void> => {
  const { getAllListings } = await import("#shared/db/listings.ts");
  const { deactivateTestListing } = await import("#test-utils");
  const listings = await getAllListings();
  for (const ev of listings) {
    if (ev.months_per_unit > 0 && ev.purchase_only && ev.hidden && ev.active) {
      await deactivateTestListing(ev.id);
    }
  }
};

/** Build an entry with assign_built_site for testing */
const siteEntry = (
  overrides: {
    listingId?: number;
    listingName?: string;
    assignBuiltSite?: boolean;
    initialSiteMonths?: number;
    attendeeId?: number;
    quantity?: number;
    email?: string;
  } = {},
) =>
  makeTestEntry(
    {
      assign_built_site: overrides.assignBuiltSite ?? true,
      initial_site_months: overrides.initialSiteMonths ?? 3,
      ...(overrides.listingId !== undefined && { id: overrides.listingId }),
      ...(overrides.listingName !== undefined && {
        name: overrides.listingName,
      }),
    },
    {
      ...(overrides.attendeeId !== undefined && { id: overrides.attendeeId }),
      ...(overrides.email !== undefined && { email: overrides.email }),
      ...(overrides.quantity !== undefined && {
        quantity: overrides.quantity,
      }),
    },
  );

describeWithEnv(
  "site-assignment",
  {
    db: true,
    env: { CAN_BUILD_SITES: "true" },
  },
  () => {
    // deno-lint-ignore no-explicit-any
    let fetchStub: any;
    let secretStub: ReturnType<typeof stubEdgeSecretSuccess>;

    beforeEach(async () => {
      fetchStub = stub(globalThis, "fetch", () =>
        Promise.resolve(new Response()),
      );
      secretStub = stubEdgeSecretSuccess();
      setHostEmailConfigForTest({
        apiKey: "re_test",
        fromAddress: validEmail("test@example.com"),
        provider: "resend",
      });
      await createTestListing({
        hidden: true,
        maxAttendees: 1000,
        monthsPerUnit: 1,
        purchaseOnly: true,
        unitPrice: 500,
      });
    });

    afterEach(() => {
      fetchStub.restore();
      if (!secretStub.restored) secretStub.restore();
      resetHostEmailConfig();
    });

    describe("assignAndNotifyBuiltSites", () => {
      test("assigns one site per ticket and sends email", async () => {
        await insertBuiltSite("Site A", "a.test.net", "", "", true);
        await insertBuiltSite("Site B", "b.test.net", "", "", true);

        await assignAndNotifyBuiltSites([siteEntry({ quantity: 2 })]);

        const sites = await getAllBuiltSites();
        const assigned = sites.filter((s) => s.assignedAttendeeId !== null);
        expect(assigned).toHaveLength(2);
        expect(assigned.every((s) => !s.assignable)).toBe(true);
        expect(fetchStub.calls.length).toBe(1);
      });

      test("skips listings without assign_built_site", async () => {
        await insertBuiltSite("Site A", "a.test.net", "", "", true);

        await assignAndNotifyBuiltSites([
          siteEntry({ assignBuiltSite: false }),
        ]);

        const sites = await getAllBuiltSites();
        expect(sites[0]!.assignable).toBe(true);
        expect(sites[0]!.assignedAttendeeId).toBeNull();
        expect(fetchStub.calls.length).toBe(0);
      });

      test("assigns sites independently per listing", async () => {
        await insertBuiltSite("Site A", "a.test.net", "", "", true);
        await insertBuiltSite("Site B", "b.test.net", "", "", true);

        await assignAndNotifyBuiltSites([
          siteEntry({ attendeeId: 10, listingId: 1, listingName: "Listing 1" }),
          siteEntry({ attendeeId: 10, listingId: 2, listingName: "Listing 2" }),
        ]);

        const sites = await getAllBuiltSites();
        const assigned = sites.filter((s) => s.assignedAttendeeId !== null);
        expect(assigned).toHaveLength(2);
        expect(assigned[0]!.assignedListingId).toBe(1);
        expect(assigned[1]!.assignedListingId).toBe(2);
      });

      test("does not assign when no sites available and buildSite fails", async () => {
        await insertBuiltSite("Site A", "a.test.net", "", "", false);
        const buildStub = stubBuildSiteFailure();
        try {
          await assignAndNotifyBuiltSites([siteEntry()]);

          const sites = await getAllBuiltSites();
          const existing = sites.find((s) => s.name === "Site A")!;
          expect(existing.assignedAttendeeId).toBeNull();
          expect(buildStub.calls.length).toBe(1);
          expect(fetchStub.calls.length).toBe(0);
        } finally {
          buildStub.restore();
        }
      });

      test("no-ops for empty entries", async () => {
        await assignAndNotifyBuiltSites([]);
        expect(fetchStub.calls.length).toBe(0);
      });

      test("auto-builds when no assignable sites are available", async () => {
        const buildStub = stubBuildSiteSuccess();
        try {
          await assignAndNotifyBuiltSites([siteEntry()]);

          const sites = await getAllBuiltSites();
          expect(sites).toHaveLength(1);
          expect(sites[0]!.bunnyUrl).toBe("auto-1.b-cdn.net");
          expect(sites[0]!.assignedAttendeeId).not.toBeNull();
          expect(buildStub.calls.length).toBe(1);
          expect(fetchStub.calls.length).toBe(1);
        } finally {
          buildStub.restore();
        }
      });

      test("auto-builds remaining sites when fewer assignable than needed", async () => {
        await insertBuiltSite("Site A", "a.test.net", "", "", true);
        const builtNames: string[] = [];
        const buildStub = stubBuildSiteSuccess((input) => {
          builtNames.push(input.siteName);
        });
        try {
          await assignAndNotifyBuiltSites([siteEntry({ quantity: 3 })]);

          const sites = await getAllBuiltSites();
          const assigned = sites.filter((s) => s.assignedAttendeeId !== null);
          expect(assigned).toHaveLength(3);
          expect(buildStub.calls.length).toBe(2);
          expect(fetchStub.calls.length).toBe(1);
        } finally {
          buildStub.restore();
        }
      });

      test("uses sequential zero-padded names for auto-built sites", async () => {
        await insertBuiltSite("Manual", "manual.b-cdn.net", "", "", false);
        const builtNames: string[] = [];
        const buildStub = stubBuildSiteSuccess((input) => {
          builtNames.push(input.siteName);
        });
        try {
          await assignAndNotifyBuiltSites([siteEntry({ quantity: 2 })]);

          expect(builtNames).toEqual(["00002", "00003"]);
        } finally {
          buildStub.restore();
        }
      });

      test("sends email with plural subject for multiple sites", async () => {
        await insertBuiltSite("Site A", "a.test.net", "", "", true);
        await insertBuiltSite("Site B", "b.test.net", "", "", true);

        await assignAndNotifyBuiltSites([
          siteEntry({ listingId: 1, listingName: "Listing 1" }),
          siteEntry({ listingId: 2, listingName: "Listing 2" }),
        ]);

        expect(fetchStub.calls.length).toBe(1);
        const body = JSON.parse(fetchStub.calls[0].args[1].body);
        expect(body.subject).toContain("2 new sites");
      });

      test("sends email with singular subject for one site", async () => {
        await insertBuiltSite("Site A", "a.test.net", "", "", true);

        await assignAndNotifyBuiltSites([siteEntry()]);

        expect(fetchStub.calls.length).toBe(1);
        const body = JSON.parse(fetchStub.calls[0].args[1].body);
        expect(body.subject).toBe("Your new site is ready");
      });

      test("email links to the assigned site's /setup/ page", async () => {
        await insertBuiltSite("Site A", "a.test.net", "", "", true);

        await assignAndNotifyBuiltSites([siteEntry()]);

        const body = JSON.parse(fetchStub.calls[0].args[1].body);
        expect(body.html).toContain('href="https://a.test.net/setup/"');
        expect(body.html).toContain("activate your site");
        expect(body.text).toContain("https://a.test.net/setup/");
      });

      test("email setup link keeps the scheme when the site URL already has one", async () => {
        await insertBuiltSite("Site C", "https://c.test.net/", "", "", true);

        await assignAndNotifyBuiltSites([siteEntry()]);

        const body = JSON.parse(fetchStub.calls[0].args[1].body);
        expect(body.html).toContain('href="https://c.test.net/setup/"');
        expect(body.text).toContain("https://c.test.net/setup/");
      });

      test("uses DB email config when available and includes reply-to", async () => {
        // Configure email via DB settings (not host config) so getEmailConfig()
        // returns non-null, covering the left branch of the ?? operator
        const { settings } = await import("#shared/db/settings.ts");
        await settings.update.email.provider("resend");
        await settings.update.email.apiKey("re_db_key");
        await settings.update.email.fromAddress("db@example.com");
        await settings.update.businessEmail("biz@example.com");
        resetHostEmailConfig();
        setHostEmailConfigForTest(null);

        await insertBuiltSite("Site A", "a.test.net", "", "", true);
        await assignAndNotifyBuiltSites([siteEntry()]);

        expect(fetchStub.calls.length).toBe(1);
        const body = JSON.parse(fetchStub.calls[0].args[1].body);
        expect(body.reply_to).toBe("biz@example.com");
      });

      test("skips email when no email config", async () => {
        resetHostEmailConfig();
        setHostEmailConfigForTest(null);

        await insertBuiltSite("Site A", "a.test.net", "", "", true);
        await assignAndNotifyBuiltSites([siteEntry()]);

        const sites = await getAllBuiltSites();
        expect(sites[0]!.assignedAttendeeId).not.toBeNull();
        expect(fetchStub.calls.length).toBe(0);
      });

      test("assigns the site but skips email when the attendee email is invalid", async () => {
        await insertBuiltSite("Site A", "a.test.net", "", "", true);
        await assignAndNotifyBuiltSites([siteEntry({ email: "not-an-email" })]);

        const sites = await getAllBuiltSites();
        expect(sites[0]!.assignedAttendeeId).not.toBeNull();
        expect(fetchStub.calls.length).toBe(0);
      });
    });

    describe("feature flag", () => {
      test("no-ops when CAN_BUILD_SITES is disabled", async () => {
        const restore = setTestEnv({ CAN_BUILD_SITES: undefined });
        try {
          await insertBuiltSite("Site A", "a.test.net", "", "", true);
          await assignAndNotifyBuiltSites([siteEntry()]);
          const sites = await getAllBuiltSites();
          expect(sites[0]!.assignable).toBe(true);
          expect(sites[0]!.assignedAttendeeId).toBeNull();
        } finally {
          restore();
        }
      });
    });

    describe("renewal at site assignment", () => {
      const createTierListing = (unitPrice = 500, monthsPerUnit = 1) =>
        createTestListing({
          hidden: true,
          maxAttendees: 1000,
          monthsPerUnit,
          purchaseOnly: true,
          unitPrice,
        });

      test("generates renewal token and pushes READ_ONLY_FROM + RENEWAL_URL on assignment", async () => {
        await createTierListing();
        await insertBuiltSite("Site A", "a.test.net", "", "", true, "2001");

        await assignAndNotifyBuiltSites([siteEntry({ initialSiteMonths: 3 })]);

        const sites = await getAllBuiltSites();
        const assigned = sites.find((s) => s.name === "Site A")!;
        expect(assigned.renewalTokenIndex).not.toBeNull();
        expect(assigned.readOnlyFrom).toBeTruthy();

        expect(assigned.renewalToken).not.toBeNull();
        expect(assigned.renewalToken!.length).toBeGreaterThanOrEqual(32);

        const expectedCutoff = addMonthsIso(nowIso(), 3).slice(0, 10);
        expect(assigned.readOnlyFrom.slice(0, 10)).toBe(expectedCutoff);

        const secretCalls = secretStub.calls.map((c) => c.args);
        const secretNames = secretCalls.map((c) => c[1]);
        expect(secretNames.indexOf("RENEWAL_URL")).toBeLessThan(
          secretNames.indexOf("READ_ONLY_FROM"),
        );
        const readOnlyFromCall = secretCalls.find(
          (c) => c[1] === "READ_ONLY_FROM",
        );
        expect(readOnlyFromCall).toBeDefined();
        expect(readOnlyFromCall![2].slice(0, 10)).toBe(expectedCutoff);

        const renewalUrlCall = secretCalls.find((c) => c[1] === "RENEWAL_URL");
        expect(renewalUrlCall).toBeDefined();
        expect(renewalUrlCall![2]).toContain("/renew/?t=");
      });

      test("skips assignment and logs DATA_INVALID when initial_site_months is 0", async () => {
        await insertBuiltSite("Site A", "a.test.net", "", "", true);
        const restoreEnv = setTestEnv({ NTFY_URL: "https://ntfy.test/topic" });
        const errorSpy = stub(console, "error", () => {});

        try {
          await assignAndNotifyBuiltSites([
            siteEntry({ initialSiteMonths: 0 }),
          ]);
        } finally {
          errorSpy.restore();
          restoreEnv();
        }

        const sites = await getAllBuiltSites();
        const site = sites.find((s) => s.name === "Site A")!;
        expect(site.assignedAttendeeId).toBeNull();
        expect(site.renewalTokenIndex).toBeNull();
        expect(secretStub.calls.length).toBe(0);
        // The blocked reason "initial_months" maps to DATA_INVALID, not the
        // CONFIG_MISSING fallback — assert both the logged code and the ntfy ping.
        expect(
          errorSpy.calls.some((c) =>
            String(c.args[0]).includes(ErrorCode.DATA_INVALID),
          ),
        ).toBe(true);
        expect(
          fetchStub.calls.some(
            (c: { args: [string, RequestInit] }) =>
              c.args[1]?.body === "DATA_INVALID",
          ),
        ).toBe(true);
      });

      test("skips assignment and logs CONFIG_MISSING when no qualifying tier listings exist", async () => {
        await deactivateAllTierListings();

        const buildStub = stubBuildSiteSuccess();
        const restoreEnv = setTestEnv({ NTFY_URL: "https://ntfy.test/topic" });
        const errorSpy = stub(console, "error", () => {});
        try {
          await assignAndNotifyBuiltSites([siteEntry()]);

          const sites = await getAllBuiltSites();
          const assigned = sites.filter((s) => s.assignedAttendeeId !== null);
          expect(assigned).toHaveLength(0);
          expect(secretStub.calls.length).toBe(0);
          // A missing renewal tier maps to CONFIG_MISSING (the fallback branch).
          expect(
            errorSpy.calls.some((c) =>
              String(c.args[0]).includes(ErrorCode.CONFIG_MISSING),
            ),
          ).toBe(true);
          expect(
            fetchStub.calls.some(
              (c: { args: [string, RequestInit] }) =>
                c.args[1]?.body === "CONFIG_MISSING",
            ),
          ).toBe(true);
        } finally {
          errorSpy.restore();
          restoreEnv();
          buildStub.restore();
        }
      });

      test("picks the cheapest qualifying tier listing", async () => {
        const cheap = await createTierListing(300);
        const _expensive = await createTierListing(900);

        const result = await pickTierListing();
        expect(result).not.toBeNull();
        expect(result!.id).toBe(cheap.id);
      });

      test("with two qualifying tier listings, assignment still succeeds (tier is picked at renew time)", async () => {
        await createTierListing(300);
        await createTierListing(900);

        await insertBuiltSite("Site A", "a.test.net", "", "", true, "2002");

        await assignAndNotifyBuiltSites([siteEntry()]);

        const sites = await getAllBuiltSites();
        const assigned = sites.find((s) => s.name === "Site A")!;
        expect(assigned.renewalTokenIndex).not.toBeNull();
        expect(assigned.readOnlyFrom).toBeTruthy();
      });

      test("with quantity=3, three independent tokens and secret pushes are created", async () => {
        await createTierListing();

        await insertBuiltSite("Site A", "a.test.net", "", "", true, "2003");
        await insertBuiltSite("Site B", "b.test.net", "", "", true, "2004");

        const buildStub = stubBuildSiteSuccess();
        try {
          await assignAndNotifyBuiltSites([siteEntry({ quantity: 3 })]);

          const sites = await getAllBuiltSites();
          const assigned = sites.filter((s) => s.assignedAttendeeId !== null);
          expect(assigned).toHaveLength(3);

          const tokens = assigned.map((s) => s.renewalToken);
          const nonNullTokens = tokens.filter((t): t is string => t !== null);
          expect(nonNullTokens).toHaveLength(3);

          const uniqueTokens = new Set(nonNullTokens);
          expect(uniqueTokens.size).toBe(3);

          const rofCalls = secretStub.calls.filter(
            (c) => c.args[1] === "READ_ONLY_FROM",
          );
          expect(rofCalls).toHaveLength(3);
          const renewalUrlCalls = secretStub.calls.filter(
            (c) => c.args[1] === "RENEWAL_URL",
          );
          expect(renewalUrlCalls).toHaveLength(3);
        } finally {
          buildStub.restore();
        }
      });

      test("Bunny push failure on one site of three leaves that site's readOnlyFrom empty, others persist", async () => {
        await createTierListing();

        await insertBuiltSite("Site A", "a.test.net", "", "", true, "1001");
        await insertBuiltSite("Site B", "b.test.net", "", "", true, "1002");

        const assignableSites = await getAssignableBuiltSites();
        const failScriptId = Number(assignableSites[0]!.bunnyScriptId);

        secretStub.restore();
        const failStub = stub(
          bunnyCdnApi,
          "setEdgeScriptSecret",
          (scriptId: number, name: string, _value: string) => {
            if (name === "READ_ONLY_FROM" && scriptId === failScriptId) {
              return Promise.resolve({
                error: "push failed",
                ok: false as const,
              });
            }
            return Promise.resolve({ ok: true as const });
          },
        );
        const buildStub = stubBuildSiteSuccess();
        try {
          await assignAndNotifyBuiltSites([siteEntry({ quantity: 3 })]);

          const allSites = await getAllBuiltSites();
          const assigned = allSites.filter(
            (s) => s.assignedAttendeeId !== null,
          );
          expect(assigned).toHaveLength(3);

          const failedSite = assigned.find(
            (s) => Number(s.bunnyScriptId) === failScriptId,
          );
          const succeededSites = assigned.filter(
            (s) => Number(s.bunnyScriptId) !== failScriptId,
          );

          expect(failedSite!.readOnlyFrom).toBe("");
          expect(failedSite!.renewalTokenIndex).toBeNull();

          for (const site of succeededSites) {
            expect(site.readOnlyFrom).not.toBe("");
          }
        } finally {
          failStub.restore();
          buildStub.restore();
        }
      });

      test("RENEWAL_URL push failure leaves renewal state unprovisioned", async () => {
        await createTierListing();

        await insertBuiltSite("Site A", "a.test.net", "", "", true, "2001");

        secretStub.restore();
        const failStub = stub(
          bunnyCdnApi,
          "setEdgeScriptSecret",
          (_scriptId: number, name: string, _value: string) => {
            if (name === "RENEWAL_URL") {
              return Promise.resolve({
                error: "renewal url push failed",
                ok: false as const,
              });
            }
            return Promise.resolve({ ok: true as const });
          },
        );
        try {
          await assignAndNotifyBuiltSites([siteEntry()]);

          const sites = await getAllBuiltSites();
          const assigned = sites.find((s) => s.name === "Site A")!;
          expect(assigned.assignedAttendeeId).not.toBeNull();
          expect(assigned.renewalTokenIndex).toBeNull();
          expect(assigned.readOnlyFrom).toBe("");
          const readOnlyCalls = failStub.calls.filter(
            (c) => c.args[1] === "READ_ONLY_FROM",
          );
          expect(readOnlyCalls).toHaveLength(0);
        } finally {
          failStub.restore();
        }
      });
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
        const site = (await getAllBuiltSites()).find(
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
        const site = (await getAllBuiltSites()).find(
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
    const restore = setTestEnv({ CAN_BUILD_SITES: undefined });
    try {
      const result = await validateSiteAssignmentConfig([siteEntry()]);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("builder_disabled");
    } finally {
      restore();
    }
  });
});

describe("parseReadOnlyFromMs", () => {
  test("returns null for invalid date string", () => {
    expect(parseReadOnlyFromMs({ readOnlyFrom: "not-a-date" })).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(parseReadOnlyFromMs({ readOnlyFrom: "" })).toBeNull();
  });

  test("returns ms for valid date", () => {
    const ms = parseReadOnlyFromMs({ readOnlyFrom: "2026-06-01T00:00:00Z" });
    expect(ms).not.toBeNull();
    expect(ms).toBeGreaterThan(0);
  });
});
