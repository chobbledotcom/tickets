import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { getSessionCookieName } from "#shared/cookies.ts";
import { settings } from "#shared/db/settings.ts";
import {
  awaitTestRequest,
  createTestAttendee,
  createTestDb,
  createTestDbWithSetup,
  createTestEvent,
  createTestInvite,
  deactivateTestEvent,
  errorResponse,
  expectRedirectWithFlash,
  expectStatus,
  generateTestEventName,
  getAdminLoginCsrfToken,
  getCsrfTokenFromCookie,
  getJoinCsrfToken,
  getPageCsrfToken,
  getSetupCsrfToken,
  getTicketCsrfToken,
  invalidateTestDbCache,
  loginAsAdmin,
  mockFormRequest,
  mockRequest,
  mockWebhookRequest,
  randomString,
  rawEventRange,
  requireJoinCsrfToken,
  resetDb,
  resetTestSession,
  resetTestSlugCounter,
  setupStripe,
  submitJoinForm,
  submitTicketForm,
  testRequest,
  testWithSetting,
  updateTestEvent,
  useSetting,
  wait,
  withSetting,
} from "#test-utils";

describe("test-utils", () => {
  afterEach(() => {
    resetDb();
  });

  describe("createTestDb", () => {
    test("creates an in-memory database that can execute queries", async () => {
      await createTestDb();
      const { getDb } = await import("#shared/db/client.ts");
      const result = await getDb().execute("SELECT 1 as test");
      expect(result.rows.length).toBe(1);
      expect(result.columns).toContain("test");
    });
  });

  describe("resetDb", () => {
    test("resets database so next createTestDb gives clean state", async () => {
      await createTestDb();
      const { getDb, insert } = await import("#shared/db/client.ts");
      // Insert data into the first DB
      await getDb().execute(
        insert("events", {
          created: "2024-01-01",
          fields: "email",
          max_attendees: 10,
          slug: "old",
          slug_index: "old",
        }),
      );
      resetDb();
      // After reset, we need to set up again to get a working db
      await createTestDb();
      // Data from previous test should be gone
      const result = await getDb().execute("SELECT * FROM events");
      expect(result.rows.length).toBe(0);
    });
  });

  describe("mockRequest", () => {
    test("creates a GET request by default", () => {
      const request = mockRequest("/test");
      expect(request.method).toBe("GET");
      expect(request.url).toBe("http://localhost/test");
    });

    test("accepts custom options", () => {
      const request = mockRequest("/test", { method: "POST" });
      expect(request.method).toBe("POST");
    });
  });

  describe("mockFormRequest", () => {
    test("creates a POST request with form data", async () => {
      const request = mockFormRequest("/test", {
        email: "john@example.com",
        name: "John",
      });
      expect(request.method).toBe("POST");
      expect(request.headers.get("content-type")).toBe(
        "application/x-www-form-urlencoded",
      );

      const body = await request.text();
      expect(body).toContain("name=John");
      expect(body).toContain("email=john%40example.com");
    });

    test("includes cookie when provided", () => {
      const request = mockFormRequest(
        "/test",
        { name: "John" },
        `${getSessionCookieName()}=abc123`,
      );
      expect(request.headers.get("cookie")).toBe(
        `${getSessionCookieName()}=abc123`,
      );
    });
  });

  describe("testRequest", () => {
    test("creates a GET request by default", () => {
      const request = testRequest("/test");
      expect(request.method).toBe("GET");
      expect(request.url).toBe("http://localhost/test");
      expect(request.headers.get("host")).toBe("localhost");
    });

    test("formats session token as cookie", () => {
      const request = testRequest("/admin/logout", "abc123");
      expect(request.headers.get("cookie")).toBe(
        `${getSessionCookieName()}=abc123`,
      );
    });

    test("uses raw cookie string when provided", () => {
      const request = testRequest("/admin/", null, {
        cookie: `${getSessionCookieName()}=xyz; other=value`,
      });
      expect(request.headers.get("cookie")).toBe(
        `${getSessionCookieName()}=xyz; other=value`,
      );
    });

    test("token takes precedence over cookie", () => {
      const request = testRequest("/admin/", "token123", {
        cookie: `${getSessionCookieName()}=other`,
      });
      expect(request.headers.get("cookie")).toBe(
        `${getSessionCookieName()}=token123`,
      );
    });

    test("creates POST request with form data", async () => {
      const request = testRequest("/admin/login", null, {
        data: { password: "secret", username: "admin" },
      });
      expect(request.method).toBe("POST");
      expect(request.headers.get("content-type")).toBe(
        "application/x-www-form-urlencoded",
      );
      const body = await request.text();
      expect(body).toContain("username=admin");
      expect(body).toContain("password=secret");
    });

    test("combines token with form data", async () => {
      const request = testRequest("/admin/event/new", "mytoken", {
        data: { name: "Test Event" },
      });
      expect(request.method).toBe("POST");
      expect(request.headers.get("cookie")).toBe(
        `${getSessionCookieName()}=mytoken`,
      );
      const body = await request.text();
      expect(body).toContain("name=Test+Event");
    });

    test("allows custom method override", () => {
      const request = testRequest("/admin/event/1", "token", {
        method: "DELETE",
      });
      expect(request.method).toBe("DELETE");
    });

    test("allows custom method with form data", async () => {
      const request = testRequest("/admin/event/1", null, {
        data: { name: "Updated" },
        method: "PUT",
      });
      expect(request.method).toBe("PUT");
      const body = await request.text();
      expect(body).toContain("name=Updated");
    });
  });

  describe("randomString", () => {
    test("generates string of specified length", () => {
      const str = randomString(10);
      expect(str.length).toBe(10);
    });

    test("generates alphanumeric string", () => {
      const str = randomString(100);
      expect(str).toMatch(/^[a-zA-Z0-9]+$/);
    });

    test("generates different strings each time", () => {
      const str1 = randomString(20);
      const str2 = randomString(20);
      expect(str1).not.toBe(str2);
    });
  });

  describe("wait", () => {
    test("waits for specified milliseconds", async () => {
      const start = Date.now();
      await wait(50);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(45);
    });
  });

  describe("generateTestEventName", () => {
    test("generates incrementing names", () => {
      resetTestSlugCounter();
      expect(generateTestEventName()).toBe("Test Event 1");
      expect(generateTestEventName()).toBe("Test Event 2");
      expect(generateTestEventName()).toBe("Test Event 3");
    });

    test("resetTestSlugCounter resets counter to 0", () => {
      generateTestEventName(); // Trigger lazy init if needed
      resetTestSlugCounter();
      expect(generateTestEventName()).toBe("Test Event 1");
    });
  });

  describe("awaitTestRequest", () => {
    beforeEach(async () => {
      await createTestDbWithSetup();
    });

    test("makes GET request and returns response", async () => {
      const response = await awaitTestRequest("/admin/");
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Login");
    });

    test("accepts token as second argument", async () => {
      const response = await awaitTestRequest("/admin/", "nonexistent-token");
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Login");
    });

    test("accepts options object as second argument", async () => {
      const response = await awaitTestRequest("/health", {
        data: {},
        method: "POST",
      });
      expect(response.status).toBe(404);
    });

    test("accepts cookie in options", async () => {
      const response = await awaitTestRequest("/admin/", {
        cookie: "session=fake",
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Login");
    });
  });

  describe("getCsrfTokenFromCookie", () => {
    test("returns null when cookie has no session match", async () => {
      const result = await getCsrfTokenFromCookie("other_cookie=value");
      expect(result).toBe(null);
    });

    test("returns null when session token does not exist in database", async () => {
      await createTestDb();
      const result = await getCsrfTokenFromCookie(
        `${getSessionCookieName()}=nonexistent-token-abc`,
      );
      expect(result).toBe(null);
    });

    test("returns csrf_token when session exists", async () => {
      await createTestDb();
      const { createSession } = await import("#shared/db/sessions.ts");
      await createSession(
        "test-sess-token",
        "test-csrf-value",
        Date.now() + 60000,
        null,
        1,
      );
      const result = await getCsrfTokenFromCookie(
        `${getSessionCookieName()}=test-sess-token`,
      );
      expect(result).toBe("test-csrf-value");
    });
  });

  describe("getAdminLoginCsrfToken", () => {
    test("returns null when html is null", () => {
      expect(getAdminLoginCsrfToken(null)).toBe(null);
    });

    test("returns null when html has no csrf_token field", () => {
      expect(getAdminLoginCsrfToken("<form><input type='text'></form>")).toBe(
        null,
      );
    });

    test("extracts csrf_token value from html form", () => {
      expect(
        getAdminLoginCsrfToken('<input name="csrf_token" value="abc123">'),
      ).toBe("abc123");
    });
  });

  describe("getJoinCsrfToken", () => {
    test("returns null when html is null", () => {
      expect(getJoinCsrfToken(null)).toBe(null);
    });

    test("extracts csrf_token value from html form", () => {
      expect(
        getJoinCsrfToken('<input name="csrf_token" value="join-token-123">'),
      ).toBe("join-token-123");
    });
  });

  describe("requireJoinCsrfToken", () => {
    test("throws when html has no csrf_token field", () => {
      expect(() => requireJoinCsrfToken("<form></form>")).toThrow(
        "Failed to get CSRF token for join flow",
      );
    });

    test("returns csrf token when present in html", () => {
      expect(
        requireJoinCsrfToken('<input name="csrf_token" value="abc123">'),
      ).toBe("abc123");
    });
  });

  describe("getSetupCsrfToken", () => {
    test("returns null when html is null", () => {
      expect(getSetupCsrfToken(null)).toBe(null);
    });

    test("returns null when html has no csrf_token field", () => {
      expect(getSetupCsrfToken("<form><input type='text'></form>")).toBe(null);
    });

    test("extracts csrf_token value from html form", () => {
      expect(
        getSetupCsrfToken('<input name="csrf_token" value="setup-token-789">'),
      ).toBe("setup-token-789");
    });
  });

  describe("getTicketCsrfToken", () => {
    test("returns null when html is null", () => {
      expect(getTicketCsrfToken(null)).toBe(null);
    });

    test("returns null when html has no csrf_token field", () => {
      expect(getTicketCsrfToken("<form><input type='text'></form>")).toBe(null);
    });

    test("extracts csrf_token value from html form", () => {
      expect(
        getTicketCsrfToken('<input name="csrf_token" value="ticket-xyz789">'),
      ).toBe("ticket-xyz789");
    });
  });

  describe("submitTicketForm", () => {
    test("submits a ticket form with CSRF token handling", async () => {
      await createTestDbWithSetup();
      const event = await createTestEvent();
      const response = await submitTicketForm(event.slug, {
        email: "test@example.com",
        name: "Test User",
      });
      expect(response.status).toBe(302);
    });

    test("returns error response for non-existent slug", async () => {
      await createTestDbWithSetup();
      // Non-existent slug page has no form, falls back to signed token
      const response = await submitTicketForm("non-existent-slug", {
        email: "t@t.com",
        name: "Test",
      });
      expect(response.status).toBe(404);
    });
  });

  describe("getPageCsrfToken", () => {
    beforeEach(async () => {
      await createTestDb();
    });

    test("returns CSRF token from setup page", async () => {
      const token = await getPageCsrfToken("/setup/");
      expect(token).toMatch(/^s1\./);
    });

    test("throws when page has no CSRF token", async () => {
      await expect(getPageCsrfToken("/health")).rejects.toThrow(
        "Failed to get CSRF token from /health",
      );
    });
  });

  describe("submitJoinForm", () => {
    beforeEach(async () => {
      await createTestDbWithSetup();
    });

    test("completes join flow and redirects to /join/complete", async () => {
      const { inviteCode } = await createTestInvite("joinhelper");
      const response = await submitJoinForm(inviteCode, {
        password: "newpassword123",
        password_confirm: "newpassword123",
      });
      expectRedirectWithFlash(
        "/join/complete",
        "Password set successfully",
      )(response);
    });

    test("returns error response for mismatched passwords", async () => {
      const { inviteCode } = await createTestInvite("joinhelper2");
      const response = await submitJoinForm(inviteCode, {
        password: "password123",
        password_confirm: "different",
      });
      expect(response.status).toBe(302);
    });
  });

  describe("createTestInvite", () => {
    beforeEach(async () => {
      await createTestDbWithSetup();
    });

    test("creates an invite and returns the invite code", async () => {
      const { inviteCode, cookie, csrfToken } =
        await createTestInvite("invitee1");
      expect(inviteCode).toBeTruthy();
      expect(cookie).toContain(`${getSessionCookieName()}=`);
      expect(csrfToken).toMatch(/^s1\./);
    });

    test("throws when invite creation fails (duplicate username)", async () => {
      await createTestInvite("duplicate-user");
      await expect(createTestInvite("duplicate-user")).rejects.toThrow(
        "Failed to create invite",
      );
    });
  });

  describe("setupStripe", () => {
    test("configures Stripe as payment provider", async () => {
      await createTestDbWithSetup();
      await setupStripe();
      const { settings: s } = await import("#shared/db/settings.ts");
      expect(s.paymentProvider).toBe("stripe");
    });

    test("accepts a custom key", async () => {
      await createTestDbWithSetup();
      await setupStripe("sk_test_custom");
      const { settings: s } = await import("#shared/db/settings.ts");
      expect(s.paymentProvider).toBe("stripe");
    });
  });

  describe("mockWebhookRequest", () => {
    test("creates a POST request to /payment/webhook", () => {
      const req = mockWebhookRequest({ type: "test" });
      expect(req.method).toBe("POST");
      expect(new URL(req.url).pathname).toBe("/payment/webhook");
      expect(req.headers.get("content-type")).toBe("application/json");
    });

    test("includes custom headers", () => {
      const req = mockWebhookRequest({}, { "stripe-signature": "sig_123" });
      expect(req.headers.get("stripe-signature")).toBe("sig_123");
      expect(req.headers.get("host")).toBe("localhost");
    });
  });

  describe("loginAsAdmin", () => {
    beforeEach(async () => {
      await createTestDbWithSetup();
    });

    test("returns cookie and CSRF token after successful login", async () => {
      const session = await loginAsAdmin();
      expect(session.cookie).toContain(`${getSessionCookieName()}=`);
      expect(session.csrfToken).toBeTruthy();
      expect(typeof session.csrfToken).toBe("string");
    });
  });

  describe("createTestEvent", () => {
    beforeEach(async () => {
      await createTestDbWithSetup();
    });

    test("creates an event with thankYouUrl override", async () => {
      const event = await createTestEvent({
        thankYouUrl: "https://custom.example.com/done",
      });
      expect(event.thank_you_url).toBe("https://custom.example.com/done");
      expect(event.slug).toBeTruthy();
    });

    test("creates an event with default settings", async () => {
      const event = await createTestEvent();
      expect(event.id).toBeGreaterThan(0);
      expect(event.max_attendees).toBe(100);
      expect(event.active).toBe(true);
    });

    test("creates an event with maxPrice", async () => {
      const event = await createTestEvent({ maxPrice: 5000 });
      expect(event.max_price).toBe(5000);
    });
  });

  describe("updateTestEvent", () => {
    beforeEach(async () => {
      await createTestDbWithSetup();
    });

    test("updates event fields via the REST API", async () => {
      const event = await createTestEvent();
      const updated = await updateTestEvent(event.id, {
        maxAttendees: 200,
        thankYouUrl: "https://thanks.example.com",
        unitPrice: 1500,
        webhookUrl: "https://hook.example.com",
      });
      expect(updated.max_attendees).toBe(200);
      expect(updated.unit_price).toBe(1500);
      expect(updated.webhook_url).toBe("https://hook.example.com");
      expect(updated.thank_you_url).toBe("https://thanks.example.com");
    });

    test("throws when event does not exist", async () => {
      await expect(
        updateTestEvent(99999, { maxAttendees: 50 }),
      ).rejects.toThrow("Event not found: 99999");
    });

    test("preserves existing values when updates are partial", async () => {
      const event = await createTestEvent({
        thankYouUrl: "https://original.example.com",
      });
      const updated = await updateTestEvent(event.id, {
        maxAttendees: 50,
      });
      expect(updated.max_attendees).toBe(50);
      expect(updated.thank_you_url).toBe("https://original.example.com");
    });

    test("clears fields when set to zero/empty", async () => {
      const event = await createTestEvent({
        unitPrice: 1000,
        webhookUrl: "https://hook.example.com",
      });
      const updated = await updateTestEvent(event.id, {
        unitPrice: 0,
        webhookUrl: "",
      });
      expect(updated.unit_price).toBe(0);
      expect(updated.webhook_url).toBe("");
    });

    test("updates max_price when explicitly set", async () => {
      const event = await createTestEvent();
      const updated = await updateTestEvent(event.id, { maxPrice: 7500 });
      expect(updated.max_price).toBe(7500);
    });

    test("preserves existing max_price when not specified in update", async () => {
      const event = await createTestEvent({ maxPrice: 3000 });
      const updated = await updateTestEvent(event.id, { maxAttendees: 50 });
      expect(updated.max_price).toBe(3000);
    });
  });

  describe("deactivateTestEvent", () => {
    beforeEach(async () => {
      await createTestDbWithSetup();
    });

    test("throws when event does not exist", async () => {
      await expect(deactivateTestEvent(99999)).rejects.toThrow(
        "Event not found: 99999",
      );
    });

    test("deactivates an existing event", async () => {
      const event = await createTestEvent();
      expect(event.active).toBe(true);
      await deactivateTestEvent(event.id);
      const { getEventWithCount } = await import("#shared/db/events.ts");
      const updated = await getEventWithCount(event.id);
      expect(updated!.active).toBe(false);
    });
  });

  describe("createTestAttendee", () => {
    beforeEach(async () => {
      await createTestDbWithSetup();
    });

    test("creates an attendee via the public ticket form", async () => {
      const event = await createTestEvent();
      const attendee = await createTestAttendee(
        event.id,
        event.slug,
        "Jane Doe",
        "jane@example.com",
      );
      expect(attendee.id).toBeGreaterThan(0);
      expect(attendee.event_id).toBe(event.id);
      expect(attendee.quantity).toBe(1);
    });

    test("creates an attendee with custom quantity", async () => {
      const event = await createTestEvent({ maxAttendees: 10, maxQuantity: 5 });
      const attendee = await createTestAttendee(
        event.id,
        event.slug,
        "Bob Smith",
        "bob@example.com",
        3,
      );
      expect(attendee.quantity).toBe(3);
    });
  });

  describe("createTestAttendeeDirect", () => {
    beforeEach(async () => {
      await createTestDbWithSetup();
    });

    test("creates an attendee directly and returns plaintext token", async () => {
      const { createTestAttendeeDirect } = await import("#test-utils");
      const event = await createTestEvent();
      const { attendee, token } = await createTestAttendeeDirect(
        event.id,
        "Test User",
        "test@example.com",
      );
      expect(attendee.id).toBeGreaterThan(0);
      expect(attendee.event_id).toBe(event.id);
      expect(token).toBeTruthy();
      expect(typeof token).toBe("string");
    });

    test("throws error when capacity is exceeded", async () => {
      const { createTestAttendeeDirect } = await import("#test-utils");
      const event = await createTestEvent({ maxAttendees: 1 });

      // Fill the event
      await createTestAttendeeDirect(event.id, "First", "first@example.com");

      // Second attendee should fail
      await expect(
        createTestAttendeeDirect(event.id, "Second", "second@example.com"),
      ).rejects.toThrow("Failed to create attendee");
    });
  });

  describe("rawEventRange", () => {
    beforeEach(async () => {
      await createTestDbWithSetup();
    });

    test("returns start_at/end_at/quantity for the first booking", async () => {
      const { createDailyTestEvent } = await import("#test-utils");
      const { createAttendeeAtomic } = await import("#shared/db/attendees.ts");
      const event = await createDailyTestEvent({ maxAttendees: 10 });
      const result = await createAttendeeAtomic({
        bookings: [{ date: "2026-05-01", eventId: event.id, quantity: 3 }],
        email: "alice@test.com",
        name: "Alice",
      });
      if (!result.success) throw new Error("create failed");

      const range = await rawEventRange(event.id);
      expect(range).not.toBeNull();
      expect(range!.start_at).toBe("2026-05-01T00:00:00Z");
      expect(range!.end_at).toBe("2026-05-02T00:00:00.000Z");
      expect(range!.quantity).toBe(3);
    });

    test("returns null when no bookings exist for the event", async () => {
      const event = await createTestEvent();
      expect(await rawEventRange(event.id)).toBeNull();
    });
  });

  describe("expectStatus", () => {
    test("returns the response when status matches", () => {
      const response = new Response("ok", { status: 200 });
      const result = expectStatus(200)(response);
      expect(result).toBe(response);
    });

    test("works with different status codes", () => {
      const response = new Response(null, { status: 404 });
      const result = expectStatus(404)(response);
      expect(result).toBe(response);
    });
  });

  describe("errorResponse", () => {
    test("creates a response factory with given status", () => {
      const make500 = errorResponse(500);
      const response = make500("Internal Server Error");
      expect(response.status).toBe(500);
    });

    test("includes the error message in the response body", async () => {
      const make400 = errorResponse(400);
      const response = make400("Bad Request");
      const body = await response.text();
      expect(body).toBe("Bad Request");
    });
  });

  describe("loginAsAdmin error path", () => {
    test("throws when CSRF token cannot be obtained from login response", async () => {
      // createTestDb without setup means no admin password exists
      // so login will fail and no session cookie is set
      await createTestDb();
      await expect(loginAsAdmin()).rejects.toThrow(
        "Failed to get CSRF token for admin login",
      );
    });
  });

  describe("getTestSession fallback to loginAsAdmin", () => {
    beforeEach(async () => {
      await createTestDbWithSetup();
    });

    test("falls back to loginAsAdmin when cached admin session is cleared", async () => {
      // Clear testSession and cachedAdminSession, but leave db working
      resetTestSession();
      invalidateTestDbCache();
      // createTestEvent uses getTestSession internally
      // With cachedAdminSession null, it falls through to loginAsAdmin
      const event = await createTestEvent();
      expect(event.id).toBeGreaterThan(0);
    });
  });

  describe("authenticatedFormRequest and createTestEvent error paths", () => {
    beforeEach(async () => {
      await createTestDbWithSetup();
    });

    test("createTestEvent throws on validation failure when name is empty", async () => {
      // Empty name triggers validation failure, returning 400 instead of 302
      await expect(createTestEvent({ name: "" })).rejects.toThrow(
        "Failed to create event: 400",
      );
    });

    test("authenticatedFormRequest throws on non-302 response via update", async () => {
      // Update with empty name triggers validation failure.
      // The update handler returns a 200 error page (not 302) on validation failure.
      const event = await createTestEvent();
      await expect(updateTestEvent(event.id, { name: "" })).rejects.toThrow(
        "Failed to update event",
      );
    });
  });

  describe("formatPrice coverage", () => {
    beforeEach(async () => {
      await createTestDbWithSetup();
    });

    test("preserves existing unitPrice when update does not specify unitPrice", async () => {
      // Create event with a unit price
      const event = await createTestEvent({ unitPrice: 2500 });
      expect(event.unit_price).toBe(2500);
      // Update without specifying unitPrice -> formatPrice(undefined, 2500)
      // This covers the branch: existing != null ? String(existing) : ""
      const updated = await updateTestEvent(event.id, { maxAttendees: 50 });
      expect(updated.unit_price).toBe(2500);
      expect(updated.max_attendees).toBe(50);
    });

    test("preserves existing closesAt when update does not specify closesAt", async () => {
      const event = await createTestEvent({ closesAt: "2099-06-15T14:30" });
      expect(event.closes_at).toBe("2099-06-15T14:30:00.000Z");
      const updated = await updateTestEvent(event.id, { maxAttendees: 50 });
      expect(updated.closes_at).toBe("2099-06-15T14:30:00.000Z");
      expect(updated.max_attendees).toBe(50);
    });
  });

  describe("createTestEvent with null thankYouUrl", () => {
    beforeEach(async () => {
      await createTestDbWithSetup();
    });

    test("creates event without thankYouUrl using ?? empty string fallback", async () => {
      const event = await createTestEvent({ thankYouUrl: undefined });
      expect(event.id).toBeGreaterThan(0);
      // thankYouUrl: undefined triggers the default empty string
      expect(event.thank_you_url).toBe("");
    });
  });

  describe("createTestAttendee error paths", () => {
    beforeEach(async () => {
      await createTestDbWithSetup();
    });

    test("throws when event is deactivated", async () => {
      const event = await createTestEvent();
      await deactivateTestEvent(event.id);
      await expect(
        createTestAttendee(event.id, event.slug, "Test", "test@example.com"),
      ).rejects.toThrow("Failed to create attendee");
    });

    test("throws when form submission returns error status (event at capacity)", async () => {
      const event = await createTestEvent({
        maxAttendees: 1,
        maxQuantity: 1,
      });
      // Fill the event
      await createTestAttendee(
        event.id,
        event.slug,
        "First",
        "first@example.com",
      );
      // Second attendee should fail because event is full
      await expect(
        createTestAttendee(
          event.id,
          event.slug,
          "Second",
          "second@example.com",
        ),
      ).rejects.toThrow("Failed to create attendee");
    });
  });

  describe("updateTestEvent event not found after update", () => {
    beforeEach(async () => {
      await createTestDbWithSetup();
    });

    test("throws when event does not exist", async () => {
      await expect(
        updateTestEvent(99999, { maxAttendees: 50 }),
      ).rejects.toThrow("Event not found: 99999");
    });
  });

  describe("withSetting", () => {
    afterEach(() => {
      settings.clearTestOverrides();
    });

    test("applies the override while fn is running", async () => {
      let currencyDuringFn: string | undefined;
      await withSetting({ currency: "JPY" }, () => {
        currencyDuringFn = settings.currency;
      });
      expect(currencyDuringFn).toBe("JPY");
    });

    test("clears the override after fn returns", async () => {
      await withSetting({ currency: "JPY" }, () => {});
      expect("currency" in settings).toBe(true);
      expect(settings.currency).not.toBe("JPY");
    });

    test("clears the override even when fn throws", async () => {
      await expect(
        withSetting({ currency: "JPY" }, () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(settings.currency).not.toBe("JPY");
    });

    test("returns the value produced by fn", async () => {
      const result = await withSetting({ currency: "GBP" }, () => 42);
      expect(result).toBe(42);
    });

    test("awaits async callbacks before clearing", async () => {
      let currencyMidFlight: string | undefined;
      await withSetting({ currency: "EUR" }, async () => {
        await wait(1);
        currencyMidFlight = settings.currency;
      });
      expect(currencyMidFlight).toBe("EUR");
      expect(settings.currency).not.toBe("EUR");
    });

    test("applies multiple overrides at once", async () => {
      const seen: Record<string, unknown> = {};
      await withSetting({ currency: "USD", show_public_site: true }, () => {
        seen.currency = settings.currency;
        seen.showPublicSite = settings.showPublicSite;
      });
      expect(seen.currency).toBe("USD");
      expect(seen.showPublicSite).toBe(true);
      expect(settings.currency).not.toBe("USD");
      expect(settings.showPublicSite).not.toBe(true);
    });
  });

  describe("useSetting", () => {
    describe("inside a scoped describe", () => {
      useSetting({ currency: "JPY" });

      test("override is active in tests", () => {
        expect(settings.currency).toBe("JPY");
      });

      test("override persists across tests in the same scope", () => {
        expect(settings.currency).toBe("JPY");
      });
    });

    test("override does not leak outside the scoped describe", () => {
      expect(settings.currency).not.toBe("JPY");
    });
  });

  describe("testWithSetting", () => {
    testWithSetting(
      "override is active inside the declared test",
      { currency: "EUR" },
      () => {
        expect(settings.currency).toBe("EUR");
      },
    );

    testWithSetting(
      "supports async test bodies",
      { currency: "JPY" },
      async () => {
        await wait(1);
        expect(settings.currency).toBe("JPY");
      },
    );

    test("override does not leak to sibling tests", () => {
      expect(settings.currency).not.toBe("EUR");
      expect(settings.currency).not.toBe("JPY");
    });
  });
});
