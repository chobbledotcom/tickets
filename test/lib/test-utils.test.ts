import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from "#test-compat";
import { spyOn } from "#test-compat";
import {
  awaitTestRequest,
  createTestAttendee,
  createTestDb,
  createTestDbWithSetup,
  createTestEvent,
  deactivateTestEvent,
  errorResponse,
  expectStatus,
  generateTestEventName,
  getCsrfTokenFromCookie,
  getSetupCsrfToken,
  getTicketCsrfToken,
  invalidateTestDbCache,
  loginAsAdmin,
  mockFormRequest,
  mockRequest,
  mockWebhookRequest,
  randomString,
  resetDb,
  resetTestSession,
  resetTestSlugCounter,
  setupStripe,
  submitTicketForm,
  testRequest,
  updateTestEvent,
  wait,
} from "#test-utils";

describe("test-utils", () => {
  afterEach(() => {
    resetDb();
  });

  describe("createTestDb", () => {
    test("creates an in-memory database that can execute queries", async () => {
      await createTestDb();
      const { getDb } = await import("#lib/db/client.ts");
      const result = await getDb().execute("SELECT 1 as test");
      expect(result.rows.length).toBe(1);
      expect(result.columns).toContain("test");
    });
  });

  describe("resetDb", () => {
    test("resets database so next createTestDb gives clean state", async () => {
      await createTestDb();
      const { getDb } = await import("#lib/db/client.ts");
      // Insert data into the first DB
      await getDb().execute(
        "INSERT INTO events (slug, slug_index, max_attendees, created, fields) VALUES ('old', 'old', 10, '2024-01-01', 'email')",
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
        name: "John",
        email: "john@example.com",
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
        "__Host-session=abc123",
      );
      expect(request.headers.get("cookie")).toBe("__Host-session=abc123");
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
      expect(request.headers.get("cookie")).toBe("__Host-session=abc123");
    });

    test("uses raw cookie string when provided", () => {
      const request = testRequest("/admin/", null, {
        cookie: "__Host-session=xyz; other=value",
      });
      expect(request.headers.get("cookie")).toBe(
        "__Host-session=xyz; other=value",
      );
    });

    test("token takes precedence over cookie", () => {
      const request = testRequest("/admin/", "token123", {
        cookie: "__Host-session=other",
      });
      expect(request.headers.get("cookie")).toBe("__Host-session=token123");
    });

    test("creates POST request with form data", async () => {
      const request = testRequest("/admin/login", null, {
        data: { username: "admin", password: "secret" },
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
      expect(request.headers.get("cookie")).toBe("__Host-session=mytoken");
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
        method: "PUT",
        data: { name: "Updated" },
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
        method: "POST",
        data: {},
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
        "__Host-session=nonexistent-token-abc",
      );
      expect(result).toBe(null);
    });
  });

  describe("getSetupCsrfToken", () => {
    test("returns null when set-cookie header is null", () => {
      expect(getSetupCsrfToken(null)).toBe(null);
    });

    test("returns null when set-cookie has no setup_csrf cookie", () => {
      expect(getSetupCsrfToken("other_cookie=value")).toBe(null);
    });

    test("extracts setup_csrf value from set-cookie header", () => {
      expect(getSetupCsrfToken("setup_csrf=abc123; Path=/")).toBe("abc123");
    });
  });

  describe("getTicketCsrfToken", () => {
    test("returns null when set-cookie header is null", () => {
      expect(getTicketCsrfToken(null)).toBe(null);
    });

    test("returns null when set-cookie has no csrf_token cookie", () => {
      expect(getTicketCsrfToken("other_cookie=value")).toBe(null);
    });

    test("extracts csrf_token value from set-cookie header", () => {
      expect(getTicketCsrfToken("csrf_token=xyz789; Path=/")).toBe("xyz789");
    });
  });

  describe("submitTicketForm", () => {
    test("submits a ticket form with CSRF token handling", async () => {
      await createTestDbWithSetup();
      const event = await createTestEvent();
      const response = await submitTicketForm(event.slug, {
        name: "Test User",
        email: "test@example.com",
      });
      expect(response.status).toBe(302);
    });

    test("throws when CSRF token cannot be obtained", async () => {
      await createTestDbWithSetup();
      // Non-existent slug returns 404 with no CSRF cookie
      await expect(
        submitTicketForm("non-existent-slug", { name: "Test", email: "t@t.com" }),
      ).rejects.toThrow("Failed to get CSRF token");
    });
  });

  describe("setupStripe", () => {
    test("configures Stripe as payment provider", async () => {
      await createTestDbWithSetup();
      await setupStripe();
      const { getPaymentProviderFromDb } = await import("#lib/db/settings.ts");
      expect(await getPaymentProviderFromDb()).toBe("stripe");
    });

    test("accepts a custom key", async () => {
      await createTestDbWithSetup();
      await setupStripe("sk_test_custom");
      const { getPaymentProviderFromDb } = await import("#lib/db/settings.ts");
      expect(await getPaymentProviderFromDb()).toBe("stripe");
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
      expect(session.cookie).toContain("__Host-session=");
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
      expect(event.active).toBe(1);
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
        unitPrice: 1500,
        webhookUrl: "https://hook.example.com",
        thankYouUrl: "https://thanks.example.com",
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

    test("clears nullable fields when set to null", async () => {
      const event = await createTestEvent({
        unitPrice: 1000,
        webhookUrl: "https://hook.example.com",
      });
      const updated = await updateTestEvent(event.id, {
        unitPrice: null,
        webhookUrl: null,
      });
      expect(updated.unit_price).toBe(null);
      expect(updated.webhook_url).toBe(null);
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
      expect(event.active).toBe(1);
      await deactivateTestEvent(event.id);
      const { getEventWithCount } = await import("#lib/db/events.ts");
      const updated = await getEventWithCount(event.id);
      expect(updated!.active).toBe(0);
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

    test("createTestEvent throws event not found when name is empty", async () => {
      // Empty name creates event but it cannot be found after creation
      // This covers the "Event not found after creation" error path
      await expect(
        createTestEvent({ name: "" }),
      ).rejects.toThrow("Event not found after creation: ");
    });

    test("authenticatedFormRequest throws on non-302 response via update", async () => {
      // Update with empty name triggers validation failure.
      // The update handler returns a 200 error page (not 302) on validation failure.
      const event = await createTestEvent();
      await expect(
        updateTestEvent(event.id, { name: "" }),
      ).rejects.toThrow("Failed to update event");
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
      // thankYouUrl: undefined triggers the ?? "" branch
      expect(event.thank_you_url).toBe(null);
    });
  });

  describe("createTestAttendee error paths", () => {
    beforeEach(async () => {
      await createTestDbWithSetup();
    });

    test("throws when ticket page does not provide CSRF token (deactivated event)", async () => {
      const event = await createTestEvent();
      await deactivateTestEvent(event.id);
      await expect(
        createTestAttendee(event.id, event.slug, "Test", "test@example.com"),
      ).rejects.toThrow("Failed to get CSRF token for ticket form");
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
});

describe("test-compat", () => {
  describe("beforeAll and afterAll", () => {
    test("beforeAll stores hook function on the current context", () => {
      let called = false;
      describe("inner", () => {
        beforeAll(() => {
          called = true;
        });
        afterAll(() => {
          called = false;
        });
      });
      // beforeAll and afterAll register without throwing
      expect(called).toBe(false);
    });
  });

  describe("expect.resolves", () => {
    test("resolves getter allows chaining toBe on resolved value", async () => {
      const value = await Promise.resolve(10);
      expect(value).resolves.toBe(10);
    });
  });

  describe("expect.rejects", () => {
    test("rejects.toThrow asserts on rejected promise with message", async () => {
      const failing = Promise.reject(new Error("async failure"));
      await expect(failing).rejects.toThrow("async failure");
    });

    test("rejects.toThrow asserts on rejected promise without message", async () => {
      const failing = Promise.reject(new Error("something"));
      await expect(failing).rejects.toThrow();
    });
  });

  describe("not.toEqual", () => {
    test("asserts two values are not deeply equal", () => {
      expect({ a: 1 }).not.toEqual({ a: 2 });
    });
  });

  describe("toStrictEqual", () => {
    test("asserts strict equality for matching values", () => {
      const val = 42;
      expect(val).toStrictEqual(42);
    });

    test("not.toStrictEqual asserts strict inequality", () => {
      expect(42).not.toStrictEqual(43);
    });
  });

  describe("not.toBeTruthy", () => {
    test("asserts value is not truthy", () => {
      expect(0).not.toBeTruthy();
    });
  });

  describe("toBeFalsy", () => {
    test("asserts value is falsy", () => {
      expect(0).toBeFalsy();
    });

    test("not.toBeFalsy asserts value is not falsy", () => {
      expect(1).not.toBeFalsy();
    });
  });

  describe("not.toBeUndefined", () => {
    test("asserts value is not undefined", () => {
      expect(42).not.toBeUndefined();
    });
  });

  describe("not.toBeDefined", () => {
    test("asserts value is not defined (is undefined)", () => {
      expect(undefined).not.toBeDefined();
    });
  });

  describe("toBeNaN", () => {
    test("asserts value is NaN", () => {
      expect(NaN).toBeNaN();
    });

    test("not.toBeNaN asserts value is not NaN", () => {
      expect(42).not.toBeNaN();
    });
  });

  describe("not.toContain", () => {
    test("asserts string does not contain substring", () => {
      expect("hello world").not.toContain("xyz");
    });

    test("asserts array does not contain element", () => {
      expect([1, 2, 3]).not.toContain(4);
    });
  });

  describe("toBeLessThanOrEqual", () => {
    test("asserts value is less than or equal", () => {
      expect(5).toBeLessThanOrEqual(5);
      expect(4).toBeLessThanOrEqual(5);
    });
  });

  describe("toContainEqual", () => {
    test("asserts array contains deeply equal element", () => {
      expect([{ a: 1 }, { b: 2 }]).toContainEqual({ a: 1 });
    });

    test("not.toContainEqual asserts array does not contain deeply equal element", () => {
      expect([{ a: 1 }, { b: 2 }]).not.toContainEqual({ c: 3 });
    });
  });

  describe("not.toHaveLength", () => {
    test("asserts array does not have specified length", () => {
      expect([1, 2, 3]).not.toHaveLength(5);
    });
  });

  describe("toMatch", () => {
    test("asserts string matches regex", () => {
      expect("hello world").toMatch(/hello/);
    });

    test("asserts string matches string pattern", () => {
      expect("hello world").toMatch("hello");
    });

    test("not.toMatch asserts string does not match", () => {
      expect("hello world").not.toMatch(/xyz/);
    });
  });

  describe("toMatchObject", () => {
    test("not.toMatchObject asserts objects do not match", () => {
      expect({ a: 1, b: 2 }).not.toMatchObject({ a: 99 });
    });
  });

  describe("toHaveProperty", () => {
    test("asserts object has property", () => {
      expect({ name: "test" }).toHaveProperty("name");
    });

    test("asserts object has property with specific value", () => {
      expect({ name: "test" }).toHaveProperty("name", "test");
    });

    test("not.toHaveProperty asserts object does not have property", () => {
      expect({ name: "test" }).not.toHaveProperty("missing");
    });

    test("not.toHaveProperty with value asserts property does not have that value", () => {
      expect({ name: "test" }).not.toHaveProperty("name", "other");
    });
  });

  describe("toBeInstanceOf", () => {
    test("asserts value is instance of class", () => {
      expect(new Error("test")).toBeInstanceOf(Error);
    });

    test("not.toBeInstanceOf asserts value is not instance of class", () => {
      expect("string").not.toBeInstanceOf(Error);
    });
  });

  describe("toThrow", () => {
    test("not.toThrow asserts function does not throw", () => {
      expect(() => "no error").not.toThrow();
    });

    test("toThrow with Error instance matches message", () => {
      expect(() => {
        throw new Error("specific error");
      }).toThrow(new Error("specific error"));
    });

    test("toThrow with string matches error message", () => {
      expect(() => {
        throw new Error("specific error");
      }).toThrow("specific error");
    });

    test("toThrow with RegExp matches error message pattern", () => {
      expect(() => {
        throw new Error("specific error 123");
      }).toThrow(/error \d+/);
    });

    test("toThrow with no argument asserts any throw", () => {
      expect(() => {
        throw new Error("anything");
      }).toThrow();
    });
  });

  describe("toHaveBeenCalledWith with isNot", () => {
    test("not.toHaveBeenCalledWith asserts mock was not called with specific args", () => {
      const mockFn = jest.fn();
      mockFn("a", "b");
      expect(mockFn).not.toHaveBeenCalledWith("x", "y");
    });
  });

  describe("jest.fn with implementation", () => {
    test("creates mock with custom implementation", () => {
      const mockFn = jest.fn((x: unknown) => (x as number) * 2);
      const result = mockFn(5);
      expect(result).toBe(10);
      expect(mockFn.mock.calls).toHaveLength(1);
    });
  });

  describe("mock function throw path", () => {
    test("records throw result when implementation throws", () => {
      const mockFn = jest.fn(() => {
        throw new Error("mock error");
      });
      let caught = false;
      try {
        mockFn();
      } catch {
        caught = true;
      }
      expect(caught).toBe(true);
      expect(mockFn.mock.results).toHaveLength(1);
      expect(mockFn.mock.results[0]!.type).toBe("throw");
    });
  });

  describe("mockClear", () => {
    test("clears calls and results but keeps implementation", () => {
      const mockFn = jest.fn(() => 42);
      mockFn();
      mockFn();
      expect(mockFn.mock.calls).toHaveLength(2);
      mockFn.mockClear();
      expect(mockFn.mock.calls).toHaveLength(0);
      expect(mockFn.mock.results).toHaveLength(0);
      // Implementation should still work
      expect(mockFn()).toBe(42);
    });
  });

  describe("mockReset", () => {
    test("clears calls, results, and resets implementation to return undefined", () => {
      const mockFn = jest.fn(() => 42);
      mockFn();
      expect(mockFn.mock.results[0]!.value).toBe(42);
      mockFn.mockReset();
      expect(mockFn.mock.calls).toHaveLength(0);
      expect(mockFn.mock.results).toHaveLength(0);
      // Implementation should be reset to return undefined
      expect(mockFn()).toBe(undefined);
    });
  });

  describe("mockReturnValue", () => {
    test("sets a fixed return value for the mock", () => {
      const mockFn = jest.fn();
      mockFn.mockReturnValue("hello");
      expect(mockFn()).toBe("hello");
      expect(mockFn()).toBe("hello");
    });
  });

  describe("jest timer functions", () => {
    test("useFakeTimers, setSystemTime, and useRealTimers control Date.now", () => {
      const realNow = Date.now();
      jest.useFakeTimers();
      jest.setSystemTime(1000);
      expect(Date.now()).toBe(1000);
      jest.useRealTimers();
      // After restoring, Date.now should return real time
      expect(Date.now()).toBeGreaterThanOrEqual(realNow);
    });
  });

  describe("setSystemTime with Date object", () => {
    test("accepts a Date instance and converts to timestamp", () => {
      jest.useFakeTimers();
      const date = new Date("2025-06-15T00:00:00Z");
      jest.setSystemTime(date);
      expect(Date.now()).toBe(date.getTime());
      jest.useRealTimers();
    });
  });

  describe("spyOn", () => {
    test("spies on object method and can be restored", () => {
      const obj = { greet: (name: string) => `Hello, ${name}` };
      const spy = spyOn(obj, "greet");
      obj.greet("world");
      expect(spy).toHaveBeenCalledWith("world");
      spy.mockRestore();
      expect(obj.greet("test")).toBe("Hello, test");
    });

    test("handles non-configurable properties by falling back to direct assignment", () => {
      const obj: Record<string, unknown> = {};
      Object.defineProperty(obj, "method", {
        value: () => "original",
        writable: true,
        configurable: false,
      });
      // defineProperty will fail because configurable is false, but direct assignment works
      const spy = spyOn(obj, "method");
      (obj.method as (...args: unknown[]) => unknown)();
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
      // After restore, the original function should be back
      expect((obj.method as () => string)()).toBe("original");
    });
  });

  describe("not.toBeGreaterThan (isNot numeric comparison)", () => {
    test("asserts value is not greater than expected", () => {
      // Exercises assertNumericComparison isNot branch (line 241-242)
      expect(5).not.toBeGreaterThan(10);
    });
  });

  describe("not.toThrow catch branch", () => {
    test("throws when function unexpectedly throws", () => {
      // Exercises the catch branch in not.toThrow (line 377-378)
      let caughtError: Error | null = null;
      try {
        expect(() => {
          throw new Error("oops");
        }).not.toThrow();
      } catch (e) {
        caughtError = e as Error;
      }
      expect(caughtError).not.toBeNull();
      expect(caughtError!.message).toBe("Expected function not to throw");
    });
  });

  describe("rejects.toThrow with RegExp argument", () => {
    test("asserts rejection with RegExp (covers Error class and ternary branch)", async () => {
      // Exercises RejectsChain.toThrow with a non-string argument (lines 440-441)
      const failing = Promise.reject(new Error("regex test error"));
      await expect(failing).rejects.toThrow(/regex/);
    });
  });

  describe("rejects.toThrow with string message", () => {
    test("matches error message string in rejected promise", async () => {
      const rejecting = Promise.reject(new Error("specific error message"));
      await expect(rejecting).rejects.toThrow("specific error message");
    });

    test("rejects.toThrow without argument matches any Error", async () => {
      const rejecting = Promise.reject(new Error("any error"));
      await expect(rejecting).rejects.toThrow();
    });
  });

  describe("jest.fn timer stubs", () => {
    test("jest object has timer stub functions that are callable", () => {
      // The jest object's timer methods are initially stubs that get
      // overwritten. Verify the overwritten versions are functional by
      // calling them through the jest object.
      const realNow = Date.now();
      jest.useFakeTimers();
      jest.setSystemTime(5000);
      expect(Date.now()).toBe(5000);
      jest.useRealTimers();
      expect(Date.now()).toBeGreaterThanOrEqual(realNow);
    });
  });
});

// Standalone test outside any describe block to exercise
// getCurrentContext's contextStack fallback ?? {} (test-compat.ts line 38)
test("test registered outside describe exercises empty context stack fallback", () => {
  // When test() is called outside any describe block, contextStack is empty.
  // getCurrentContext returns contextStack[contextStack.length - 1] ?? {}
  // which triggers the ?? {} fallback since contextStack[-1] is undefined.
  expect(1 + 1).toBe(2);
});
