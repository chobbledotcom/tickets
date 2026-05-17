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
import { nowIso } from "#shared/now.ts";
import {
  assignAndNotifyBuiltSites,
  pickTierEvent,
} from "#shared/site-assignment.ts";
import {
  createTestEvent,
  describeWithEnv,
  makeTestEntry,
  setTestEnv,
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

/** Build an entry with assign_built_site for testing */
const siteEntry = (
  overrides: {
    eventId?: number;
    eventName?: string;
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
      ...(overrides.eventId !== undefined && { id: overrides.eventId }),
      ...(overrides.eventName !== undefined && { name: overrides.eventName }),
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
        fromAddress: "test@example.com",
        provider: "resend",
      });
      await createTestEvent({
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

      test("skips events without assign_built_site", async () => {
        await insertBuiltSite("Site A", "a.test.net", "", "", true);

        await assignAndNotifyBuiltSites([
          siteEntry({ assignBuiltSite: false }),
        ]);

        const sites = await getAllBuiltSites();
        expect(sites[0]!.assignable).toBe(true);
        expect(sites[0]!.assignedAttendeeId).toBeNull();
        expect(fetchStub.calls.length).toBe(0);
      });

      test("assigns sites independently per event", async () => {
        await insertBuiltSite("Site A", "a.test.net", "", "", true);
        await insertBuiltSite("Site B", "b.test.net", "", "", true);

        await assignAndNotifyBuiltSites([
          siteEntry({ attendeeId: 10, eventId: 1, eventName: "Event 1" }),
          siteEntry({ attendeeId: 10, eventId: 2, eventName: "Event 2" }),
        ]);

        const sites = await getAllBuiltSites();
        const assigned = sites.filter((s) => s.assignedAttendeeId !== null);
        expect(assigned).toHaveLength(2);
        expect(assigned[0]!.assignedEventId).toBe(1);
        expect(assigned[1]!.assignedEventId).toBe(2);
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
          siteEntry({ eventId: 1, eventName: "Event 1" }),
          siteEntry({ eventId: 2, eventName: "Event 2" }),
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
      const createTierEvent = (unitPrice = 500, monthsPerUnit = 1) =>
        createTestEvent({
          hidden: true,
          maxAttendees: 1000,
          monthsPerUnit,
          purchaseOnly: true,
          unitPrice,
        });

      test("generates renewal token and pushes READ_ONLY_FROM + RENEWAL_URL on assignment", async () => {
        const tier = await createTierEvent();
        await insertBuiltSite("Site A", "a.test.net", "", "", true, "2001");

        await assignAndNotifyBuiltSites([siteEntry({ initialSiteMonths: 3 })]);

        const sites = await getAllBuiltSites();
        const assigned = sites.find((s) => s.name === "Site A")!;
        expect(assigned.renewalTokenIndex).not.toBeNull();
        expect(assigned.renewalTierEventId).toBe(tier.id);
        expect(assigned.readOnlyFrom).toBeTruthy();

        expect(assigned.renewalToken).not.toBeNull();
        expect(assigned.renewalToken!.length).toBeGreaterThanOrEqual(32);

        const expectedCutoff = addMonthsIso(nowIso(), 3).slice(0, 10);
        expect(assigned.readOnlyFrom.slice(0, 10)).toBe(expectedCutoff);

        const secretCalls = secretStub.calls.map((c) => c.args);
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

        await assignAndNotifyBuiltSites([siteEntry({ initialSiteMonths: 0 })]);

        const sites = await getAllBuiltSites();
        const site = sites.find((s) => s.name === "Site A")!;
        expect(site.assignedAttendeeId).toBeNull();
        expect(site.renewalTokenIndex).toBeNull();
        expect(secretStub.calls.length).toBe(0);
      });

      test("skips assignment and logs CONFIG_MISSING when no qualifying tier events exist", async () => {
        const { getAllEvents } = await import("#shared/db/events.ts");
        const events = await getAllEvents();
        const { deactivateTestEvent } = await import("#test-utils");
        for (const ev of events) {
          if (
            ev.months_per_unit > 0 &&
            ev.purchase_only &&
            ev.hidden &&
            ev.active
          ) {
            await deactivateTestEvent(ev.id);
          }
        }

        const buildStub = stubBuildSiteSuccess();
        try {
          await assignAndNotifyBuiltSites([siteEntry()]);

          const sites = await getAllBuiltSites();
          const assigned = sites.filter((s) => s.assignedAttendeeId !== null);
          expect(assigned).toHaveLength(0);
          expect(secretStub.calls.length).toBe(0);
        } finally {
          buildStub.restore();
        }
      });

      test("picks the cheapest qualifying tier event", async () => {
        const cheap = await createTierEvent(300);
        const _expensive = await createTierEvent(900);

        const result = await pickTierEvent();
        expect(result).not.toBeNull();
        expect(result!.id).toBe(cheap.id);
      });

      test("with two qualifying tier events, cheapest is used as site tier", async () => {
        const cheap = await createTierEvent(300);
        await createTierEvent(900);

        await insertBuiltSite("Site A", "a.test.net", "", "", true, "2002");

        await assignAndNotifyBuiltSites([siteEntry()]);

        const sites = await getAllBuiltSites();
        const assigned = sites.find((s) => s.name === "Site A")!;
        expect(assigned.renewalTierEventId).toBe(cheap.id);
      });

      test("with quantity=3, three independent tokens and secret pushes are created", async () => {
        await createTierEvent();

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
        await createTierEvent();

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
          expect(failedSite!.renewalTokenIndex).not.toBeNull();

          for (const site of succeededSites) {
            expect(site.readOnlyFrom).not.toBe("");
          }
        } finally {
          failStub.restore();
          buildStub.restore();
        }
      });
    });
  },
);
