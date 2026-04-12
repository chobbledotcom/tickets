import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  getAllBuiltSites,
  insertBuiltSite,
} from "#lib/db/built-sites.ts";
import { assignAndNotifyBuiltSites } from "#lib/site-assignment.ts";
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
      id: overrides.eventId,
      name: overrides.eventName,
      assign_built_site: overrides.assignBuiltSite ?? true,
    },
    {
      id: overrides.attendeeId,
      email: overrides.email,
      quantity: overrides.quantity,
    },
  );

describeWithEnv("site-assignment", {
  db: true,
  env: { CAN_BUILD_SITES: "true" },
}, () => {
  describe("assignAndNotifyBuiltSites", () => {
    test("assigns one site per ticket", async () => {
      await insertBuiltSite("Site A", "a.test.net", "", "", true);
      await insertBuiltSite("Site B", "b.test.net", "", "", true);

      await assignAndNotifyBuiltSites([siteEntry({ quantity: 2 })]);

      const sites = await getAllBuiltSites();
      const assigned = sites.filter((s) => s.assignedAttendeeId !== null);
      expect(assigned).toHaveLength(2);
      expect(assigned.every((s) => !s.assignable)).toBe(true);
    });

    test("skips events without assign_built_site", async () => {
      await insertBuiltSite("Site A", "a.test.net", "", "", true);

      await assignAndNotifyBuiltSites([
        siteEntry({ assignBuiltSite: false }),
      ]);

      const sites = await getAllBuiltSites();
      expect(sites[0]!.assignable).toBe(true);
      expect(sites[0]!.assignedAttendeeId).toBeNull();
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
    });

    test("no-ops for empty entries", async () => {
      await assignAndNotifyBuiltSites([]);
    });

    test("assigns only available sites when fewer than needed", async () => {
      await insertBuiltSite("Site A", "a.test.net", "", "", true);

      await assignAndNotifyBuiltSites([siteEntry({ quantity: 3 })]);

      const sites = await getAllBuiltSites();
      const assigned = sites.filter((s) => s.assignedAttendeeId !== null);
      expect(assigned).toHaveLength(1);
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
});
