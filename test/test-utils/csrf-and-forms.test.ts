import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { getSessionCookieName } from "#shared/cookies.ts";
import {
  csrfTokenOrSignedFallback,
  extractInputValue,
  getAdminLoginCsrfToken,
  getCsrfTokenFromCookie,
  getJoinCsrfToken,
  getSetupCsrfToken,
  getTicketCsrfToken,
  hasCheckedInput,
  hasInputWithValue,
  hasSelectedOption,
  inputTagWithValue,
  normalizeSingleListingFields,
  requireJoinCsrfToken,
} from "#test-utils/csrf.ts";
import {
  createTestDb,
  createTestDbWithSetup,
  resetDb,
} from "#test-utils/db.ts";
import { awaitTestRequest } from "#test-utils/mocks.ts";

describe("test-utils — csrf & form helpers", () => {
  afterEach(() => {
    resetDb();
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

    test("inputTagWithValue returns only the requested input tag", () => {
      expect(inputTagWithValue(html, "3")).toBe(
        '<input name="quantity_2" value="3">',
      );
      expect(inputTagWithValue(html, "missing")).toBe("");
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
});
