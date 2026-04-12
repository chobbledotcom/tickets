import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import {
  getAllBuiltSites,
  insertBuiltSite,
} from "#lib/db/built-sites.ts";
import { resetHostEmailConfig, setHostEmailConfigForTest } from "#lib/email.ts";
import { assignAndNotifyBuiltSites } from "#lib/site-assignment.ts";
import { describeWithEnv, makeTestEntry } from "#test-utils";

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

describeWithEnv("site-assignment", { db: true }, () => {
  // deno-lint-ignore no-explicit-any
  let fetchStub: any;

  beforeEach(() => {
    // Set directly (not via setTestEnv overlay) so process.env sees it
    Deno.env.set("CAN_BUILD_SITES", "true");
    fetchStub = stub(globalThis, "fetch", () =>
      Promise.resolve(new Response()),
    );
    setHostEmailConfigForTest({
      provider: "resend",
      apiKey: "re_test",
      fromAddress: "test@example.com",
    });
  });

  afterEach(() => {
    Deno.env.delete("CAN_BUILD_SITES");
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
        siteEntry({ eventId: 1, eventName: "Event 1", attendeeId: 10 }),
        siteEntry({ eventId: 2, eventName: "Event 2", attendeeId: 10 }),
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

    test("includes reply-to when business email is set", async () => {
      const { settings } = await import("#lib/db/settings.ts");
      await settings.update.businessEmail("biz@example.com");

      await insertBuiltSite("Site A", "a.test.net", "", "", true);
      await assignAndNotifyBuiltSites([siteEntry()]);

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
      Deno.env.delete("CAN_BUILD_SITES");
      try {
        await insertBuiltSite("Site A", "a.test.net", "", "", true);
        await assignAndNotifyBuiltSites([siteEntry()]);
        const sites = await getAllBuiltSites();
        expect(sites[0]!.assignable).toBe(true);
        expect(sites[0]!.assignedAttendeeId).toBeNull();
      } finally {
        Deno.env.set("CAN_BUILD_SITES", "true");
      }
    });
  });
});
