/**
 * Tests for the QR scanner admin feature
 * GET /admin/event/:id/scanner - Scanner page
 * POST /admin/event/:id/scan - JSON check-in API
 */

import { afterEach, beforeEach, describe, expect, test } from "#test-compat";
import {
  awaitTestRequest,
  createTestAttendee,
  createTestEvent,
  getAttendeesRaw,
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
      const { handleRequest } = await import("#routes");
      const event = await createTestEvent({ maxAttendees: 10 });
      const session = await loginAsAdmin();

      const response = await handleRequest(
        mockScanRequest(event.id, { token: "nonexistent" }, session.cookie, session.csrfToken),
      );

      // Should not be 400 (Content-Type rejection) - it should process the request
      expect(response.status).not.toBe(400);
    });

    test("rejects non-JSON content type for scan endpoint", async () => {
      const { handleRequest } = await import("#routes");
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
      const session = await loginAsAdmin();

      const response = await awaitTestRequest(
        `/admin/event/${event.id}/scanner`,
        { cookie: session.cookie },
      );

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

      const response = await awaitTestRequest(
        `/admin/event/${event.id}/scanner`,
      );

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin");
    });

    test("returns 404 for non-existent event", async () => {
      const session = await loginAsAdmin();

      const response = await awaitTestRequest(
        "/admin/event/99999/scanner",
        { cookie: session.cookie },
      );

      expect(response.status).toBe(404);
    });
  });

  describe("POST /admin/event/:id/scan", () => {
    test("checks in attendee from same event", async () => {
      const { handleRequest } = await import("#routes");
      const event = await createTestEvent({ maxAttendees: 10 });
      await createTestAttendee(event.id, event.slug, "Alice", "alice@test.com");
      const attendees = await getAttendeesRaw(event.id);
      const token = attendees[0]!.ticket_token;

      const session = await loginAsAdmin();
      const response = await handleRequest(
        mockScanRequest(event.id, { token }, session.cookie, session.csrfToken),
      );

      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.status).toBe("checked_in");
      expect(result.name).toBe("Alice");
    });

    test("returns already_checked_in for checked-in attendee", async () => {
      const { handleRequest } = await import("#routes");
      const event = await createTestEvent({ maxAttendees: 10 });
      await createTestAttendee(event.id, event.slug, "Bob", "bob@test.com");
      const attendees = await getAttendeesRaw(event.id);
      const token = attendees[0]!.ticket_token;

      const session = await loginAsAdmin();

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
      const { handleRequest } = await import("#routes");
      const eventA = await createTestEvent({ maxAttendees: 10 });
      const eventB = await createTestEvent({ maxAttendees: 10 });
      await createTestAttendee(eventA.id, eventA.slug, "Carol", "carol@test.com");
      const attendees = await getAttendeesRaw(eventA.id);
      const token = attendees[0]!.ticket_token;

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
      const { handleRequest } = await import("#routes");
      const eventA = await createTestEvent({ maxAttendees: 10 });
      const eventB = await createTestEvent({ maxAttendees: 10 });
      await createTestAttendee(eventA.id, eventA.slug, "Dave", "dave@test.com");
      const attendees = await getAttendeesRaw(eventA.id);
      const token = attendees[0]!.ticket_token;

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

    test("returns not_found for invalid token", async () => {
      const { handleRequest } = await import("#routes");
      const event = await createTestEvent({ maxAttendees: 10 });

      const session = await loginAsAdmin();
      const response = await handleRequest(
        mockScanRequest(event.id, { token: "nonexistent-token" }, session.cookie, session.csrfToken),
      );

      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.status).toBe("not_found");
    });

    test("returns 401 when not authenticated", async () => {
      const { handleRequest } = await import("#routes");
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
      const { handleRequest } = await import("#routes");
      const event = await createTestEvent({ maxAttendees: 10 });

      const session = await loginAsAdmin();
      const response = await handleRequest(
        mockScanRequest(event.id, { token: "test" }, session.cookie, "wrong-csrf-token"),
      );

      expect(response.status).toBe(403);
    });

    test("returns 400 for missing token in body", async () => {
      const { handleRequest } = await import("#routes");
      const event = await createTestEvent({ maxAttendees: 10 });

      const session = await loginAsAdmin();
      const response = await handleRequest(
        mockScanRequest(event.id, {}, session.cookie, session.csrfToken),
      );

      expect(response.status).toBe(400);
    });

    test("logs activity when checking in via scanner", async () => {
      const { handleRequest } = await import("#routes");
      const event = await createTestEvent({ maxAttendees: 10 });
      await createTestAttendee(event.id, event.slug, "Eve", "eve@test.com");
      const attendees = await getAttendeesRaw(event.id);
      const token = attendees[0]!.ticket_token;

      const session = await loginAsAdmin();
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
    test("contains CSRF token in data attribute", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });
      const session = await loginAsAdmin();

      const response = await awaitTestRequest(
        `/admin/event/${event.id}/scanner`,
        { cookie: session.cookie },
      );

      const body = await response.text();
      expect(body).toContain("data-csrf-token=");
    });

    test("contains back link to event page", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });
      const session = await loginAsAdmin();

      const response = await awaitTestRequest(
        `/admin/event/${event.id}/scanner`,
        { cookie: session.cookie },
      );

      const body = await response.text();
      expect(body).toContain(`/admin/event/${event.id}`);
      expect(body).toContain(event.name);
    });
  });

  describe("event page scanner link", () => {
    test("event admin page has scanner link", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });
      const session = await loginAsAdmin();

      const response = await awaitTestRequest(
        `/admin/event/${event.id}`,
        { cookie: session.cookie },
      );

      const body = await response.text();
      expect(body).toContain(`/admin/event/${event.id}/scanner`);
      expect(body).toContain("Scanner");
    });
  });
});
