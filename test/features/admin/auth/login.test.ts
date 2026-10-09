import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { spy, stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { clearSessionCookie } from "#shared/cookies.ts";
import { signCsrfToken } from "#shared/csrf.ts";
import { setSkipLoginDelay } from "#shared/test-overrides.ts";
import {
  assertAdminHtml,
  assertPublicHtml,
  expectAdminLoginSuccess,
  expectFlashRedirect,
  expectHtmlResponse,
  expectRedirectWithFlash,
  FLASH_TEST_ID,
  flashCookieHeader,
  followRedirectWithFlash,
} from "#test-utils/assertions.ts";
import { extractInputValue } from "#test-utils/csrf.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  TEST_ADMIN_PASSWORD,
  TEST_ADMIN_USERNAME,
} from "#test-utils/internal.ts";
import {
  expectLoginRedirectWithReturn,
  landedAt,
} from "#test-utils/login-redirect.ts";
import {
  awaitTestRequest,
  mockAdminLoginRequest,
  mockFormRequest,
  mockRequest,
} from "#test-utils/mocks.ts";
import { loginAsAdmin } from "#test-utils/session.ts";

/** POST a wrong-password login from the given client IP, then assert it is
 *  rejected with a 302 and the standard wrong-credentials flash. */
const expectWrongPasswordLoginFrom = async (
  clientIp: string,
): Promise<void> => {
  const request = await mockAdminLoginRequest({
    password: "wrong",
    username: TEST_ADMIN_USERNAME,
  });
  const response = await handleRequest(request, clientIp);
  expect(response.headers.getSetCookie()).not.toContain(clearSessionCookie());
  expectRedirectWithFlash(
    "/admin",
    expect.stringContaining("Username or password was wrong"),
    false,
  )(response);
};

/** Overwrite the owner's wrapped data key, attempt an admin login with the real
 *  password, and assert a 302 redirect whose flash contains `message`. */
const expectLoginRejectedWithWrappedKey = async (
  wrappedDataKey: string | null,
  message: string,
): Promise<void> => {
  const { getDb } = await import("#db/client.ts");
  await getDb().execute({
    args: [wrappedDataKey],
    sql: "UPDATE users SET wrapped_data_key = ? WHERE id = 1",
  });
  const response = await handleRequest(
    await mockAdminLoginRequest({
      password: TEST_ADMIN_PASSWORD,
      username: TEST_ADMIN_USERNAME,
    }),
  );
  expectRedirectWithFlash(
    "/admin",
    expect.stringContaining(message),
    false,
  )(response);
};

describeWithEnv("server (admin login)", { db: true }, () => {
  describe("GET /admin/", () => {
    test("shows login page when not authenticated", async () => {
      await assertPublicHtml("/admin/", "Login");
    });

    test("shows dashboard when authenticated", async () => {
      await assertAdminHtml("/admin/", "Listings");
    });
  });

  describe("GET /admin (without trailing slash)", () => {
    test("shows login page when not authenticated", async () => {
      await assertPublicHtml("/admin", "Login");
    });
  });

  describe("GET /admin/login", () => {
    test("shows login page", async () => {
      const html = await assertPublicHtml("/admin/login", "Login");
      // Login page contains a signed CSRF token in the form
      expect(extractInputValue(html, "csrf_token")).toMatch(/^s1\./);
    });

    test("redirects to /admin when already authenticated", async () => {
      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest("/admin/login", { cookie });
      await expectFlashRedirect("/admin", "Already logged in")(response);
    });
  });

  describe("POST /admin/login", () => {
    test("validates required password field", async () => {
      const response = await handleRequest(
        await mockAdminLoginRequest({
          password: "",
          username: TEST_ADMIN_USERNAME,
        }),
      );
      expectRedirectWithFlash(
        "/admin",
        expect.stringContaining("Password is required"),
        false,
      )(response);
    });

    test("rejects wrong password", async () => {
      const response = await handleRequest(
        await mockAdminLoginRequest({
          password: "wrong",
          username: TEST_ADMIN_USERNAME,
        }),
      );
      expectRedirectWithFlash(
        "/admin",
        expect.stringContaining("Username or password was wrong"),
        false,
      )(response);
    });

    test("accepts correct password and sets cookie", async () => {
      const password = TEST_ADMIN_PASSWORD;
      const response = await handleRequest(
        await mockAdminLoginRequest({
          password,
          username: TEST_ADMIN_USERNAME,
        }),
      );
      await expectAdminLoginSuccess(response);
    });

    test("rejects login when CSRF token is missing from form", async () => {
      const body = "username=testadmin&password=testpassword123";
      const response = await handleRequest(
        new Request("http://localhost/admin/login", {
          body,
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            host: "localhost",
          },
          method: "POST",
        }),
      );

      expectRedirectWithFlash(
        "/admin",
        expect.stringContaining("Invalid or expired form"),
        false,
      )(response);
    });

    test("rejects login when CSRF token is invalid", async () => {
      const response = await handleRequest(
        mockFormRequest("/admin/login", {
          csrf_token: "invalid-csrf-token",
          password: TEST_ADMIN_PASSWORD,
          username: TEST_ADMIN_USERNAME,
        }),
      );

      expectRedirectWithFlash(
        "/admin",
        expect.stringContaining("Invalid or expired form"),
        false,
      )(response);
    });

    test("redirects with a too-many-attempts flash when rate limited", async () => {
      // Rate limiting uses direct connection IP (falls back to "direct" in tests)
      const makeRequest = () =>
        mockAdminLoginRequest({
          password: "wrong",
          username: TEST_ADMIN_USERNAME,
        });

      // Make 5 failed attempts to trigger lockout
      for (let i = 0; i < 5; i++) {
        await handleRequest(await makeRequest());
      }

      // 6th attempt should be rate limited
      const response = await handleRequest(await makeRequest());
      expectRedirectWithFlash(
        "/admin",
        expect.stringContaining("Too many login attempts"),
        false,
      )(response);
    });

    test("does not lock out another client IP", async () => {
      for (let i = 0; i < 5; i++) {
        await expectWrongPasswordLoginFrom("192.0.2.1");
      }
      await expectWrongPasswordLoginFrom("192.0.2.2");
    });
  });
  describe("POST /admin/login (user without wrapped data key)", () => {
    test("returns 302 with error when user has no wrapped data key (not activated)", async () => {
      // A null wrapped_data_key means the user exists but is not activated.
      await expectLoginRejectedWithWrappedKey(null, "not been activated");
    });
  });

  describe("routes/admin/auth.ts (wrappedDataKey corrupted path)", () => {
    test("login fails when wrapped data key cannot be unwrapped", async () => {
      // A corrupted wrapped_data_key can't be unwrapped by the KEK.
      await expectLoginRejectedWithWrappedKey(
        "corrupted_key",
        "Username or password was wrong",
      );
    });
  });

  describe("login timing delay", () => {
    afterEach(() => {
      setSkipLoginDelay(true);
    });

    test("waits 100 to 200ms when TEST_SKIP_LOGIN_DELAY is not set", async () => {
      setSkipLoginDelay(false);
      using _random = stub(Math, "random", () => 0.5);
      using timers = spy(globalThis, "setTimeout");
      const response = await handleRequest(
        await mockAdminLoginRequest({
          password: TEST_ADMIN_PASSWORD,
          username: TEST_ADMIN_USERNAME,
        }),
      );
      await expectFlashRedirect("/admin", "Logged in")(response);
      expect(timers.calls.map((call) => call.args[1])).toContain(150);
    });
  });
  describe("login error display", () => {
    test("displays error from flash cookie on login page", async () => {
      const response = await handleRequest(
        mockRequest(`/admin?flash=${FLASH_TEST_ID}`, {
          headers: {
            cookie: flashCookieHeader("Username or password was wrong", false),
          },
        }),
      );
      await expectHtmlResponse(
        response,
        200,
        "Login",
        "Username or password was wrong",
      );
    });

    test("shows error after failed login attempt", async () => {
      const postResponse = await handleRequest(
        await mockAdminLoginRequest({
          password: "wrong",
          username: TEST_ADMIN_USERNAME,
        }),
      );
      expect(postResponse.status).toBe(302);

      const getResponse = await followRedirectWithFlash(
        postResponse,
        handleRequest,
      );
      await expectHtmlResponse(
        getResponse,
        200,
        "Login",
        "Username or password was wrong",
      );
    });

    test("failed login with existing session shows login page, not dashboard", async () => {
      // Simulate a user who is already logged in but tries to log in again
      // with wrong credentials. They should be redirected to the login page,
      // not left logged in on the dashboard.
      const { cookie } = await loginAsAdmin();

      const csrfToken = await signCsrfToken();
      const postResponse = await handleRequest(
        mockFormRequest(
          "/admin/login",
          {
            csrf_token: csrfToken,
            password: "wrong",
            username: TEST_ADMIN_USERNAME,
          },
          cookie,
        ),
      );
      expect(postResponse.headers.getSetCookie()).toContain(
        clearSessionCookie(),
      );
      expect(postResponse.status).toBe(302);

      // Follow the redirect, carrying both the original session cookie and
      // the flash cookie from the failed login response.
      const getResponse = await followRedirectWithFlash(
        postResponse,
        handleRequest,
        cookie,
      );

      // Should land on the login page with the error, NOT the dashboard.
      const html = await getResponse.text();
      expect(getResponse.status).toBe(200);
      expect(html).toContain("Login");
      expect(html).toContain("Username or password was wrong");
      expect(html).not.toContain("Listing name");
    });
  });

  describe("login return target", () => {
    test("the gate hands the login page the address the visitor asked for", async () => {
      const response = await awaitTestRequest("/admin/listings/12");
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(
        "/admin?return_url=%2Fadmin%2Flistings%2F12",
      );
    });

    test("the gate keeps the requested query string", async () => {
      const response = await awaitTestRequest("/admin/listings/12?tab=notes");
      expect(response.headers.get("location")).toBe(
        "/admin?return_url=%2Fadmin%2Flistings%2F12%3Ftab%3Dnotes",
      );
    });

    test("the gate refuses to carry an unsafe target it was handed", async () => {
      const response = await awaitTestRequest(
        "/admin/listings/12?return_url=//evil.com",
      );
      expect(response.headers.get("location")).toBe("/admin");
    });

    test("a successful login returns to the page the visitor asked for", async () => {
      // The journey: open a page logged out, log in from the login page the
      // gate serves, and land back on that page.
      const gate = await awaitTestRequest("/admin/listings/12");
      const loginPage = await awaitTestRequest(gate.headers.get("location")!);
      const html = await loginPage.text();
      expect(extractInputValue(html, "return_url")).toBe("/admin/listings/12");
      const response = await handleRequest(
        await mockAdminLoginRequest(
          {
            password: TEST_ADMIN_PASSWORD,
            return_url: "/admin/listings/12",
            username: TEST_ADMIN_USERNAME,
          },
          extractInputValue(html, "csrf_token") ?? undefined,
        ),
      );
      expect(landedAt(response).pathname).toBe("/admin/listings/12");
    });

    test("an attack target lands on the dashboard", async () => {
      for (const attack of [
        "//evil.com",
        "https://evil.com/admin",
        "%2F%2Fevil.com",
        "/admin/..%2F..%2Fpublic",
      ]) {
        const response = await handleRequest(
          await mockAdminLoginRequest({
            password: TEST_ADMIN_PASSWORD,
            return_url: attack,
            username: TEST_ADMIN_USERNAME,
          }),
        );
        expect(landedAt(response).pathname, attack).toBe("/admin");
      }
    });

    test("a failed login keeps the return target", async () => {
      const response = await handleRequest(
        await mockAdminLoginRequest({
          password: "wrong",
          return_url: "/admin/listings/12",
          username: TEST_ADMIN_USERNAME,
        }),
      );
      expectLoginRedirectWithReturn("/admin/listings/12")(response);
      const page = await followRedirectWithFlash(response, handleRequest);
      expect(extractInputValue(await page.text(), "return_url")).toBe(
        "/admin/listings/12",
      );
    });

    test("a login without a target lands on the dashboard", async () => {
      const response = await handleRequest(
        await mockAdminLoginRequest({
          password: TEST_ADMIN_PASSWORD,
          username: TEST_ADMIN_USERNAME,
        }),
      );
      await expectAdminLoginSuccess(response);
    });
  });
});
