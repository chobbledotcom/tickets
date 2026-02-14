/**
 * Tests for the QR scanner admin feature
 * GET /admin/event/:id/scanner - Scanner page
 * POST /admin/event/:id/scan - JSON check-in API
 */

import { afterEach, beforeEach, describe, expect, test } from "#test-compat";
import { handleRequest } from "#routes";
import {
  adminGet,
  awaitTestRequest,
  createTestAttendeeWithToken,
  createTestEvent,
  loginAsAdmin,
  resetDb,
  createTestDbWithSetup,
  resetTestSlugCounter,
} from "#test-utils";
import { isJsonApiPath } from "#routes/middleware.ts";

/** Create a JSON POST request for the scan API */
const mockScanRequest = (
  eventId: number,
  body: Record<string, unknown>,
  cookie: string,
  csrfToken: string,
): Request =>
  new Request(`http://localhost/admin/event/${eventId}/scan`, {
    method: "POST",
    headers: {
      host: "localhost",
      "content-type": "application/json",
      "x-csrf-token": csrfToken,
      cookie,
    },
    body: JSON.stringify(body),
  });

/** Create event + attendee and return session + scan-ready token */
const setupScanTest = async (name: string, email: string, eventOverrides = {}) => {
  const { event, token } = await createTestAttendeeWithToken(name, email, eventOverrides);
  const session = await loginAsAdmin();
  return { event, token, session };
};

describe("QR Scanner", () => {
  beforeEach(async () => {
    resetTestSlugCounter();
    await createTestDbWithSetup();
  });

  afterEach(() => {
    resetDb();
  });

  describe("isJsonApiPath", () => {
    test("matches scan endpoint with numeric event ID", () => {
      expect(isJsonApiPath("/admin/event/123/scan")).toBe(true);
    });

    test("matches scan endpoint with single-digit event ID", () => {
      expect(isJsonApiPath("/admin/event/1/scan")).toBe(true);
    });

    test("does not match non-scan admin paths", () => {
      expect(isJsonApiPath("/admin/event/123/edit")).toBe(false);
    });

    test("does not match paths without event ID", () => {
      expect(isJsonApiPath("/admin/event//scan")).toBe(false);
    });

    test("does not match webhook path", () => {
      expect(isJsonApiPath("/payment/webhook")).toBe(false);
    });

    test("does not match with non-numeric event ID", () => {
      expect(isJsonApiPath("/admin/event/abc/scan")).toBe(false);
    });
  });

  describe("Content-Type validation for scan endpoint", () => {
    test("accepts JSON content type for scan endpoint", async () => {
      const { event, session } = await setupScanTest("CT", "ct@test.com");
      const response = await handleRequest(
        mockScanRequest(event.id, { token: "nonexistent" }, session.cookie, session.csrfToken),
      );
      // Should not be 400 (Content-Type rejection) - it should process the request
      expect(response.status).not.toBe(400);
    });

    test("rejects non-JSON content type for scan endpoint", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });

      const response = await handleRequest(
        new Request(`http://localhost/admin/event/${event.id}/scan`, {
          method: "POST",
          headers: {
            host: "localhost",
            "content-type": "application/x-www-form-urlencoded",
          },
          body: "token=test",
        }),
      );

      expect(response.status).toBe(400);
    });
  });

  describe("GET /admin/event/:id/scanner", () => {
    test("renders scanner page when authenticated", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });
      const { response } = await adminGet(`/admin/event/${event.id}/scanner`);

      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain("Scanner");
      expect(body).toContain("scanner-video");
      expect(body).toContain("scanner-start");
      expect(body).toContain(`data-event-id="${event.id}"`);
      expect(body).toContain("scanner.js");
    });

    test("redirects to /admin when not authenticated", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });
      const response = await awaitTestRequest(`/admin/event/${event.id}/scanner`);

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin");
    });

    test("returns 404 for non-existent event", async () => {
      const { response } = await adminGet("/admin/event/99999/scanner");
      expect(response.status).toBe(404);
    });
  });

  describe("POST /admin/event/:id/scan", () => {
    test("checks in attendee from same event", async () => {
      const { event, token, session } = await setupScanTest("Alice", "alice@test.com");
      const response = await handleRequest(
        mockScanRequest(event.id, { token }, session.cookie, session.csrfToken),
      );

      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.status).toBe("checked_in");
      expect(result.name).toBe("Alice");
    });

    test("returns already_checked_in for checked-in attendee", async () => {
      const { event, token, session } = await setupScanTest("Bob", "bob@test.com");

      // First scan - check in
      await handleRequest(
        mockScanRequest(event.id, { token }, session.cookie, session.csrfToken),
      );

      // Second scan - already checked in
      const response = await handleRequest(
        mockScanRequest(event.id, { token }, session.cookie, session.csrfToken),
      );

      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.status).toBe("already_checked_in");
      expect(result.name).toBe("Bob");
    });

    test("returns wrong_event for attendee from different event", async () => {
      const { event: eventA, token } = await createTestAttendeeWithToken("Carol", "carol@test.com");
      const eventB = await createTestEvent({ maxAttendees: 10 });
      const session = await loginAsAdmin();

      // Scan token from event A while on event B's scanner
      const response = await handleRequest(
        mockScanRequest(eventB.id, { token }, session.cookie, session.csrfToken),
      );

      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.status).toBe("wrong_event");
      expect(result.name).toBe("Carol");
      expect(result.eventName).toBe(eventA.name);
    });

    test("checks in cross-event attendee with force flag", async () => {
      const { token } = await createTestAttendeeWithToken("Dave", "dave@test.com");
      const eventB = await createTestEvent({ maxAttendees: 10 });
      const session = await loginAsAdmin();

      // Force check-in from event B's scanner
      const response = await handleRequest(
        mockScanRequest(eventB.id, { token, force: true }, session.cookie, session.csrfToken),
      );

      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.status).toBe("checked_in");
      expect(result.name).toBe("Dave");
    });

    test("returns Unknown event when attendee's event is deleted", async () => {
      const { getDb } = await import("#lib/db/client.ts");
      const { computeTicketTokenIndex } = await import("#lib/crypto.ts");
      const { token } = await createTestAttendeeWithToken("Frank", "frank@test.com");
      const eventB = await createTestEvent({ maxAttendees: 10 });
      const session = await loginAsAdmin();

      // Compute HMAC index for lookup (ticket_token is encrypted, we use index)
      const tokenIndex = await computeTicketTokenIndex(token);

      // Point attendee at a non-existent event to simulate orphan
      await getDb().execute({ sql: "PRAGMA foreign_keys = OFF", args: [] });
      await getDb().execute({
        sql: "UPDATE attendees SET event_id = 99999 WHERE ticket_token_index = ?",
        args: [tokenIndex],
      });
      await getDb().execute({ sql: "PRAGMA foreign_keys = ON", args: [] });

      // Scan from event B - attendee's event_id still points to deleted event A
      const response = await handleRequest(
        mockScanRequest(eventB.id, { token }, session.cookie, session.csrfToken),
      );

      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.status).toBe("wrong_event");
      expect(result.eventName).toBe("Unknown event");
    });

    test("returns not_found for invalid token", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });
      const session = await loginAsAdmin();
      const response = await handleRequest(
        mockScanRequest(event.id, { token: "nonexistent-token" }, session.cookie, session.csrfToken),
      );

      expect(response.status).toBe(404);
      const result = await response.json();
      expect(result.status).toBe("not_found");
    });

    test("returns 401 when not authenticated", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });

      const response = await handleRequest(
        new Request(`http://localhost/admin/event/${event.id}/scan`, {
          method: "POST",
          headers: {
            host: "localhost",
            "content-type": "application/json",
          },
          body: JSON.stringify({ token: "test" }),
        }),
      );

      expect(response.status).toBe(401);
    });

    test("returns 403 for invalid CSRF token", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });
      const session = await loginAsAdmin();
      const response = await handleRequest(
        mockScanRequest(event.id, { token: "test" }, session.cookie, "wrong-csrf-token"),
      );

      expect(response.status).toBe(403);
    });

    test("returns 400 for missing token in body", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });
      const session = await loginAsAdmin();
      const response = await handleRequest(
        mockScanRequest(event.id, {}, session.cookie, session.csrfToken),
      );

      expect(response.status).toBe(400);
    });

    test("returns 403 when x-csrf-token header is absent", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });
      const session = await loginAsAdmin();
      const response = await handleRequest(
        new Request(`http://localhost/admin/event/${event.id}/scan`, {
          method: "POST",
          headers: {
            host: "localhost",
            "content-type": "application/json",
            cookie: session.cookie,
          },
          body: JSON.stringify({ token: "test" }),
        }),
      );

      expect(response.status).toBe(403);
    });

    test("returns 400 for malformed JSON body", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });
      const session = await loginAsAdmin();
      const response = await handleRequest(
        new Request(`http://localhost/admin/event/${event.id}/scan`, {
          method: "POST",
          headers: {
            host: "localhost",
            "content-type": "application/json",
            "x-csrf-token": session.csrfToken,
            cookie: session.cookie,
          },
          body: "not valid json{{{",
        }),
      );

      expect(response.status).toBe(400);
      const result = await response.json();
      expect(result.message).toBe("Invalid request body");
    });

    test("returns 500 when private key is unavailable", async () => {
      const { getDb } = await import("#lib/db/client.ts");
      const { invalidateSettingsCache } = await import("#lib/db/settings.ts");
      const event = await createTestEvent({ maxAttendees: 10 });
      const session = await loginAsAdmin();

      // Remove wrapped_private_key from settings to make key derivation fail
      await getDb().execute({
        sql: "DELETE FROM settings WHERE key = 'wrapped_private_key'",
        args: [],
      });
      invalidateSettingsCache();

      const response = await handleRequest(
        mockScanRequest(event.id, { token: "some-token" }, session.cookie, session.csrfToken),
      );

      expect(response.status).toBe(500);
      const result = await response.json();
      expect(result.message).toBe("Decryption unavailable");
    });

    test("logs activity when checking in via scanner", async () => {
      const { event, token, session } = await setupScanTest("Eve", "eve@test.com");
      await handleRequest(
        mockScanRequest(event.id, { token }, session.cookie, session.csrfToken),
      );

      // Check activity log
      const logResponse = await awaitTestRequest(
        `/admin/event/${event.id}/log`,
        { cookie: session.cookie },
      );
      const logBody = await logResponse.text();
      expect(logBody).toContain("checked in via scanner");
    });
  });

  describe("scanner template", () => {
    test("contains CSRF token in meta tag", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });
      const { response } = await adminGet(`/admin/event/${event.id}/scanner`);
      const body = await response.text();
      expect(body).toContain('name="csrf-token"');
    });

    test("contains back link to event page", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });
      const { response } = await adminGet(`/admin/event/${event.id}/scanner`);
      const body = await response.text();
      expect(body).toContain(`/admin/event/${event.id}`);
      expect(body).toContain(event.name);
    });
  });

  describe("GET /scanner.js", () => {
    test("serves scanner JavaScript bundle", async () => {
      const response = await awaitTestRequest("/scanner.js");

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/javascript");
    });
  });

  describe("event page scanner link", () => {
    test("event admin page has scanner link", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });
      const { response } = await adminGet(`/admin/event/${event.id}`);
      const body = await response.text();
      expect(body).toContain(`/admin/event/${event.id}/scanner`);
      expect(body).toContain("Scanner");
    });
  });

  describe("GET /admin/guide", () => {
    test("renders guide page when authenticated", async () => {
      const { response } = await adminGet("/admin/guide");
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain("Guide");
      expect(body).toContain("QR Scanner");
      expect(body).toContain("How do I use the QR scanner?");
      expect(body).toContain("scanner check people out");
    });

    test("redirects to /admin when not authenticated", async () => {
      const response = await awaitTestRequest("/admin/guide");

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin");
    });

    test("nav contains guide link", async () => {
      const { response } = await adminGet("/admin/guide");
      const body = await response.text();
      expect(body).toContain('/admin/guide">Guide</a>');
    });
  });
});
