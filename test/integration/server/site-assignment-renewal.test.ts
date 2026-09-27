import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { type Stub, stub } from "@std/testing/mock";
import {
  builtSites,
  getAssignableBuiltSites,
  insertBuiltSite,
} from "#db/built-sites.ts";
import { bunnyCdnApi } from "#shared/bunny-cdn.ts";
import { addMonthsIso } from "#shared/dates.ts";
import { ErrorCode } from "#shared/logger.ts";
import { nowIso } from "#shared/now.ts";
import { pickTierListing } from "#shared/renewal-tier.ts";
import { assignAndNotifyBuiltSites } from "#shared/site-assignment.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { withEnv } from "#test-utils/env.ts";
import {
  deactivateAllTierListings,
  forbidBuildDuringAssignment,
  setUpAssignmentSuite,
  silencedErrors,
  siteEntry,
  stubEdgeSecretSuccess,
} from "./site-assignment-shared.ts";

/** Stub the edge-secret push so the RENEWAL_URL leg fails and the rest pass. */
const failingRenewalUrlPush = (): Stub =>
  stub(
    bunnyCdnApi,
    "setEdgeScriptSecret",
    (_scriptId: number, name: string, _value: string) =>
      name === "RENEWAL_URL"
        ? Promise.resolve({
            error: "renewal url push failed",
            ok: false as const,
          })
        : Promise.resolve({ ok: true as const }),
  );

describeWithEnv(
  "site-assignment renewal",
  {
    db: true,
    env: { CAN_BUILD_SITES: "true" },
  },
  () => {
    const suite = setUpAssignmentSuite();

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
        const assigned = await suite.expectFlagPushOutcome(
          "Site A",
          expectedCutoff,
        );

        expect(assigned.renewalToken).not.toBeNull();
        expect(assigned.renewalToken!.length).toBeGreaterThanOrEqual(32);

        const secretCalls = suite.secretStub.calls.map((c) => c.args);
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
        expect(suite.secretStub.calls.length).toBe(0);
        // The blocked reason "initial_months" maps to DATA_INVALID, not the
        // CONFIG_MISSING fallback — assert both the logged code and the ntfy ping.
        expect(
          errorSpy.calls.some((c) =>
            String(c.args[0]).includes(ErrorCode.DATA_INVALID),
          ),
        ).toBe(true);
        expect(
          suite.fetchStub.calls.some(
            (c) =>
              (c.args[1] as RequestInit | undefined)?.body ===
              ErrorCode.DATA_INVALID,
          ),
        ).toBe(true);
      });

      test("skips assignment and logs CONFIG_MISSING when no qualifying tier listings exist", async () => {
        await deactivateAllTierListings();

        using _build = forbidBuildDuringAssignment();
        using _env = withEnv({ NTFY_URL: "https://ntfy.test/topic" });
        const errorSpy = silencedErrors();
        try {
          await assignAndNotifyBuiltSites([siteEntry()]);

          const sites = await builtSites.getAll();
          const assigned = sites.filter((s) => s.assignedAttendeeId !== null);
          expect(assigned).toHaveLength(0);
          expect(suite.secretStub.calls.length).toBe(0);
          // A missing renewal tier maps to CONFIG_MISSING (the fallback branch).
          expect(
            errorSpy.calls.some((c) =>
              String(c.args[0]).includes(ErrorCode.CONFIG_MISSING),
            ),
          ).toBe(true);
          expect(
            suite.fetchStub.calls.some(
              (c) =>
                (c.args[1] as RequestInit | undefined)?.body ===
                ErrorCode.CONFIG_MISSING,
            ),
          ).toBe(true);
        } finally {
          errorSpy.restore();
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

        await suite.expectFlagPushOutcome(
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
        await suite.expectFlagPushOutcome(
          "Site A",
          addMonthsIso(nowIso(), 9).slice(0, 10),
        );
        // One site means the singular "Your new site is ready" email.
        suite.expectLastEmailBody({ subject: "Your new site is ready" });
        expect(
          suite.secretStub.calls.filter((c) => c.args[1] === "READ_ONLY_FROM"),
        ).toHaveLength(1);
      });

      test("a no-quantity line books no site and sends no email", async () => {
        await insertBuiltSite("Site A", "a.test.net", "", "", true);

        await assignAndNotifyBuiltSites([siteEntry({ quantity: 0 })]);

        const sites = await builtSites.getAll();
        expect(sites[0]!.assignedAttendeeId).toBeNull();
        expect(suite.fetchStub.calls.length).toBe(0);
      });

      test("Bunny push failure on one site of three leaves that site's readOnlyFrom empty, others persist", async () => {
        await createTierListing();
        await insertBuiltSite("Site A", "a.test.net", "", "", true, "1001");
        await insertBuiltSite("Site B", "b.test.net", "", "", true, "1002");
        await insertBuiltSite("Site C", "c.test.net", "", "", true, "1003");

        const assignableSites = await getAssignableBuiltSites();
        const failScriptId = Number(assignableSites[0]!.hostingId);

        suite.secretStub.restore();
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
        using _build = forbidBuildDuringAssignment();
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
        }
      });

      test("RENEWAL_URL push failure leaves renewal state unprovisioned", async () => {
        await createTierListing();

        await insertBuiltSite("Site A", "a.test.net", "", "", true, "2001");

        suite.secretStub.restore();
        const failStub = failingRenewalUrlPush();
        try {
          await assignAndNotifyBuiltSites([siteEntry()]);

          const sites = await builtSites.getAll();
          const assigned = sites.find((s) => s.name === "Site A")!;
          expect(assigned.assignedAttendeeId).not.toBeNull();
          expect(assigned.renewalTokenIndex).toBeNull();
          expect(assigned.readOnlyFrom).toBe("");
          const readOnlyCalls = failStub.calls.filter(
            (c: Stub["calls"][number]) => c.args[1] === "READ_ONLY_FROM",
          );
          expect(readOnlyCalls).toHaveLength(0);
        } finally {
          failStub.restore();
        }
      });

      test("a resend completes a renewal the first push failed to provision", async () => {
        await createTierListing();

        await insertBuiltSite("Site A", "a.test.net", "", "", true, "2001");

        // First run: the RENEAL_URL push fails, so the claim stands but the
        // renewal state stays empty.
        suite.secretStub.restore();
        const failStub = failingRenewalUrlPush();
        await assignAndNotifyBuiltSites([siteEntry()]);
        const afterFirst = (await builtSites.getAll()).find(
          (s) => s.name === "Site A",
        )!;
        expect(afterFirst.assignedAttendeeId).not.toBeNull();
        expect(afterFirst.renewalTokenIndex).toBeNull();

        // Resend with pushes working: the served buyer's renewal completes.
        failStub.restore();
        const okStub = stubEdgeSecretSuccess();
        try {
          await assignAndNotifyBuiltSites([siteEntry()]);

          const afterResend = (await builtSites.getAll()).find(
            (s) => s.name === "Site A",
          )!;
          expect(afterResend.assignedAttendeeId).toBe(
            afterFirst.assignedAttendeeId,
          );
          expect(afterResend.renewalTokenIndex).not.toBeNull();
          expect(afterResend.readOnlyFrom).not.toBe("");
        } finally {
          okStub.restore();
        }
      });
    });
  },
);
