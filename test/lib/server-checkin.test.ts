import { afterEach, beforeEach, describe, expect, test } from "#test-compat";
import {
  awaitTestRequest,
  createTestAttendee,
  createTestDbWithSetup,
  createTestEvent,
  getAttendeesRaw,
  loginAsAdmin,
  mockFormRequest,
  resetDb,
  resetTestSlugCounter,
} from "#test-utils";

describe("check-in (/checkin/:tokens)", () => {
  beforeEach(async () => {
    resetTestSlugCounter();
    await createTestDbWithSetup();
  });

  afterEach(() => {
    resetDb();
  });

  describe("GET /checkin/:tokens (unauthenticated)", () => {
    test("shows public check-in message for unauthenticated users", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });
      await createTestAttendee(event.id, event.slug, "Alice", "alice@test.com");
      const attendees = await getAttendeesRaw(event.id);
      const token = attendees[0]!.ticket_token;

      const response = await awaitTestRequest(`/checkin/${token}`);
      expect(response.status).toBe(200);

      const body = await response.text();
      expect(body).toContain("Check-in");
      expect(body).toContain("show this QR code");
    });

    test("returns 404 for invalid token", async () => {
      const response = await awaitTestRequest("/checkin/bad-token");
      expect(response.status).toBe(404);
    });
  });

  describe("GET /checkin/:tokens (authenticated admin)", () => {
    test("shows current status without auto-checking-in", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });
      await createTestAttendee(event.id, event.slug, "Bob", "bob@test.com");
      const attendees = await getAttendeesRaw(event.id);
      const token = attendees[0]!.ticket_token;

      const session = await loginAsAdmin();
      const response = await awaitTestRequest(`/checkin/${token}`, {
        cookie: session.cookie,
      });
      expect(response.status).toBe(200);

      const body = await response.text();
      expect(body).toContain("No");
      expect(body).toContain("Check In All");
      expect(body).not.toContain('class="success"');
    });

    test("shows attendee contact details in admin view", async () => {
      const event = await createTestEvent({ maxAttendees: 10, fields: "both" });
      await createTestAttendee(event.id, event.slug, "Bob", "bob@test.com", 1, "555-1234");
      const attendees = await getAttendeesRaw(event.id);
      const token = attendees[0]!.ticket_token;

      const session = await loginAsAdmin();
      const response = await awaitTestRequest(`/checkin/${token}`, {
        cookie: session.cookie,
      });
      const body = await response.text();
      expect(body).toContain("Bob");
      expect(body).toContain("bob@test.com");
      expect(body).toContain("555-1234");
    });

    test("shows multiple attendees from different events", async () => {
      const eventA = await createTestEvent({ maxAttendees: 10 });
      const eventB = await createTestEvent({ maxAttendees: 10 });
      await createTestAttendee(eventA.id, eventA.slug, "Carol", "carol@test.com");
      await createTestAttendee(eventB.id, eventB.slug, "Carol", "carol@test.com");
      const attendeesA = await getAttendeesRaw(eventA.id);
      const attendeesB = await getAttendeesRaw(eventB.id);
      const tokenA = attendeesA[0]!.ticket_token;
      const tokenB = attendeesB[0]!.ticket_token;

      const session = await loginAsAdmin();
      const response = await awaitTestRequest(`/checkin/${tokenA}+${tokenB}`, {
        cookie: session.cookie,
      });
      expect(response.status).toBe(200);

      const body = await response.text();
      expect(body).toContain(eventA.name);
      expect(body).toContain(eventB.name);
    });

    test("returns 404 for invalid tokens when authenticated", async () => {
      const session = await loginAsAdmin();
      const response = await awaitTestRequest("/checkin/bad-token", {
        cookie: session.cookie,
      });
      expect(response.status).toBe(404);
    });

    test("shows event name and quantity in admin view", async () => {
      const event = await createTestEvent({ maxAttendees: 10, maxQuantity: 5 });
      await createTestAttendee(event.id, event.slug, "Dave", "dave@test.com", 3);
      const attendees = await getAttendeesRaw(event.id);
      const token = attendees[0]!.ticket_token;

      const session = await loginAsAdmin();
      const response = await awaitTestRequest(`/checkin/${token}`, {
        cookie: session.cookie,
      });
      const body = await response.text();
      expect(body).toContain(event.name);
      expect(body).toContain("3");
    });

    test("links event name to admin event page", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });
      await createTestAttendee(event.id, event.slug, "Fay", "fay@test.com");
      const attendees = await getAttendeesRaw(event.id);
      const token = attendees[0]!.ticket_token;

      const session = await loginAsAdmin();
      const response = await awaitTestRequest(`/checkin/${token}`, {
        cookie: session.cookie,
      });
      const body = await response.text();
      expect(body).toContain(`href="/admin/event/${event.id}"`);
    });

    test("shows green bulk check-in button when not checked in", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });
      await createTestAttendee(event.id, event.slug, "Eve", "eve@test.com");
      const attendees = await getAttendeesRaw(event.id);
      const token = attendees[0]!.ticket_token;

      const session = await loginAsAdmin();
      const response = await awaitTestRequest(`/checkin/${token}`, {
        cookie: session.cookie,
      });
      const body = await response.text();
      expect(body).toContain('class="bulk-checkin"');
      expect(body).toContain("Check In All");
      expect(body).toContain('value="true"');
    });
  });

  describe("POST /checkin/:tokens", () => {
    test("checks in attendee with check_in=true and shows success", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });
      await createTestAttendee(event.id, event.slug, "Eve", "eve@test.com");
      const attendees = await getAttendeesRaw(event.id);
      const token = attendees[0]!.ticket_token;

      const session = await loginAsAdmin();
      const { handleRequest } = await import("#routes");
      const response = await handleRequest(
        mockFormRequest(
          `/checkin/${token}`,
          { csrf_token: session.csrfToken, check_in: "true" },
          session.cookie,
        ),
      );
      expect(response.status).toBe(200);

      const body = await response.text();
      expect(body).toContain("Yes");
      expect(body).toContain('class="success"');
      expect(body).toContain("Checked in");
      expect(body).toContain('class="bulk-checkout"');
      expect(body).toContain("Check Out All");
      expect(body).toContain('value="false"');
    });

    test("checks out attendee with check_in=false and shows success", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });
      await createTestAttendee(event.id, event.slug, "Eve", "eve@test.com");
      const attendees = await getAttendeesRaw(event.id);
      const token = attendees[0]!.ticket_token;

      const session = await loginAsAdmin();
      const { handleRequest } = await import("#routes");

      // First check in
      await handleRequest(
        mockFormRequest(
          `/checkin/${token}`,
          { csrf_token: session.csrfToken, check_in: "true" },
          session.cookie,
        ),
      );

      // Then check out
      const response = await handleRequest(
        mockFormRequest(
          `/checkin/${token}`,
          { csrf_token: session.csrfToken, check_in: "false" },
          session.cookie,
        ),
      );
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain("No");
      expect(body).toContain("Checked out");
    });

    test("duplicate check-in does not undo previous check-in", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });
      await createTestAttendee(event.id, event.slug, "Eve", "eve@test.com");
      const attendees = await getAttendeesRaw(event.id);
      const token = attendees[0]!.ticket_token;

      const session = await loginAsAdmin();
      const { handleRequest } = await import("#routes");

      // Check in twice (simulates two tabs)
      await handleRequest(
        mockFormRequest(
          `/checkin/${token}`,
          { csrf_token: session.csrfToken, check_in: "true" },
          session.cookie,
        ),
      );
      const response = await handleRequest(
        mockFormRequest(
          `/checkin/${token}`,
          { csrf_token: session.csrfToken, check_in: "true" },
          session.cookie,
        ),
      );
      expect(response.status).toBe(200);

      const body = await response.text();
      expect(body).toContain("Yes");
    });

    test("redirects to admin for unauthenticated POST", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });
      await createTestAttendee(event.id, event.slug, "Frank", "frank@test.com");
      const attendees = await getAttendeesRaw(event.id);
      const token = attendees[0]!.ticket_token;

      const { handleRequest } = await import("#routes");
      const response = await handleRequest(
        mockFormRequest(`/checkin/${token}`, { csrf_token: "fake" }),
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe("/admin");
    });

    test("returns 403 for invalid CSRF token", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });
      await createTestAttendee(event.id, event.slug, "Grace", "grace@test.com");
      const attendees = await getAttendeesRaw(event.id);
      const token = attendees[0]!.ticket_token;

      const session = await loginAsAdmin();
      const { handleRequest } = await import("#routes");
      const response = await handleRequest(
        mockFormRequest(
          `/checkin/${token}`,
          { csrf_token: "wrong-token" },
          session.cookie,
        ),
      );
      expect(response.status).toBe(403);
    });

    test("returns 404 for invalid tokens on POST", async () => {
      const session = await loginAsAdmin();
      const { handleRequest } = await import("#routes");
      const response = await handleRequest(
        mockFormRequest(
          "/checkin/bad-token",
          { csrf_token: session.csrfToken },
          session.cookie,
        ),
      );
      expect(response.status).toBe(404);
    });
  });

  describe("route matching", () => {
    test("returns null for non-matching paths", async () => {
      const { routeCheckin } = await import("#routes/checkin.ts");
      const request = new Request("http://localhost/other");
      const result = await routeCheckin(request, "/other", "GET");
      expect(result).toBeNull();
    });

    test("returns null for unsupported methods", async () => {
      const { routeCheckin } = await import("#routes/checkin.ts");
      const request = new Request("http://localhost/checkin/tok", { method: "PUT" });
      const result = await routeCheckin(request, "/checkin/tok", "PUT");
      expect(result).toBeNull();
    });
  });
});
