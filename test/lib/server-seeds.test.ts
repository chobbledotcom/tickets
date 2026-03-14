import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { handleRequest } from "#routes";
import { createSeeds, SEED_MAX_ATTENDEES } from "#lib/seeds.ts";
import { MAX_SEED_EVENTS } from "#routes/admin/seeds.ts";
import { getAllEvents } from "#lib/db/events.ts";
import { getAttendeesRaw } from "#lib/db/attendees.ts";
import { getDb } from "#lib/db/client.ts";
import { invalidateSettingsCache } from "#lib/db/settings.ts";
import {
  adminGet,
  awaitTestRequest,
  createTestDbWithSetup,
  expectAdminRedirect,
  expectHtmlResponse,
  extractCsrfToken,
  mockAdminLoginRequest,
  mockFormRequest,
  mockRequest,
  requireJoinCsrfToken,
  resetDb,
  resetTestSlugCounter,
  testCookie,
  testCsrfToken,
} from "#test-utils";

/** Create a manager user and return their session cookie */
const loginAsManager = async (): Promise<string> => {
  // Create a manager invite
  const inviteResponse = await handleRequest(
    mockFormRequest("/admin/users", {
      username: "manager1",
      admin_level: "manager",
      csrf_token: await testCsrfToken(),
    }, await testCookie()),
  );
  const inviteUrl = inviteResponse.headers.get("location") ?? "";
  const inviteLink = decodeURIComponent(
    inviteUrl.match(/invite=([^&]+)/)![1] as string,
  );
  const inviteToken = inviteLink.split("/join/")[1];

  // Set password for manager
  const joinHtml =
    await (await handleRequest(mockRequest(`/join/${inviteToken}`))).text();
  const joinCsrf = requireJoinCsrfToken(joinHtml);
  await handleRequest(
    mockFormRequest(`/join/${inviteToken}`, {
      password: "managerpass123",
      password_confirm: "managerpass123",
      csrf_token: joinCsrf,
    }),
  );

  // Activate the manager
  await handleRequest(
    mockFormRequest("/admin/users/2/activate", {
      csrf_token: await testCsrfToken(),
    }, await testCookie()),
  );

  // Login as manager
  const loginResponse = await handleRequest(
    await mockAdminLoginRequest({
      username: "manager1",
      password: "managerpass123",
    }),
  );
  return loginResponse.headers.get("set-cookie") ?? "";
};

describe("server (admin seeds)", () => {
  beforeEach(async () => {
    resetTestSlugCounter();
    await createTestDbWithSetup();
  });

  afterEach(() => {
    resetDb();
  });

  describe("GET /admin/seeds", () => {
    test("redirects to login when not authenticated", async () => {
      const response = await handleRequest(mockRequest("/admin/seeds"));
      expectAdminRedirect(response);
    });

    test("returns 403 for non-owner", async () => {
      const managerCookie = await loginAsManager();
      const response = await awaitTestRequest("/admin/seeds", {
        cookie: managerCookie,
      });
      expect(response.status).toBe(403);
    });

    test("renders seeds page when authenticated", async () => {
      const { response } = await adminGet("/admin/seeds");
      await expectHtmlResponse(response, 200, "Seed Data");
    });

    test("contains form with event count and attendees per event fields", async () => {
      const { response } = await adminGet("/admin/seeds");
      const html = await response.text();
      expect(html).toContain("event_count");
      expect(html).toContain("attendees_per_event");
      expect(html).toContain("Create Seed Data");
    });

    test("contains back to dashboard link", async () => {
      const { response } = await adminGet("/admin/seeds");
      const html = await response.text();
      expect(html).toContain('href="/admin"');
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
      const managerCookie = await loginAsManager();
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
      const response = await handleRequest(
        mockFormRequest(
          "/admin/seeds",
          {
            event_count: "2",
            attendees_per_event: "0",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );

      const html = await expectHtmlResponse(response, 200);
      expect(html).toContain('class="success"');
      expect(html).toContain("Created 2 event(s) with 0 attendee(s) total.");

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

      const html = await expectHtmlResponse(response, 200);
      expect(html).toContain("Created 2 event(s) with 6 attendee(s) total.");

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

      const html = await expectHtmlResponse(response, 200);
      expect(html).toContain(`Created ${MAX_SEED_EVENTS} event(s)`);
    });

    test("clamps attendees per event to max", async () => {
      // Request more than SEED_MAX_ATTENDEES but create 0 events to avoid slow creation
      // We verify clamping by checking a single event with attendees
      const response = await handleRequest(
        mockFormRequest(
          "/admin/seeds",
          {
            event_count: "1",
            attendees_per_event: "9999",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );

      const html = await expectHtmlResponse(response, 200);
      expect(html).toContain(`with ${SEED_MAX_ATTENDEES} attendee(s) total.`);
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

      const html = await expectHtmlResponse(response, 200);
      expect(html).toContain("Created 1 event(s) with 0 attendee(s) total.");
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

    test("returns 500 when seed creation fails", async () => {
      // Remove public key to cause createSeeds to fail
      await getDb().execute("DELETE FROM settings WHERE key = 'public_key'");
      invalidateSettingsCache();

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

      const html = await expectHtmlResponse(response, 500);
      expect(html).toContain("Failed to create seed data");
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

      const html = await expectHtmlResponse(response, 200);
      expect(html).toContain("Created 1 event(s) with 2 attendee(s) total.");
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

      const html = await expectHtmlResponse(response, 200);
      expect(html).toContain("Created 1 event(s) with 0 attendee(s) total.");
    });

    test("throws when public key is not configured", async () => {
      // Remove public key to cause createSeeds to throw
      await getDb().execute("DELETE FROM settings WHERE key = 'public_key'");
      invalidateSettingsCache();

      await expect(createSeeds(1, 0)).rejects.toThrow(
        "Public key not configured",
      );
    });

    test("can seed multiple times additively", async () => {
      // First seed
      const get1 = await handleRequest(mockRequest("/admin/seeds", {
        headers: { cookie: await testCookie() },
      }));
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
      const get2 = await handleRequest(mockRequest("/admin/seeds", {
        headers: { cookie: await testCookie() },
      }));
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
