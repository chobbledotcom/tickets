import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { type Stub, stub } from "@std/testing/mock";
import type { BuiltSite } from "#db/built-sites/types.ts";
import {
  builtSites,
  getAssignableBuiltSites,
  insertBuiltSite,
} from "#db/built-sites.ts";
import { type BuildSiteInput, builderApi } from "#shared/builder.ts";
import { bunnyCdnApi } from "#shared/bunny-cdn.ts";
import { addMonthsIso } from "#shared/dates.ts";
import { hostEmail } from "#shared/email.ts";
import { ErrorCode } from "#shared/logger.ts";
import { nowIso } from "#shared/now.ts";
import { pickTierListing } from "#shared/renewal-tier.ts";
import { generateScheduledTaskKey } from "#shared/scheduled-keys.ts";
/* jscpd:ignore-start -- imports */
import {
  assignAndNotifyBuiltSites,
  syncReadOnlyFrom,
  validateSiteAssignmentConfig,
} from "#shared/site-assignment.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { validEmail } from "#test-utils/email.ts";
import { withEnv } from "#test-utils/env.ts";
import { makeTestEntry } from "#test-utils/factories.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";

/* jscpd:ignore-end */

const stubBuildSiteSuccess = (onCall?: (input: BuildSiteInput) => void) => {
  let counter = 0;
  return stub(
    builderApi,
    "buildSite",
    async (input: BuildSiteInput, retain) => {
      counter++;
      onCall?.(input);
      const result = {
        dbProvider: "bunny" as const,
        dbToken: `token-${counter}`,
        dbUrl: `libsql://auto-${counter}.test`,
        defaultHostname: `auto-${counter}.b-cdn.net`,
        hostingId: String(1000 + counter),
        hostingProvider: "bunny" as const,
        ok: true as const,
      };
      await retain({ ...result, scheduledTaskKey: generateScheduledTaskKey() });
      return result;
    },
  );
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
  const { getAllListings } = await import("#db/listings/records.ts");
  const { deactivateTestListing } = await import(
    "#test-utils/db-helpers/listings.ts"
  );
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
    let fetchStub: Stub;
    let secretStub: ReturnType<typeof stubEdgeSecretSuccess>;

    /** Three entries that each need one site — the mixed-order case. One
     *  attendee takes quantity 2 to pin that quantity buys months, not sites. */
    const assignAndCollectThreeSites = async (): Promise<BuiltSite[]> => {
      await assignAndNotifyBuiltSites([
        siteEntry({ attendeeId: 11 }),
        siteEntry({ attendeeId: 12, quantity: 2 }),
        siteEntry({ attendeeId: 13 }),
      ]);
      const sites = await builtSites.getAll();
      const assigned = sites.filter((s) => s.assignedAttendeeId !== null);
      expect(assigned).toHaveLength(3);
      return assigned;
    };

    const expectFlagPushOutcome = async (
      site: string,
      expected: string,
    ): Promise<BuiltSite> => {
      const all = await builtSites.getAll();
      const found = all.find((s) => s.name === site)!;
      expect(found.renewalTokenIndex).not.toBeNull();
      expect(found.readOnlyFrom).toBeTruthy();
      expect(found.readOnlyFrom.slice(0, 10)).toBe(expected);
      return found;
    };

    const expectLastEmailBody = (expected: Record<string, unknown>) => {
      expect(fetchStub.calls.length).toBe(1);
      const body = JSON.parse(fetchStub.calls[0]!.args[1].body) as Record<
        string,
        unknown
      >;
      for (const [key, value] of Object.entries(expected)) {
        expect(body[key]).toBe(value);
      }
      return body;
    };

    const expectSetupEmailBody = async (setupUrl: string) => {
      await assignAndNotifyBuiltSites([siteEntry()]);
      const body = JSON.parse(fetchStub.calls[0]!.args[1].body);
      expect(body.html).toContain(`href="${setupUrl}"`);
      expect(body.text).toContain(setupUrl);
      return body;
    };

    /** Assert the first built site was assigned an attendee but no email fired. */
    const expectAssignedNoEmail = async (): Promise<void> => {
      const sites = await builtSites.getAll();
      expect(sites[0]!.assignedAttendeeId).not.toBeNull();
      expect(fetchStub.calls.length).toBe(0);
    };

    beforeEach(async () => {
      fetchStub = stubFetch(() => new Response());
      secretStub = stubEdgeSecretSuccess();
      hostEmail.setOverride({
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
      hostEmail.resetOverride();
    });

    /** The two live sites every multi-site assignment test starts from. */
    const insertSitesAAndB = async () => {
      await insertBuiltSite("Site A", "a.test.net", "", "", true);
      await insertBuiltSite("Site B", "b.test.net", "", "", true);
    };

    /** Keeps a deliberate error out of the test output, so the caller can
     *  read what was logged without printing it. */
    const silencedErrors = () => stub(console, "error", () => {});

    describe("assignAndNotifyBuiltSites", () => {
      test("assigns one site per booking and sends email", async () => {
        await insertSitesAAndB();

        await assignAndNotifyBuiltSites([siteEntry({ quantity: 2 })]);

        const sites = await builtSites.getAll();
        const assigned = sites.filter((s) => s.assignedAttendeeId !== null);
        expect(assigned).toHaveLength(1);
        expect(assigned.every((s) => !s.assignable)).toBe(true);
        expect(fetchStub.calls.length).toBe(1);
      });

      test("skips listings without assign_built_site", async () => {
        await insertBuiltSite("Site A", "a.test.net", "", "", true);

        await assignAndNotifyBuiltSites([
          siteEntry({ assignBuiltSite: false }),
        ]);

        const sites = await builtSites.getAll();
        expect(sites[0]!.assignable).toBe(true);
        expect(sites[0]!.assignedAttendeeId).toBeNull();
        expect(fetchStub.calls.length).toBe(0);
      });

      test("combines one buyer's plan listings into one site with summed months", async () => {
        await insertBuiltSite("Site A", "a.test.net", "", "", true, "2005");
        await insertBuiltSite("Site B", "b.test.net", "", "", true, "2006");

        await assignAndNotifyBuiltSites([
          siteEntry({
            attendeeId: 10,
            initialSiteMonths: 12,
            listingId: 1,
            listingName: "12 Month Plan",
          }),
          siteEntry({
            attendeeId: 10,
            initialSiteMonths: 3,
            listingId: 2,
            listingName: "3 Month Plan",
          }),
        ]);

        const sites = await builtSites.getAll();
        expect(sites.filter((s) => s.assignedAttendeeId !== null)).toHaveLength(
          1,
        );
        // 12 + 3: the buyer's two plans buy 15 months on their one site.
        const assigned = await expectFlagPushOutcome(
          "Site A",
          addMonthsIso(nowIso(), 15).slice(0, 10),
        );
        expect(assigned.assignedAttendeeId).toBe(10);
        expect(assigned.assignedListingId).toBe(1);
        const body = JSON.parse(fetchStub.calls[0]!.args[1].body);
        expect(body.subject).toBe("Your new site is ready");
        expect(body.html).toContain("12 Month Plan + 3 Month Plan");
        expect(body.html).toContain("https://a.test.net/setup/");
      });

      test("a no-quantity plan line beside a booked one adds no site and no months", async () => {
        await insertBuiltSite("Site A", "a.test.net", "", "", true, "2007");

        await assignAndNotifyBuiltSites([
          siteEntry({
            attendeeId: 10,
            initialSiteMonths: 3,
            listingId: 1,
            quantity: 0,
          }),
          siteEntry({
            attendeeId: 10,
            initialSiteMonths: 3,
            listingId: 2,
            quantity: 2,
          }),
        ]);

        const remaining = await builtSites.getAll();
        expect(
          remaining.filter((s) => s.assignedAttendeeId !== null),
        ).toHaveLength(1);
        // 2 units of the 3-month plan: the 0-quantity line adds nothing.
        await expectFlagPushOutcome(
          "Site A",
          addMonthsIso(nowIso(), 6).slice(0, 10),
        );
      });

      test("does not assign when no sites available and buildSite fails", async () => {
        await insertBuiltSite("Site A", "a.test.net", "", "", false);
        const buildStub = stubBuildSiteFailure();
        try {
          await assignAndNotifyBuiltSites([siteEntry()]);

          const sites = await builtSites.getAll();
          const existing = sites.find((s) => s.name === "Site A")!;
          expect(existing.assignedAttendeeId).toBeNull();
          expect(buildStub.calls.length).toBe(1);
          expect(fetchStub.calls.length).toBe(0);
        } finally {
          buildStub.restore();
        }
      });

      test("each entry still attempts its own build after one build fails", async () => {
        const buildStub = stubBuildSiteFailure();
        try {
          await assignAndNotifyBuiltSites([
            siteEntry({ attendeeId: 11, quantity: 2 }),
            siteEntry({ attendeeId: 12 }),
          ]);

          expect(buildStub.calls.length).toBe(2);
          const sites = await builtSites.getAll();
          const assigned = sites.filter((s) => s.assignedAttendeeId !== null);
          expect(assigned).toHaveLength(0);
          expect(fetchStub.calls.length).toBe(0);
        } finally {
          buildStub.restore();
        }
      });

      test("fails if an auto-build succeeds without retaining its site", async () => {
        const buildStub = stub(builderApi, "buildSite", () =>
          Promise.resolve({
            dbProvider: "bunny" as const,
            dbToken: "token",
            dbUrl: "libsql://auto.test",
            defaultHostname: "auto.b-cdn.net",
            hostingId: "42",
            hostingProvider: "bunny" as const,
            ok: true as const,
          }),
        );
        try {
          await expect(
            assignAndNotifyBuiltSites([siteEntry()]),
          ).rejects.toThrow("Built site was not retained");
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

          const sites = await builtSites.getAll();
          expect(sites).toHaveLength(1);
          expect(sites[0]!.siteUrl).toBe("auto-1.b-cdn.net");
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
          await assignAndCollectThreeSites();

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
          await assignAndNotifyBuiltSites([
            siteEntry({ attendeeId: 11 }),
            siteEntry({ attendeeId: 12 }),
          ]);

          expect(builtNames).toEqual(["00002", "00003"]);
        } finally {
          buildStub.restore();
        }
      });

      test("sends email with plural subject for multiple sites", async () => {
        await insertSitesAAndB();

        // Two buyers in one order, each with their own site.
        await assignAndNotifyBuiltSites([
          siteEntry({
            attendeeId: 10,
            listingId: 1,
            listingName: "Listing 1",
          }),
          siteEntry({
            attendeeId: 11,
            listingId: 2,
            listingName: "Listing 2",
          }),
        ]);

        expect(fetchStub.calls.length).toBe(1);
        const body = JSON.parse(fetchStub.calls[0]!.args[1].body);
        expect(body.subject).toContain("2 new sites");
      });

      test("sends email with singular subject for one site", async () => {
        await insertBuiltSite("Site A", "a.test.net", "", "", true);

        await assignAndNotifyBuiltSites([siteEntry()]);

        expectLastEmailBody({ subject: "Your new site is ready" });
      });

      test("email links to the assigned site's /setup/ page", async () => {
        await insertBuiltSite("Site A", "a.test.net", "", "", true);

        const body = await expectSetupEmailBody("https://a.test.net/setup/");
        expect(body.html).toContain("activate your site");
      });

      test("email setup link keeps the scheme when the site URL already has one", async () => {
        await insertBuiltSite("Site C", "https://c.test.net/", "", "", true);

        await expectSetupEmailBody("https://c.test.net/setup/");
      });

      test("email setup link names a bunny.run site by its stable b-cdn.net address", async () => {
        await insertBuiltSite("Site D", "newbooking.bunny.run", "", "", true);

        await expectSetupEmailBody("https://newbooking.b-cdn.net/setup/");
      });

      test("uses DB email config when available and includes reply-to", async () => {
        // Configure email via DB settings (not host config) so getEmailConfig()
        // returns non-null, covering the left branch of the ?? operator
        const { settings } = await import("#db/settings.ts");
        await settings.update.email.provider("resend");
        await settings.update.email.apiKey("re_db_key");
        await settings.update.email.fromAddress("db@example.com");
        await settings.update.businessEmail("biz@example.com");
        hostEmail.setOverride(null);

        await insertBuiltSite("Site A", "a.test.net", "", "", true);
        await assignAndNotifyBuiltSites([siteEntry()]);

        expectLastEmailBody({ reply_to: "biz@example.com" });
      });

      test("skips email when no email config", async () => {
        hostEmail.setOverride(null);

        await insertBuiltSite("Site A", "a.test.net", "", "", true);
        await assignAndNotifyBuiltSites([siteEntry()]);

        await expectAssignedNoEmail();
      });

      test("assigns the site but skips email when the attendee email is invalid", async () => {
        await insertBuiltSite("Site A", "a.test.net", "", "", true);
        await assignAndNotifyBuiltSites([siteEntry({ email: "not-an-email" })]);

        await expectAssignedNoEmail();
      });
    });

    describe("feature flag", () => {
      test("no-ops when CAN_BUILD_SITES is disabled", async () => {
        using _env = withEnv({ CAN_BUILD_SITES: undefined });
        await insertBuiltSite("Site A", "a.test.net", "", "", true);
        await assignAndNotifyBuiltSites([siteEntry()]);
        const sites = await builtSites.getAll();
        expect(sites[0]!.assignable).toBe(true);
        expect(sites[0]!.assignedAttendeeId).toBeNull();
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

        const expectedCutoff = addMonthsIso(nowIso(), 3).slice(0, 10);
        const assigned = await expectFlagPushOutcome("Site A", expectedCutoff);

        expect(assigned.renewalToken).not.toBeNull();
        expect(assigned.renewalToken!.length).toBeGreaterThanOrEqual(32);

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
        using _env = withEnv({ NTFY_URL: "https://ntfy.test/topic" });
        const errorSpy = silencedErrors();

        try {
          await assignAndNotifyBuiltSites([
            siteEntry({ initialSiteMonths: 0 }),
          ]);
        } finally {
          errorSpy.restore();
        }

        const sites = await builtSites.getAll();
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
            (c) =>
              (c.args[1] as RequestInit | undefined)?.body ===
              ErrorCode.DATA_INVALID,
          ),
        ).toBe(true);
      });

      test("skips assignment and logs CONFIG_MISSING when no qualifying tier listings exist", async () => {
        await deactivateAllTierListings();

        const buildStub = stubBuildSiteSuccess();
        using _env = withEnv({ NTFY_URL: "https://ntfy.test/topic" });
        const errorSpy = silencedErrors();
        try {
          await assignAndNotifyBuiltSites([siteEntry()]);

          const sites = await builtSites.getAll();
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
              (c) =>
                (c.args[1] as RequestInit | undefined)?.body ===
                ErrorCode.CONFIG_MISSING,
            ),
          ).toBe(true);
        } finally {
          errorSpy.restore();
          buildStub.restore();
        }
      });

      test("picks the cheapest qualifying tier listing", async () => {
        const cheap = await createTierListing(300);
        await createTierListing(900);

        const result = await pickTierListing();
        expect(result).not.toBeNull();
        expect(result!.id).toBe(cheap.id);
      });

      test("with two qualifying tier listings, assignment still succeeds (tier is picked at renew time)", async () => {
        await createTierListing(300);
        await createTierListing(900);

        await insertBuiltSite("Site A", "a.test.net", "", "", true, "2002");

        await assignAndNotifyBuiltSites([siteEntry()]);

        await expectFlagPushOutcome(
          "Site A",
          addMonthsIso(nowIso(), 3).slice(0, 10),
        );
      });

      test("with quantity=3, one site is assigned with months = initial x quantity", async () => {
        await createTierListing();

        await insertBuiltSite("Site A", "a.test.net", "", "", true, "2003");

        await assignAndNotifyBuiltSites([
          siteEntry({ initialSiteMonths: 3, quantity: 3 }),
        ]);

        const all = await builtSites.getAll();
        const assigned = all.filter((s) => s.assignedAttendeeId !== null);
        expect(assigned).toHaveLength(1);
        await expectFlagPushOutcome(
          "Site A",
          addMonthsIso(nowIso(), 9).slice(0, 10),
        );
        // One site means the singular "Your new site is ready" email.
        expectLastEmailBody({ subject: "Your new site is ready" });
        expect(
          secretStub.calls.filter((c) => c.args[1] === "READ_ONLY_FROM"),
        ).toHaveLength(1);
      });

      test("a no-quantity line books no site and sends no email", async () => {
        await insertBuiltSite("Site A", "a.test.net", "", "", true);

        await assignAndNotifyBuiltSites([siteEntry({ quantity: 0 })]);

        const sites = await builtSites.getAll();
        expect(sites[0]!.assignedAttendeeId).toBeNull();
        expect(fetchStub.calls.length).toBe(0);
      });

      test("Bunny push failure on one site of three leaves that site's readOnlyFrom empty, others persist", async () => {
        await createTierListing();

        await insertBuiltSite("Site A", "a.test.net", "", "", true, "1001");
        await insertBuiltSite("Site B", "b.test.net", "", "", true, "1002");

        const assignableSites = await getAssignableBuiltSites();
        const failScriptId = Number(assignableSites[0]!.hostingId);

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
          await assignAndNotifyBuiltSites([
            siteEntry({ attendeeId: 11 }),
            siteEntry({ attendeeId: 12 }),
            siteEntry({ attendeeId: 13 }),
          ]);

          const allSites = await builtSites.getAll();
          const assigned = allSites.filter(
            (s) => s.assignedAttendeeId !== null,
          );
          expect(assigned).toHaveLength(3);

          const failedSite = assigned.find(
            (s) => Number(s.hostingId) === failScriptId,
          );
          const succeededSites = assigned.filter(
            (s) => Number(s.hostingId) !== failScriptId,
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

          const sites = await builtSites.getAll();
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
