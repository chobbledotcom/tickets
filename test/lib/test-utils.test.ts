import type { Client } from "@libsql/client";
import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { getSessionCookieName } from "#shared/cookies.ts";
import { CONFIG_KEYS, settings } from "#shared/db/settings.ts";
import type { Field } from "#shared/forms.tsx";
import {
  awaitTestRequest,
  buildAttendeeEditForm,
  buildMigrationContext,
  createTestAgentSession,
  createTestAttendee,
  createTestBuiltSite,
  createTestDb,
  createTestDbWithSetup,
  createTestInvite,
  createTestListing,
  createTestManagerSession,
  csrfTokenOrSignedFallback,
  deactivateTestListing,
  emailTestSandbox,
  errorResponse,
  expectCheckoutRedirect,
  expectInvalidForm,
  expectRedirectWithFlash,
  expectStatus,
  extractInputValue,
  generateTestListingName,
  getAdminLoginCsrfToken,
  getCachedSetupUsers,
  getCsrfTokenFromCookie,
  getJoinCsrfToken,
  getListingWithActivityLog,
  getPageCsrfToken,
  getSetupCsrfToken,
  getTestDataKey,
  getTestPrivateKey,
  getTicketCsrfToken,
  hasCheckedInput,
  hasInputWithValue,
  hasSelectedOption,
  installRecordingFetch,
  invalidateTestDbCache,
  loginAsAdmin,
  mockFormRequest,
  mockRequest,
  mockWebhookRequest,
  normalizeSingleListingFields,
  openAttendeeEditor,
  priceFormValue,
  randomString,
  rawListingRange,
  requireJoinCsrfToken,
  resetDb,
  resetTestSession,
  resetTestSlugCounter,
  setTestEnv,
  setTestSession,
  setupAndLogin,
  setupStripe,
  submitJoinForm,
  submitMultiTicketForm,
  submitTicketForm,
  TEST_ADMIN_PASSWORD,
  TEST_ADMIN_USERNAME,
  testRequest,
  testWithSetting,
  ticketTokenOnPage,
  unusedMigrationMember,
  updateTestBuiltSite,
  updateTestListing,
  useSetting,
  validEmail,
  wait,
  withBunnyDeleteCapture,
  withBunnyStorageStub,
  withCdnProxy,
  withCdnRejecting,
  withRandomBytes,
  withSetting,
  withStorageMock,
  withTestSession,
} from "#test-utils";
import { createReservedAttendee } from "#test-utils/balance.ts";
import { rejection } from "#test-utils/ledger.ts";
import { lastLogMessage } from "#test-utils/settings-handlers.ts";

describe("test-utils", () => {
  afterEach(() => {
    resetDb();
  });

  describe("internal caches", () => {
    test("start with no cached setup users", () => {
      invalidateTestDbCache();
      expect(getCachedSetupUsers()).toBe(null);
    });
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
        insert("listings", {
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
      const result = await getDb().execute("SELECT * FROM listings");
      expect(result.rows.length).toBe(0);
    });

    test("can be called after the active temp database was already removed", async () => {
      await createTestDb();
      resetDb();

      expect(() => resetDb()).not.toThrow();
    });

    test("removes the temp database even when closing the client throws", async () => {
      const path = await Deno.makeTempFile({ suffix: ".db" });
      const restoreEnv = setTestEnv({ DB_URL: `file:${path}` });
      const { setDb } = await import("#shared/db/client.ts");
      setDb({
        close: () => {
          throw new Error("already closed");
        },
      } as unknown as Client);
      let cleanupError: unknown;

      try {
        expect(() => resetDb()).not.toThrow();
        try {
          await Deno.stat(path);
          throw new Error("temp database still exists");
        } catch (error) {
          expect(error).toBeInstanceOf(Deno.errors.NotFound);
        }
      } finally {
        restoreEnv();
        try {
          await Deno.remove(path);
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) cleanupError = error;
        }
      }
      if (cleanupError) throw cleanupError;
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
      const request = testRequest("/admin/listing/new", "mytoken", {
        data: { name: "Test Listing" },
      });
      expect(request.method).toBe("POST");
      expect(request.headers.get("cookie")).toBe(
        `${getSessionCookieName()}=mytoken`,
      );
      const body = await request.text();
      expect(body).toContain("name=Test+Listing");
    });

    test("allows custom method override", () => {
      const request = testRequest("/admin/listing/1", "token", {
        method: "DELETE",
      });
      expect(request.method).toBe("DELETE");
    });

    test("allows custom method with form data", async () => {
      const request = testRequest("/admin/listing/1", null, {
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

  describe("generateTestListingName", () => {
    test("generates incrementing names", () => {
      resetTestSlugCounter();
      expect(generateTestListingName()).toBe("Test Listing 1");
      expect(generateTestListingName()).toBe("Test Listing 2");
      expect(generateTestListingName()).toBe("Test Listing 3");
    });

    test("resetTestSlugCounter resets counter to 0", () => {
      generateTestListingName(); // Trigger lazy init if needed
      resetTestSlugCounter();
      expect(generateTestListingName()).toBe("Test Listing 1");
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

    test("returns an empty stored CSRF token unchanged", async () => {
      await createTestDb();
      const { createSession } = await import("#shared/db/sessions.ts");
      await createSession(
        "empty-csrf-session",
        "",
        Date.now() + 60000,
        null,
        1,
      );
      const result = await getCsrfTokenFromCookie(
        `${getSessionCookieName()}=empty-csrf-session`,
      );
      expect(result).toBe("");
    });
  });

  describe("HTML form helpers", () => {
    const html = [
      '<input name="csrf_token" value="">',
      '<input name="quantity_1" value="2">',
      '<input name="quantity_2" value="3">',
      '<input type="checkbox" name="features" value="email" checked>',
      '<input type="checkbox" name="features" value="sms">',
      '<input type="checkbox" name="other" value="email" checked>',
      '<option value="draft">Draft</option>',
      '<option value="published" selected>Published</option>',
    ].join("");

    test("extractInputValue returns the exact matching value", () => {
      expect(extractInputValue(html, "csrf_token")).toBe("");
      expect(extractInputValue(html, "quantity_1")).toBe("2");
      expect(extractInputValue(html, "missing")).toBe(null);
    });

    test("hasInputWithValue requires the requested name and value", () => {
      expect(hasInputWithValue(html, "quantity_1", "2")).toBe(true);
      expect(hasInputWithValue(html, "quantity_1", "3")).toBe(false);
      expect(hasInputWithValue(html, "quantity_3", "2")).toBe(false);
    });

    test("hasCheckedInput requires matching name, value, and checked state", () => {
      expect(hasCheckedInput(html, "features", "email")).toBe(true);
      expect(hasCheckedInput(html, "features", "sms")).toBe(false);
      expect(hasCheckedInput(html, "other", "email")).toBe(true);
      expect(hasCheckedInput(html, "missing", "email")).toBe(false);
      expect(hasCheckedInput("", "features", "email")).toBe(false);
    });

    test("hasSelectedOption requires matching value and selected state", () => {
      expect(hasSelectedOption(html, "published")).toBe(true);
      expect(hasSelectedOption(html, "draft")).toBe(false);
      expect(hasSelectedOption(html, "missing")).toBe(false);
      expect(hasSelectedOption("", "published")).toBe(false);
    });

    test("normalizeSingleListingFields maps generic ticket fields to the listing id", () => {
      const result = normalizeSingleListingFields(
        {
          custom_price: "25.00",
          email: "buyer@example.com",
          name: "Buyer",
          quantity: "3",
        },
        '<input name="quantity_42" value="1">',
      );
      expect(result).toEqual({
        custom_price_42: "25.00",
        email: "buyer@example.com",
        name: "Buyer",
        quantity_42: "3",
      });
    });

    test("normalizeSingleListingFields defaults quantity and preserves explicit fields", () => {
      const result = normalizeSingleListingFields(
        {
          custom_price: "5.00",
          custom_price_42: "25.00",
          email: "buyer@example.com",
          name: "Buyer",
          quantity: "4",
          quantity_42: "2",
        },
        '<input name="quantity_42" value="1">',
      );
      expect(result).toEqual({
        custom_price: "5.00",
        custom_price_42: "25.00",
        email: "buyer@example.com",
        name: "Buyer",
        quantity: "4",
        quantity_42: "2",
      });
      expect(
        normalizeSingleListingFields(
          { email: "buyer@example.com", name: "Buyer" },
          '<input name="quantity_42" value="1">',
        ),
      ).toEqual({
        email: "buyer@example.com",
        name: "Buyer",
        quantity_42: "1",
      });
    });

    test("csrfTokenOrSignedFallback keeps an empty token distinct from no token", async () => {
      expect(
        await csrfTokenOrSignedFallback('<input name="csrf_token" value="">'),
      ).toBe("");
      expect(await csrfTokenOrSignedFallback("<form></form>")).toMatch(/^s1\./);
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
      const listing = await createTestListing();
      const response = await submitTicketForm(listing.slug, {
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

    test("maps generic quantity onto the single listing field", async () => {
      await createTestDbWithSetup();
      const listing = await createTestListing({
        maxAttendees: 10,
        maxQuantity: 5,
      });
      const response = await submitTicketForm(listing.slug, {
        email: "quantity@example.com",
        name: "Quantity User",
        quantity: "3",
      });
      expect(response.status).toBe(302);

      const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
      const attendees = await getAttendeesRaw(listing.id);
      expect(attendees).toHaveLength(1);
      expect(attendees[0]!.quantity).toBe(3);
    });

    test("keeps an explicit single-listing quantity field over the generic field", async () => {
      await createTestDbWithSetup();
      const listing = await createTestListing({
        maxAttendees: 10,
        maxQuantity: 5,
      });
      const response = await submitTicketForm(listing.slug, {
        email: "explicit@example.com",
        name: "Explicit Quantity",
        quantity: "5",
        [`quantity_${listing.id}`]: "2",
      });
      expect(response.status).toBe(302);

      const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
      const attendees = await getAttendeesRaw(listing.id);
      expect(attendees).toHaveLength(1);
      expect(attendees[0]!.quantity).toBe(2);
    });

    test("maps generic custom price onto the single listing field", async () => {
      await createTestDbWithSetup();
      await setupStripe();
      const listing = await createTestListing({
        canPayMore: true,
        maxAttendees: 10,
        maxQuantity: 5,
        unitPrice: 1000,
      });
      const response = await submitTicketForm(listing.slug, {
        custom_price: "25.00",
        email: "custom-price@example.com",
        name: "Custom Price",
        quantity: "1",
      });
      expectCheckoutRedirect(response);
    });

    test("keeps an explicit custom price over the generic field", async () => {
      await createTestDbWithSetup();
      await setupStripe();
      const listing = await createTestListing({
        canPayMore: true,
        maxAttendees: 10,
        maxQuantity: 5,
        unitPrice: 1000,
      });
      const response = await submitTicketForm(listing.slug, {
        custom_price: "5.00",
        [`custom_price_${listing.id}`]: "25.00",
        email: "explicit-price@example.com",
        name: "Explicit Price",
        quantity: "1",
      });
      expectCheckoutRedirect(response);
    });
  });

  describe("submitMultiTicketForm", () => {
    test("throws when the ticket page has no CSRF token", async () => {
      await createTestDbWithSetup();
      await expect(
        submitMultiTicketForm("missing-listing", {
          email: "missing@example.com",
          name: "Missing Listing",
        }),
      ).rejects.toThrow("No CSRF token found on ticket page");
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

    test("throws when invite creation fails without a redirect location", async () => {
      const { cookie } = await loginAsAdmin();
      setTestSession({ cookie, csrfToken: "not-a-signed-csrf-token" });

      await expect(createTestInvite("csrf-failure")).rejects.toThrow(
        "Failed to create invite for csrf-failure: 403 ",
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

  describe("createTestListing", () => {
    beforeEach(async () => {
      await createTestDbWithSetup();
    });

    test("creates an listing with thankYouUrl override", async () => {
      const listing = await createTestListing({
        thankYouUrl: "https://custom.example.com/done",
      });
      expect(listing.thank_you_url).toBe("https://custom.example.com/done");
      expect(listing.slug).toBeTruthy();
    });

    test("creates an listing with default settings", async () => {
      const listing = await createTestListing();
      expect(listing.id).toBeGreaterThan(0);
      expect(listing.max_attendees).toBe(100);
      expect(listing.active).toBe(true);
    });

    test("creates an listing with maxPrice", async () => {
      const listing = await createTestListing({ maxPrice: 5000 });
      expect(listing.max_price).toBe(5000);
    });
  });

  describe("updateTestListing", () => {
    beforeEach(async () => {
      await createTestDbWithSetup();
    });

    test("updates listing fields via the REST API", async () => {
      const listing = await createTestListing();
      const updated = await updateTestListing(listing.id, {
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

    test("throws when listing does not exist", async () => {
      await expect(
        updateTestListing(99999, { maxAttendees: 50 }),
      ).rejects.toThrow("Listing not found: 99999");
    });

    test("preserves existing values when updates are partial", async () => {
      const listing = await createTestListing({
        thankYouUrl: "https://original.example.com",
      });
      const updated = await updateTestListing(listing.id, {
        maxAttendees: 50,
      });
      expect(updated.max_attendees).toBe(50);
      expect(updated.thank_you_url).toBe("https://original.example.com");
    });

    test("clears fields when set to zero/empty", async () => {
      const listing = await createTestListing({
        unitPrice: 1000,
        webhookUrl: "https://hook.example.com",
      });
      const updated = await updateTestListing(listing.id, {
        unitPrice: 0,
        webhookUrl: "",
      });
      expect(updated.unit_price).toBe(0);
      expect(updated.webhook_url).toBe("");
    });

    test("updates max_price when explicitly set", async () => {
      const listing = await createTestListing();
      const updated = await updateTestListing(listing.id, { maxPrice: 7500 });
      expect(updated.max_price).toBe(7500);
    });

    test("preserves existing max_price when not specified in update", async () => {
      const listing = await createTestListing({ maxPrice: 3000 });
      const updated = await updateTestListing(listing.id, { maxAttendees: 50 });
      expect(updated.max_price).toBe(3000);
    });
  });

  describe("deactivateTestListing", () => {
    beforeEach(async () => {
      await createTestDbWithSetup();
    });

    test("throws when listing does not exist", async () => {
      await expect(deactivateTestListing(99999)).rejects.toThrow(
        "Listing not found: 99999",
      );
    });

    test("deactivates an existing listing", async () => {
      const listing = await createTestListing();
      expect(listing.active).toBe(true);
      await deactivateTestListing(listing.id);
      const { getListingWithCount } = await import("#shared/db/listings.ts");
      const updated = await getListingWithCount(listing.id);
      expect(updated!.active).toBe(false);
    });
  });

  describe("createTestAttendee", () => {
    beforeEach(async () => {
      await createTestDbWithSetup();
    });

    test("creates an attendee via the public ticket form", async () => {
      const listing = await createTestListing();
      const attendee = await createTestAttendee(
        listing.id,
        listing.slug,
        "Jane Doe",
        "jane@example.com",
      );
      expect(attendee.id).toBeGreaterThan(0);
      expect(attendee.listing_id).toBe(listing.id);
      expect(attendee.quantity).toBe(1);
    });

    test("creates an attendee with custom quantity", async () => {
      const listing = await createTestListing({
        maxAttendees: 10,
        maxQuantity: 5,
      });
      const attendee = await createTestAttendee(
        listing.id,
        listing.slug,
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
      const listing = await createTestListing();
      const { attendee, token } = await createTestAttendeeDirect(
        listing.id,
        "Test User",
        "test@example.com",
      );
      expect(attendee.id).toBeGreaterThan(0);
      expect(attendee.listing_id).toBe(listing.id);
      expect(token).toBeTruthy();
      expect(typeof token).toBe("string");
    });

    test("throws error when capacity is exceeded", async () => {
      const { createTestAttendeeDirect } = await import("#test-utils");
      const listing = await createTestListing({ maxAttendees: 1 });

      // Fill the listing
      await createTestAttendeeDirect(listing.id, "First", "first@example.com");

      // Second attendee should fail
      await expect(
        createTestAttendeeDirect(listing.id, "Second", "second@example.com"),
      ).rejects.toThrow("Failed to create attendee");
    });
  });

  describe("rawListingRange", () => {
    beforeEach(async () => {
      await createTestDbWithSetup();
    });

    test("returns start_at/end_at/quantity for the first booking", async () => {
      const { createDailyTestListing } = await import("#test-utils");
      const { createAttendeeAtomic } = await import("#shared/db/attendees.ts");
      const listing = await createDailyTestListing({ maxAttendees: 10 });
      const result = await createAttendeeAtomic({
        bookings: [{ date: "2026-05-01", listingId: listing.id, quantity: 3 }],
        email: "alice@test.com",
        name: "Alice",
      });
      if (!result.success) throw new Error("create failed");

      const range = await rawListingRange(listing.id);
      expect(range).not.toBeNull();
      expect(range!.start_at).toBe("2026-05-01T00:00:00Z");
      expect(range!.end_at).toBe("2026-05-02T00:00:00.000Z");
      expect(range!.quantity).toBe(3);
    });

    test("returns null when no bookings exist for the listing", async () => {
      const listing = await createTestListing();
      expect(await rawListingRange(listing.id)).toBeNull();
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
      // createTestListing uses getTestSession internally
      // With cachedAdminSession null, it falls through to loginAsAdmin
      const listing = await createTestListing();
      expect(listing.id).toBeGreaterThan(0);
    });
  });

  describe("authenticatedFormRequest and createTestListing error paths", () => {
    beforeEach(async () => {
      await createTestDbWithSetup();
    });

    test("createTestListing throws on validation failure when name is empty", async () => {
      // Empty name triggers validation failure, returning 400 instead of 302
      await expect(createTestListing({ name: "" })).rejects.toThrow(
        "Failed to create listing: 400",
      );
    });

    test("authenticatedFormRequest throws on non-302 response via update", async () => {
      // Update with empty name triggers validation failure.
      // The update handler returns a 200 error page (not 302) on validation failure.
      const listing = await createTestListing();
      await expect(updateTestListing(listing.id, { name: "" })).rejects.toThrow(
        "Failed to update listing",
      );
    });
  });

  describe("formatPrice coverage", () => {
    beforeEach(async () => {
      await createTestDbWithSetup();
    });

    test("preserves existing unitPrice when update does not specify unitPrice", async () => {
      // Create listing with a unit price
      const listing = await createTestListing({ unitPrice: 2500 });
      expect(listing.unit_price).toBe(2500);
      // Update without specifying unitPrice -> formatPrice(undefined, 2500)
      // This covers the branch: existing != null ? String(existing) : ""
      const updated = await updateTestListing(listing.id, { maxAttendees: 50 });
      expect(updated.unit_price).toBe(2500);
      expect(updated.max_attendees).toBe(50);
    });

    test("preserves existing closesAt when update does not specify closesAt", async () => {
      const listing = await createTestListing({ closesAt: "2099-06-15T14:30" });
      expect(listing.closes_at).toBe("2099-06-15T14:30:00.000Z");
      const updated = await updateTestListing(listing.id, { maxAttendees: 50 });
      expect(updated.closes_at).toBe("2099-06-15T14:30:00.000Z");
      expect(updated.max_attendees).toBe(50);
    });
  });

  describe("createTestListing with null thankYouUrl", () => {
    beforeEach(async () => {
      await createTestDbWithSetup();
    });

    test("creates listing without thankYouUrl using ?? empty string fallback", async () => {
      const listing = await createTestListing({ thankYouUrl: undefined });
      expect(listing.id).toBeGreaterThan(0);
      // thankYouUrl: undefined triggers the default empty string
      expect(listing.thank_you_url).toBe("");
    });
  });

  describe("createTestAttendee error paths", () => {
    beforeEach(async () => {
      await createTestDbWithSetup();
    });

    test("throws when listing is deactivated", async () => {
      const listing = await createTestListing();
      await deactivateTestListing(listing.id);
      await expect(
        createTestAttendee(
          listing.id,
          listing.slug,
          "Test",
          "test@example.com",
        ),
      ).rejects.toThrow("Failed to create attendee");
    });

    test("throws when form submission returns error status (listing at capacity)", async () => {
      const listing = await createTestListing({
        maxAttendees: 1,
        maxQuantity: 1,
      });
      // Fill the listing
      await createTestAttendee(
        listing.id,
        listing.slug,
        "First",
        "first@example.com",
      );
      // Second attendee should fail because listing is full
      await expect(
        createTestAttendee(
          listing.id,
          listing.slug,
          "Second",
          "second@example.com",
        ),
      ).rejects.toThrow("Failed to create attendee");
    });
  });

  describe("updateTestListing listing not found after update", () => {
    beforeEach(async () => {
      await createTestDbWithSetup();
    });

    test("throws when listing does not exist", async () => {
      await expect(
        updateTestListing(99999, { maxAttendees: 50 }),
      ).rejects.toThrow("Listing not found: 99999");
    });
  });

  describe("strictly covered utility contracts", () => {
    test("priceFormValue formats minor units for form submission", () => {
      expect(priceFormValue(1234)).toBe("12.34");
      expect(priceFormValue(0)).toBe("0.00");
    });

    test("withRandomBytes pads missing deterministic bytes with zero", () => {
      withRandomBytes([7])(() => {
        const bytes = new Uint8Array(3);
        crypto.getRandomValues(bytes);
        expect([...bytes]).toEqual([7, 0, 0]);
      });
    });

    test("validEmail rejects invalid fixture addresses", () => {
      expect(validEmail("person@example.com")).toBe("person@example.com");
      expect(() => validEmail("not an address")).toThrow(
        "Test fixture is not a valid email",
      );
    });

    test("expectInvalidForm only accepts invalid form data", () => {
      const fields: Field[] = [
        { label: "Name", name: "name", required: true, type: "text" },
      ];

      expectInvalidForm(fields, { name: "" });
      expect(() => expectInvalidForm(fields, { name: "Alice" })).toThrow();
    });

    test("rejection returns the thrown error and fails on resolved promises", async () => {
      const thrown = await rejection(Promise.reject(new Error("boom")));

      expect(thrown.message).toBe("boom");
      await expect(rejection(Promise.resolve("ok"))).rejects.toThrow(
        "expected the promise to reject",
      );
    });

    test("migration helpers fail closed for unused members and no-op verifiers", async () => {
      await expect(unusedMigrationMember()).rejects.toThrow(
        "unused migration context member called",
      );

      const context = buildMigrationContext();
      const migration = context.additive({
        description: "test additive migration",
        id: "test-additive",
        requires: { newTables: ["example"] },
        up: async () => {},
      });

      expect(migration.id).toBe("test-additive");
      await migration.verify();
      await context.verifyRequirement({ columns: { example: ["id"] } })();
    });

    test("recording fetch records calls and falls through when respond returns null", async () => {
      const fetchMock = installRecordingFetch(() => null);
      try {
        const response = await fetch("data:text/plain,fallback");

        expect(await response.text()).toBe("fallback");
        expect(fetchMock.calls).toEqual([
          { body: null, url: "data:text/plain,fallback" },
        ]);
        expect(fetchMock.emailCall()).toBeUndefined();
      } finally {
        fetchMock.restore();
      }
    });

    test("Bunny storage stub intercepts storage URLs and leaves unrelated URLs alone", async () => {
      const seen: string[] = [];

      await withBunnyStorageStub(
        (url) => {
          seen.push(url);
          return new Response("stored");
        },
        async () => {
          const stored = await fetch(
            "https://storage.bunnycdn.com/testzone/file.txt",
          );
          const fallback = await fetch("data:text/plain,plain");

          expect(await stored.text()).toBe("stored");
          expect(await fallback.text()).toBe("plain");
        },
      );

      expect(seen).toEqual(["https://storage.bunnycdn.com/testzone/file.txt"]);
    });

    test("Bunny delete capture records storage deletes and permits custom intercepts", async () => {
      await withBunnyDeleteCapture(
        async (deletedUrls) => {
          const storageResponse = await fetch(
            "https://storage.bunnycdn.com/testzone/delete-me.txt",
          );
          const customResponse = await fetch("https://example.test/custom");
          const fallbackResponse = await fetch("data:text/plain,untouched");

          expect(storageResponse.status).toBe(200);
          expect(await customResponse.text()).toBe("custom");
          expect(await fallbackResponse.text()).toBe("untouched");
          expect(deletedUrls).toEqual([
            "https://storage.bunnycdn.com/testzone/delete-me.txt",
          ]);
        },
        {
          extraHandler: (url) =>
            url === "https://example.test/custom"
              ? Promise.resolve(new Response("custom"))
              : null,
        },
      );
    });

    test("storage mock covers storage, CDN, and fallback fetches", async () => {
      await withStorageMock(async (fetchCalls) => {
        const storage = await fetch(
          "https://storage.bunnycdn.com/testzone/upload.txt",
        );
        const cdn = await fetch("https://testzone.b-cdn.net/upload.txt");
        const fallback = await fetch("data:text/plain,local");

        expect(storage.status).toBe(201);
        expect(cdn.status).toBe(201);
        expect(await fallback.text()).toBe("local");
        expect(fetchCalls).toEqual([
          "https://storage.bunnycdn.com/testzone/upload.txt",
          "https://testzone.b-cdn.net/upload.txt",
          "data:text/plain,local",
        ]);
      });
    });

    test("CDN proxy helpers intercept storage URLs and restore fetch", async () => {
      await withCdnProxy(
        () => new Response("proxied", { status: 202 }),
        async () => {
          const proxied = await fetch(
            "https://storage.bunnycdn.com/testzone/proxied.txt",
          );
          const fallback = await fetch("data:text/plain,local");

          expect(proxied.status).toBe(202);
          expect(await proxied.text()).toBe("proxied");
          expect(await fallback.text()).toBe("local");
        },
      );

      await withCdnRejecting(new Error("cdn down"), async () => {
        await expect(
          fetch("https://storage.bunnycdn.com/testzone/fail.txt"),
        ).rejects.toThrow("cdn down");

        const fallback = await fetch("data:text/plain,still-local");
        expect(await fallback.text()).toBe("still-local");
      });
    });

    test("email sandbox replaces an existing fetch stub and restores all state", () => {
      const sandbox = emailTestSandbox();

      sandbox.stubFetch(() => Promise.resolve(new Response("first")));
      sandbox.stubFetch(() => Promise.resolve(new Response("second")));
      expect(sandbox.fetchStub).toBeDefined();

      sandbox.teardown();
      expect(sandbox.fetchStub).toBeUndefined();
    });
  });

  describe("strict DB-backed utility contracts", () => {
    beforeEach(async () => {
      await createTestDbWithSetup();
    });

    test("getListingWithActivityLog reads through the test admin session", async () => {
      const listing = await createTestListing({ name: "Logged Listing" });
      const result = await getListingWithActivityLog(listing.id);

      expect(result).not.toBeNull();
      expect(result!.listing.id).toBe(listing.id);
      expect(result!.entries).toHaveLength(1);
      expect(result!.entries[0]!.message).toBe(
        "Listing 'Logged Listing' created",
      );
    });

    test("createReservedAttendee applies listing names and fails closed on setup failure", async () => {
      const { listingId } = await createReservedAttendee(1500, {
        listingName: "Reserved Helper Listing",
      });
      const { getListingWithCount } = await import("#shared/db/listings.ts");
      const listing = await getListingWithCount(listingId);

      expect(listing!.name).toBe("Reserved Helper Listing");
      await expect(
        createReservedAttendee(1500, { quantity: 11 }),
      ).rejects.toThrow("setup failed");
    });

    test("test crypto helpers expose real data keys and fail on missing setup material", async () => {
      const dataKey = await getTestDataKey();
      const privateKey = await getTestPrivateKey();

      expect(dataKey.type).toBe("secret");
      expect(privateKey.type).toBe("private");

      resetDb();
      await createTestDb();
      await expect(getTestPrivateKey()).rejects.toThrow(
        "Test setup failed: no wrapped data key",
      );

      resetDb();
      await createTestDbWithSetup();
      const { getDb } = await import("#shared/db/client.ts");
      await getDb().execute("DELETE FROM settings WHERE key = ?", [
        CONFIG_KEYS.WRAPPED_PRIVATE_KEY,
      ]);
      settings.invalidateCache();
      await settings.loadKeys([CONFIG_KEYS.WRAPPED_PRIVATE_KEY]);

      await expect(getTestPrivateKey()).rejects.toThrow(
        "Test setup failed: no wrapped private key",
      );
    });

    test("login and session helpers report missing cookies and sessions", async () => {
      await expect(
        loginAsAdmin(TEST_ADMIN_USERNAME, `${TEST_ADMIN_PASSWORD}-wrong`),
      ).rejects.toThrow("No session cookie in login response");

      setTestSession({
        cookie: `${getSessionCookieName()}=missing-session-token`,
        csrfToken: "csrf",
      });
      await expect(withTestSession(async () => undefined)).rejects.toThrow(
        "Test admin session row not found",
      );
    });

    test("manager and agent helpers require the setup admin key", async () => {
      resetDb();
      await createTestDb();

      await expect(createTestManagerSession()).rejects.toThrow(
        "Admin user has no wrapped data key",
      );
      await expect(createTestAgentSession()).rejects.toThrow(
        "Admin user not set up",
      );
    });

    test("createTestAttendee surfaces flashed validation errors", async () => {
      await settings.update.terms("Read these terms first.");
      settings.invalidateCache();
      await settings.loadKeys([CONFIG_KEYS.TERMS_AND_CONDITIONS]);
      const listing = await createTestListing();

      await expect(
        createTestAttendee(listing.id, listing.slug, "Invalid", "not-email"),
      ).rejects.toThrow(
        "Failed to create attendee: You must agree to the terms and conditions",
      );
    });

    test("lastLogMessage returns an empty string when no activity exists", async () => {
      expect(await lastLogMessage()).toBe("");
    });

    test("buildAttendeeEditForm preserves existing booking lines by default", async () => {
      const listing = await createTestListing({
        maxAttendees: 10,
        maxQuantity: 5,
      });
      const attendee = await createTestAttendee(
        listing.id,
        listing.slug,
        "Default Form",
        "default-form@example.com",
        2,
      );

      const form = await buildAttendeeEditForm(attendee.id);

      expect(form.name).toBe("");
      expect(form[`qty_${listing.id}`]).toBe("2");
      expect(form[`line_key_${listing.id}`]).not.toBe("");
    });

    test("buildAttendeeEditForm defaults new override lines to one ticket with no key", async () => {
      const listing = await createTestListing({
        maxAttendees: 10,
        maxQuantity: 5,
      });
      const attendee = await createTestAttendee(
        listing.id,
        listing.slug,
        "Override Form",
        "override-form@example.com",
        2,
      );

      const form = await buildAttendeeEditForm(attendee.id, {
        lines: [{ eventId: listing.id }],
      });

      expect(form[`qty_${listing.id}`]).toBe("1");
      expect(form[`line_key_${listing.id}`]).toBe("");
    });

    test("updateTestBuiltSite handles assignable and validation failure paths", async () => {
      const site = await createTestBuiltSite({
        name: "Assignable Site",
      });
      const assignable = await updateTestBuiltSite(site.id, {
        assignable: true,
      });
      const updated = await updateTestBuiltSite(site.id, { assignable: false });

      expect(assignable.assignable).toBe(true);
      expect(updated.assignable).toBe(false);

      const { cookie } = await loginAsAdmin();
      setTestSession({ cookie, csrfToken: "not-a-signed-csrf-token" });
      await expect(
        createTestBuiltSite({ name: "Forbidden Site" }),
      ).rejects.toThrow("Failed to create built site: 403");
    });
  });

  describe("e2e helper contracts", () => {
    test("setupAndLogin follows the migration-complete interstitial", async () => {
      const actions: string[] = [];
      const browser = {
        clickLink: (text: string) => {
          actions.push(`click:${text}`);
          return Promise.resolve();
        },
        containsText: (text: string) => text === "Migration complete",
        submitForm: (_data: Record<string, string>, buttonText: string) => {
          actions.push(`submit:${buttonText}`);
          return Promise.resolve();
        },
        visit: (path: string) => {
          actions.push(`visit:${path}`);
          return Promise.resolve();
        },
      } as unknown as import("#test-utils/test-browser.ts").TestBrowser;

      await setupAndLogin(browser);

      expect(actions).toEqual([
        "visit:/setup/",
        "submit:Complete Setup",
        "click:Go to Admin Dashboard",
        "submit:Login",
        "click:Back to dashboard",
      ]);
    });

    test("attendee navigation helpers fail clearly when required links are absent", async () => {
      const browser = {
        currentHtml: "<main>No attendees yet</main>",
        links: [],
        visit: (_path: string) => Promise.resolve(),
      } as unknown as import("#test-utils/test-browser.ts").TestBrowser;

      await expect(openAttendeeEditor(browser)).rejects.toThrow(
        "no attendee edit link on the current page",
      );
      expect(() => ticketTokenOnPage(browser)).toThrow(
        "no customer /t ticket link on the current page",
      );
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
