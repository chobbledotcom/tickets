import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { insertBuiltSite } from "#lib/db/built-sites.ts";
import { assignSitesForEntries } from "#lib/site-assignment.ts";
import type { EmailEntry } from "#lib/email.ts";
import { describeWithEnv } from "#test-utils";

/** Build a minimal EmailEntry for testing */
const mockEntry = (
  overrides: {
    eventId?: number;
    eventName?: string;
    assignBuiltSite?: boolean;
    attendeeId?: number;
    quantity?: number;
    email?: string;
  } = {},
): EmailEntry =>
  ({
    event: {
      id: overrides.eventId ?? 1,
      name: overrides.eventName ?? "Test Event",
      slug: "test",
      webhook_url: "",
      max_attendees: 100,
      attendee_count: 0,
      unit_price: 0,
      can_pay_more: false,
      date: "",
      location: "",
      purchase_only: false,
      assign_built_site: overrides.assignBuiltSite ?? true,
    },
    attendee: {
      id: overrides.attendeeId ?? 1,
      name: "Test User",
      email: overrides.email ?? "user@test.com",
      phone: "",
      address: "",
      special_instructions: "",
      quantity: overrides.quantity ?? 1,
      payment_id: "",
      price_paid: "0",
      ticket_token: "tok123",
      date: null,
    },
  }) as EmailEntry;

describeWithEnv("site-assignment", { db: true }, () => {
  describe("assignSitesForEntries", () => {
    test("assigns one site per ticket", async () => {
      await insertBuiltSite("Site A", "a.test.net", "", "", true);
      await insertBuiltSite("Site B", "b.test.net", "", "", true);

      const entries = [mockEntry({ quantity: 2 })];
      const assignments = await assignSitesForEntries(entries);

      expect(assignments).toHaveLength(2);
      expect(assignments[0]!.siteUrl).toBe("a.test.net");
      expect(assignments[1]!.siteUrl).toBe("b.test.net");
    });

    test("skips events without assign_built_site", async () => {
      await insertBuiltSite("Site A", "a.test.net", "", "", true);

      const entries = [mockEntry({ assignBuiltSite: false })];
      const assignments = await assignSitesForEntries(entries);

      expect(assignments).toHaveLength(0);
    });

    test("assigns sites independently per event", async () => {
      await insertBuiltSite("Site A", "a.test.net", "", "", true);
      await insertBuiltSite("Site B", "b.test.net", "", "", true);

      const entries = [
        mockEntry({ eventId: 1, eventName: "Event 1", attendeeId: 10 }),
        mockEntry({ eventId: 2, eventName: "Event 2", attendeeId: 10 }),
      ];
      const assignments = await assignSitesForEntries(entries);

      expect(assignments).toHaveLength(2);
      expect(assignments[0]!.eventName).toBe("Event 1");
      expect(assignments[1]!.eventName).toBe("Event 2");
    });

    test("returns empty when no assignable sites available", async () => {
      await insertBuiltSite("Site A", "a.test.net", "", "", false);

      const entries = [mockEntry()];
      const assignments = await assignSitesForEntries(entries);

      expect(assignments).toHaveLength(0);
    });

    test("returns empty for empty entries", async () => {
      const assignments = await assignSitesForEntries([]);
      expect(assignments).toHaveLength(0);
    });

    test("assigns only available sites when fewer than needed", async () => {
      await insertBuiltSite("Site A", "a.test.net", "", "", true);

      const entries = [mockEntry({ quantity: 3 })];
      const assignments = await assignSitesForEntries(entries);

      expect(assignments).toHaveLength(1);
      expect(assignments[0]!.siteUrl).toBe("a.test.net");
    });
  });
});
