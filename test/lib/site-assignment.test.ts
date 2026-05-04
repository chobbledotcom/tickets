import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { getAllBuiltSites, insertBuiltSite } from "#shared/db/built-sites.ts";
import {
  resetHostEmailConfig,
  setHostEmailConfigForTest,
} from "#shared/email.ts";
import { assignAndNotifyBuiltSites } from "#shared/site-assignment.ts";
import { describeWithEnv, makeTestEntry, setTestEnv } from "#test-utils";

/** Build an entry with assign_built_site for testing */
const siteEntry = (
  overrides: {
    eventId?: number;
    eventName?: string;
    assignBuiltSite?: boolean;
    attendeeId?: number;
    quantity?: number;
    email?: string;
  } = {},
) =>
  makeTestEntry(
    {
      assign_built_site: overrides.assignBuiltSite ?? true,
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

    beforeEach(() => {
      fetchStub = stub(globalThis, "fetch", () =>
        Promise.resolve(new Response()),
      );
      setHostEmailConfigForTest({
        apiKey: "re_test",
        fromAddress: "test@example.com",
        provider: "resend",
      });
    });

    afterEach(() => {
      fetchStub.restore();
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

      test("does not assign when no assignable sites available", async () => {
        await insertBuiltSite("Site A", "a.test.net", "", "", false);

        await assignAndNotifyBuiltSites([siteEntry()]);

        const sites = await getAllBuiltSites();
        expect(sites[0]!.assignedAttendeeId).toBeNull();
        expect(fetchStub.calls.length).toBe(0);
      });

      test("no-ops for empty entries", async () => {
        await assignAndNotifyBuiltSites([]);
        expect(fetchStub.calls.length).toBe(0);
      });

      test("assigns only available sites when fewer than needed", async () => {
        await insertBuiltSite("Site A", "a.test.net", "", "", true);

        await assignAndNotifyBuiltSites([siteEntry({ quantity: 3 })]);

        const sites = await getAllBuiltSites();
        const assigned = sites.filter((s) => s.assignedAttendeeId !== null);
        expect(assigned).toHaveLength(1);
        expect(fetchStub.calls.length).toBe(1);
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
  },
);
