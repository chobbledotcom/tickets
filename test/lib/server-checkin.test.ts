import { afterEach, beforeEach, describe, expect, test } from "#test-compat";
import { formatDateLabel } from "#lib/dates.ts";
import { createAttendeeAtomic } from "#lib/db/attendees.ts";
import { handleRequest } from "#routes";
import {
  adminGet,
  awaitTestRequest,
  createDailyTestEvent,
  createTestAttendee,
  createTestAttendeeWithToken,
  createTestDbWithSetup,
  createTestEvent,
  getAttendeesRaw,
  getPlaintextTokenFromAttendee,
  loginAsAdmin,
  mockFormRequest,
  resetDb,
  resetTestSlugCounter,
} from "#test-utils";

/** Create attendee + login, returning token + session for check-in tests */
const setupCheckinTest = async (name: string, email: string, eventOverrides = {}, quantity = 1, phone = "") => {
  const { event, token } = await createTestAttendeeWithToken(name, email, eventOverrides, quantity, phone);
  const session = await loginAsAdmin();
  return { event, token, session };
};

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
      const { token } = await createTestAttendeeWithToken("Alice", "alice@test.com");

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
      const { token, session } = await setupCheckinTest("Bob", "bob@test.com");
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
      const { token, session } = await setupCheckinTest("Bob", "bob@test.com", { fields: "email,phone" }, 1, "555-1234");
      const response = await awaitTestRequest(`/checkin/${token}`, {
        cookie: session.cookie,
      });
      const body = await response.text();
      expect(body).toContain("Bob");
      expect(body).toContain("bob@test.com");
      expect(body).toContain("555-1234");
    });

    test("shows multiple attendees from different events", async () => {
      const { event: eventA, token: tokenA } = await createTestAttendeeWithToken("Carol", "carol@test.com");
      const eventB = await createTestEvent({ maxAttendees: 10 });
      await createTestAttendee(eventB.id, eventB.slug, "Carol", "carol@test.com");
      const attendeesB = await getAttendeesRaw(eventB.id);
      // Decrypt the ticket_token to get the plaintext version
      const tokenB = await getPlaintextTokenFromAttendee(attendeesB[0]!);

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
      const { response } = await adminGet("/checkin/bad-token");
      expect(response.status).toBe(404);
    });

    test("shows event name and quantity in admin view", async () => {
      const { event, token, session } = await setupCheckinTest("Dave", "dave@test.com", { maxQuantity: 5 }, 3);
      const response = await awaitTestRequest(`/checkin/${token}`, {
        cookie: session.cookie,
      });
      const body = await response.text();
      expect(body).toContain(event.name);
      expect(body).toContain("3");
    });

    test("links event name to admin event page", async () => {
      const { event, token, session } = await setupCheckinTest("Fay", "fay@test.com");
      const response = await awaitTestRequest(`/checkin/${token}`, {
        cookie: session.cookie,
      });
      const body = await response.text();
      expect(body).toContain(`href="/admin/event/${event.id}"`);
    });

    test("shows green bulk check-in button when not checked in", async () => {
      const { token, session } = await setupCheckinTest("Eve", "eve@test.com");
      const response = await awaitTestRequest(`/checkin/${token}`, {
        cookie: session.cookie,
      });
      const body = await response.text();
      expect(body).toContain('class="bulk-checkin"');
      expect(body).toContain("Check In All");
      expect(body).toContain('value="true"');
    });

    test("displays booked date for daily event in admin view", async () => {
      const event = await createDailyTestEvent({ maxAttendees: 10, maximumDaysAfter: 30 });
      const date = "2026-02-15";
      const result = await createAttendeeAtomic({
        eventId: event.id,
        name: "Zara",
        email: "zara@test.com",
        date,
      });
      if (!result.success) throw new Error("Failed to create attendee");

      const session = await loginAsAdmin();
      const response = await awaitTestRequest(`/checkin/${result.attendee.ticket_token}`, {
        cookie: session.cookie,
      });
      expect(response.status).toBe(200);

      const body = await response.text();
      expect(body).toContain(formatDateLabel(date));
      expect(body).toContain("<th>Date</th>");
    });

    test("shows empty date cell for standard event when combined with daily event", async () => {
      const dailyEvent = await createTestEvent({
        maxAttendees: 10,
        eventType: "daily",
        bookableDays: JSON.stringify(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]),
        minimumDaysBefore: 0,
        maximumDaysAfter: 30,
      });
      const { token: tokenB } = await createTestAttendeeWithToken("Alice", "alice@test.com");
      const date = "2026-02-15";
      const dailyResult = await createAttendeeAtomic({
        eventId: dailyEvent.id,
        name: "Zara",
        email: "zara@test.com",
        date,
      });
      if (!dailyResult.success) throw new Error("Failed to create attendee");
      const tokenA = dailyResult.attendee.ticket_token;

      const session = await loginAsAdmin();
      const response = await awaitTestRequest(`/checkin/${tokenA}+${tokenB}`, {
        cookie: session.cookie,
      });
      const body = await response.text();
      expect(body).toContain("<th>Date</th>");
      expect(body).toContain(formatDateLabel(date));
      // Standard event attendee has no date - empty cell rendered
      expect(body).toContain("Alice");
    });

    test("renders empty email and phone for attendee without contact details", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });
      const result = await createAttendeeAtomic({
        eventId: event.id,
        name: "NoContact",
        email: "",
      });
      if (!result.success) throw new Error("Failed to create attendee");

      const { response } = await adminGet(`/checkin/${result.attendee.ticket_token}`);
      const body = await response.text();
      expect(body).toContain("NoContact");
    });

    test("does not show date column for standard event in admin view", async () => {
      const { token, session } = await setupCheckinTest("Alice", "alice@test.com");
      const response = await awaitTestRequest(`/checkin/${token}`, {
        cookie: session.cookie,
      });
      const body = await response.text();
      expect(body).not.toContain("<th>Date</th>");
    });
  });

  describe("POST /checkin/:tokens", () => {
    test("checks in attendee with check_in=true and shows success", async () => {
      const { token, session } = await setupCheckinTest("Eve", "eve@test.com");
      const response = await handleRequest(
        mockFormRequest(
          `/checkin/${token}`,
          { csrf_token: session.csrfToken, check_in: "true" },
          session.cookie,
        ),
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(`/checkin/${token}?message=Checked%20in`);

      // Follow redirect and verify checked-in state
      const viewResponse = await awaitTestRequest(`/checkin/${token}?message=Checked%20in`, {
        cookie: session.cookie,
      });
      const body = await viewResponse.text();
      expect(body).toContain("Yes");
      expect(body).toContain('class="success"');
      expect(body).toContain("Checked in");
      expect(body).toContain('class="bulk-checkout"');
      expect(body).toContain("Check Out All");
      expect(body).toContain('value="false"');
    });

    test("checks out attendee with check_in=false and shows success", async () => {
      const { token, session } = await setupCheckinTest("Eve", "eve@test.com");

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
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(`/checkin/${token}?message=Checked%20out`);

      // Follow redirect and verify checked-out state
      const viewResponse = await awaitTestRequest(`/checkin/${token}?message=Checked%20out`, {
        cookie: session.cookie,
      });
      const body = await viewResponse.text();
      expect(body).toContain("No");
      expect(body).toContain("Checked out");
    });

    test("duplicate check-in does not undo previous check-in", async () => {
      const { token, session } = await setupCheckinTest("Eve", "eve@test.com");

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
      expect(response.status).toBe(302);

      // Follow redirect and verify still checked in
      const location = response.headers.get("location")!;
      const viewResponse = await awaitTestRequest(location, {
        cookie: session.cookie,
      });
      const body = await viewResponse.text();
      expect(body).toContain("Yes");
    });

    test("redirects to admin for unauthenticated POST", async () => {
      const { token } = await createTestAttendeeWithToken("Frank", "frank@test.com");
      const response = await handleRequest(
        mockFormRequest(`/checkin/${token}`, { csrf_token: "fake" }),
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe("/admin");
    });

    test("returns 403 for invalid CSRF token", async () => {
      const { token, session } = await setupCheckinTest("Grace", "grace@test.com");
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
