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
  loginAsAdmin,
  mockAdminLoginRequest,
  mockFormRequest,
  mockRequest,
  requireJoinCsrfToken,
  resetDb,
  resetTestSlugCounter,
} from "#test-utils";

/** Create a manager user and return their session cookie */
const loginAsManager = async (): Promise<string> => {
  const { cookie: ownerCookie, csrfToken: ownerCsrf } = await loginAsAdmin();

  // Create a manager invite
  const inviteResponse = await handleRequest(
    mockFormRequest("/admin/users", {
      username: "manager1",
      admin_level: "manager",
      csrf_token: ownerCsrf,
    }, ownerCookie),
  );
  const inviteUrl = inviteResponse.headers.get("location") ?? "";
  const inviteLink = decodeURIComponent(inviteUrl.match(/invite=([^&]+)/)![1] as string);
  const inviteToken = inviteLink.split("/join/")[1];

  // Set password for manager
  const joinHtml = await (await handleRequest(mockRequest(`/join/${inviteToken}`))).text();
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
    mockFormRequest("/admin/users/2/activate", { csrf_token: ownerCsrf }, ownerCookie),
  );

  // Login as manager
  const loginResponse = await handleRequest(
    await mockAdminLoginRequest({ username: "manager1", password: "managerpass123" }),
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
      const response = await awaitTestRequest("/admin/seeds", { cookie: managerCookie });
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
        mockFormRequest("/admin/seeds", { event_count: "1", attendees_per_event: "0" }),
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
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/seeds",
          { event_count: "2", attendees_per_event: "0", csrf_token: csrfToken },
          cookie,
        ),
      );

      const html = await expectHtmlResponse(response, 200);
      expect(html).toContain("<strong>2</strong> event(s)");
      expect(html).toContain("<strong>0</strong> attendee(s)");

      const events = await getAllEvents();
      expect(events.length).toBe(2);
    });

    test("creates seed events with attendees", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/seeds",
          { event_count: "1", attendees_per_event: "3", csrf_token: csrfToken },
          cookie,
        ),
      );

      const html = await expectHtmlResponse(response, 200);
      expect(html).toContain("<strong>1</strong> event(s)");
      expect(html).toContain("<strong>3</strong> attendee(s)");

      const events = await getAllEvents();
      expect(events.length).toBe(1);

      const attendees = await getAttendeesRaw(events[0]!.id);
      expect(attendees.length).toBe(3);
    });

    test("clamps event count to max", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/seeds",
          { event_count: "999", attendees_per_event: "0", csrf_token: csrfToken },
          cookie,
        ),
      );

      const html = await expectHtmlResponse(response, 200);
      expect(html).toContain(`<strong>${MAX_SEED_EVENTS}</strong> event(s)`);
    });

    test("clamps attendees per event to max", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/seeds",
          { event_count: "1", attendees_per_event: "999", csrf_token: csrfToken },
          cookie,
        ),
      );

      const html = await expectHtmlResponse(response, 200);
      expect(html).toContain(`<strong>${SEED_MAX_ATTENDEES}</strong> attendee(s)`);
    });

    test("clamps negative values to minimum", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/seeds",
          { event_count: "-5", attendees_per_event: "-10", csrf_token: csrfToken },
          cookie,
        ),
      );

      const html = await expectHtmlResponse(response, 200);
      expect(html).toContain("<strong>1</strong> event(s)");
      expect(html).toContain("<strong>0</strong> attendee(s)");
    });

    test("rejects invalid CSRF token", async () => {
      const { cookie } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/seeds",
          { event_count: "1", attendees_per_event: "0", csrf_token: "invalid" },
          cookie,
        ),
      );

      expect(response.status).toBe(403);
    });

    test("created events are active with expected max attendees", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      await handleRequest(
        mockFormRequest(
          "/admin/seeds",
          { event_count: "1", attendees_per_event: "0", csrf_token: csrfToken },
          cookie,
        ),
      );

      const events = await getAllEvents();
      expect(events[0]!.active).toBe(true);
      expect(events[0]!.max_attendees).toBe(SEED_MAX_ATTENDEES);
    });

    test("returns 500 when seed creation fails", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      // Remove public key to cause createSeeds to fail
      await getDb().execute("DELETE FROM settings WHERE key = 'public_key'");
      invalidateSettingsCache();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/seeds",
          { event_count: "1", attendees_per_event: "0", csrf_token: csrfToken },
          cookie,
        ),
      );

      const html = await expectHtmlResponse(response, 500);
      expect(html).toContain("Failed to create seed data");
    });

    test("handles non-numeric event count as 1", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/seeds",
          { event_count: "abc", attendees_per_event: "2", csrf_token: csrfToken },
          cookie,
        ),
      );

      const html = await expectHtmlResponse(response, 200);
      expect(html).toContain("<strong>1</strong> event(s)");
      expect(html).toContain("<strong>2</strong> attendee(s)");
    });

    test("handles non-numeric attendees per event as 0", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/seeds",
          { event_count: "1", attendees_per_event: "abc", csrf_token: csrfToken },
          cookie,
        ),
      );

      const html = await expectHtmlResponse(response, 200);
      expect(html).toContain("<strong>1</strong> event(s)");
      expect(html).toContain("<strong>0</strong> attendee(s)");
    });

    test("throws when public key is not configured", async () => {
      // Remove public key to cause createSeeds to throw
      await getDb().execute("DELETE FROM settings WHERE key = 'public_key'");
      invalidateSettingsCache();

      await expect(createSeeds(1, 0)).rejects.toThrow("Public key not configured");
    });

    test("can seed multiple times additively", async () => {
      const { cookie } = await loginAsAdmin();

      // First seed
      const get1 = await handleRequest(mockRequest("/admin/seeds", {
        headers: { cookie },
      }));
      const html1 = await get1.text();
      const csrf1 = extractCsrfToken(html1)!;

      await handleRequest(
        mockFormRequest(
          "/admin/seeds",
          { event_count: "2", attendees_per_event: "0", csrf_token: csrf1 },
          cookie,
        ),
      );

      // Second seed
      const get2 = await handleRequest(mockRequest("/admin/seeds", {
        headers: { cookie },
      }));
      const html2 = await get2.text();
      const csrf2 = extractCsrfToken(html2)!;

      await handleRequest(
        mockFormRequest(
          "/admin/seeds",
          { event_count: "3", attendees_per_event: "0", csrf_token: csrf2 },
          cookie,
        ),
      );

      const events = await getAllEvents();
      expect(events.length).toBe(5);
    });
  });
});
