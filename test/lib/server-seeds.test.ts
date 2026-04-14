import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getAttendeesRaw } from "#lib/db/attendees.ts";
import { getDb } from "#lib/db/client.ts";
import { getAllEvents } from "#lib/db/events.ts";
import { settings } from "#lib/db/settings.ts";
import { createSeeds } from "#lib/seeds.ts";
import { handleRequest } from "#routes";
import { MAX_SEED_EVENTS } from "#routes/admin/seeds.ts";
import {
  assertAdminHtml,
  awaitTestRequest,
  createTestManagerSession,
  describeWithEnv,
  expectAdminRedirect,
  expectRedirectWithFlash,
  extractCsrfToken,
  mockFormRequest,
  mockRequest,
  testCookie,
  testCsrfToken,
} from "#test-utils";

describeWithEnv("server (admin seeds)", { db: true }, () => {
  describe("GET /admin/seeds", () => {
    test("redirects to login when not authenticated", async () => {
      const response = await handleRequest(mockRequest("/admin/seeds"));
      expectAdminRedirect(response);
    });

    test("returns 403 for non-owner", async () => {
      const managerCookie = await createTestManagerSession();
      const response = await awaitTestRequest("/admin/seeds", {
        cookie: managerCookie,
      });
      expect(response.status).toBe(403);
    });

    test("renders seeds page when authenticated", async () => {
      await assertAdminHtml("/admin/seeds", "Seed Data");
    });

    test("contains form with event count and attendees per event fields", async () => {
      await assertAdminHtml(
        "/admin/seeds",
        "event_count",
        "attendees_per_event",
        "Create Seed Data",
      );
    });

    test("contains back to dashboard link", async () => {
      await assertAdminHtml("/admin/seeds", 'href="/admin"');
    });
  });

  describe("POST /admin/seeds", () => {
    test("redirects to login when not authenticated", async () => {
      const response = await handleRequest(
        mockFormRequest("/admin/seeds", {
          event_count: "1",
          attendees_per_event: "0",
        }),
      );
      expectAdminRedirect(response);
    });

    test("returns 403 for non-owner", async () => {
      const managerCookie = await createTestManagerSession();
      const response = await handleRequest(
        mockFormRequest(
          "/admin/seeds",
          { event_count: "1", attendees_per_event: "0" },
          managerCookie,
        ),
      );
      expect(response.status).toBe(403);
    });

    test("creates seed events with no attendees", async () => {
      const cookie = await testCookie();
      const response = await handleRequest(
        mockFormRequest(
          "/admin/seeds",
          {
            event_count: "2",
            attendees_per_event: "0",
            csrf_token: await testCsrfToken(),
          },
          cookie,
        ),
      );

      expectRedirectWithFlash(
        "/admin/seeds",
        "Created 2 event(s) with 0 attendee(s) total.",
      )(response);

      const events = await getAllEvents();
      expect(events.length).toBe(2);
    });

    test("creates seed events with attendees including paid and free", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/seeds",
          {
            event_count: "2",
            attendees_per_event: "3",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );

      expectRedirectWithFlash(
        "/admin/seeds",
        expect.stringContaining("Created 2 event"),
      )(response);

      const events = await getAllEvents();
      expect(events.length).toBe(2);

      // Verify both paid and free events are created
      const paidEvent = events.find((e) => e.unit_price > 0);
      const freeEvent = events.find((e) => e.unit_price === 0);
      expect(paidEvent).toBeDefined();
      expect(freeEvent).toBeDefined();

      for (const event of events) {
        const attendees = await getAttendeesRaw(event.id);
        expect(attendees.length).toBe(3);

        // Each attendee has a quantity between 1 and 4
        for (const attendee of attendees) {
          expect(attendee.quantity).toBeGreaterThanOrEqual(1);
          expect(attendee.quantity).toBeLessThanOrEqual(4);
        }

        // Total quantity does not exceed event max_attendees (no overselling)
        const totalQuantity = attendees.reduce((sum, a) => sum + a.quantity, 0);
        expect(totalQuantity).toBeLessThanOrEqual(event.max_attendees);
        // Event max_attendees equals exactly the sum of attendee quantities
        expect(event.max_attendees).toBe(totalQuantity);
      }
    });

    test("clamps event count to max", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/seeds",
          {
            event_count: "999",
            attendees_per_event: "0",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );

      expectRedirectWithFlash(
        "/admin/seeds",
        expect.stringContaining(`Created ${MAX_SEED_EVENTS} event`),
      )(response);
    });

    test("clamps negative values to minimum", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/seeds",
          {
            event_count: "-5",
            attendees_per_event: "-10",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );

      expectRedirectWithFlash(
        "/admin/seeds",
        expect.stringContaining("Created 1 event"),
      )(response);
    });

    test("rejects invalid CSRF token", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/seeds",
          { event_count: "1", attendees_per_event: "0", csrf_token: "invalid" },
          await testCookie(),
        ),
      );

      expect(response.status).toBe(403);
    });

    test("created events are active", async () => {
      await handleRequest(
        mockFormRequest(
          "/admin/seeds",
          {
            event_count: "1",
            attendees_per_event: "0",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );

      const events = await getAllEvents();
      expect(events[0]!.active).toBe(true);
      // With 0 attendees, max_attendees is 0 (sum of quantities)
      expect(events[0]!.max_attendees).toBe(0);
    });

    test("redirects with error when seed creation fails", async () => {
      // Remove public key to cause createSeeds to fail
      await getDb().execute("DELETE FROM settings WHERE key = 'public_key'");
      settings.invalidateCache();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/seeds",
          {
            event_count: "1",
            attendees_per_event: "0",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );

      expectRedirectWithFlash(
        "/admin/seeds",
        "Failed to create seed data. Ensure setup is complete.",
        false,
      )(response);
    });

    test("handles non-numeric event count as 1", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/seeds",
          {
            event_count: "abc",
            attendees_per_event: "2",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );

      expectRedirectWithFlash(
        "/admin/seeds",
        expect.stringContaining("Created 1 event"),
      )(response);
    });

    test("handles non-numeric attendees per event as 0", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/seeds",
          {
            event_count: "1",
            attendees_per_event: "abc",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );

      expectRedirectWithFlash(
        "/admin/seeds",
        expect.stringContaining("Created 1 event"),
      )(response);
    });

    test("throws when public key is not configured", async () => {
      // Remove public key to cause createSeeds to throw
      await getDb().execute("DELETE FROM settings WHERE key = 'public_key'");
      settings.invalidateCache();

      await expect(createSeeds(1, 0)).rejects.toThrow(
        "Public key not configured",
      );
    });

    test("can seed multiple times additively", async () => {
      // First seed
      const get1 = await handleRequest(
        mockRequest("/admin/seeds", {
          headers: { cookie: await testCookie() },
        }),
      );
      const html1 = await get1.text();
      const csrf1 = extractCsrfToken(html1)!;

      await handleRequest(
        mockFormRequest(
          "/admin/seeds",
          { event_count: "2", attendees_per_event: "0", csrf_token: csrf1 },
          await testCookie(),
        ),
      );

      // Second seed
      const get2 = await handleRequest(
        mockRequest("/admin/seeds", {
          headers: { cookie: await testCookie() },
        }),
      );
      const html2 = await get2.text();
      const csrf2 = extractCsrfToken(html2)!;

      await handleRequest(
        mockFormRequest(
          "/admin/seeds",
          { event_count: "3", attendees_per_event: "0", csrf_token: csrf2 },
          await testCookie(),
        ),
      );

      const events = await getAllEvents();
      expect(events.length).toBe(5);
    });
  });
});
