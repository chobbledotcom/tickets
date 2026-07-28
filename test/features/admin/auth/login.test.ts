import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { signCsrfToken } from "#shared/csrf.ts";
import { setSkipLoginDelay } from "#shared/test-overrides.ts";
import {
  assertAdminHtml,
  assertPublicHtml,
  expectAdminLoginSuccess,
  expectFlash,
  expectFlashRedirect,
  expectHtmlResponse,
  FLASH_TEST_ID,
  flashCookieHeader,
  followRedirectWithFlash,
} from "#test-utils/assertions.ts";
import { extractInputValue } from "#test-utils/csrf.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { TEST_ADMIN_PASSWORD } from "#test-utils/internal.ts";
import {
  awaitTestRequest,
  mockAdminLoginRequest,
  mockFormRequest,
  mockRequest,
} from "#test-utils/mocks.ts";
import { loginAsAdmin } from "#test-utils/session.ts";

/** POST a wrong-password login through the given server context, then assert it
 *  is rejected with a 302 and the standard wrong-credentials flash. */
const expectWrongPasswordLoginVia = async (
  server: Parameters<typeof handleRequest>[1],
): Promise<void> => {
  const request = await mockAdminLoginRequest({
    password: "wrong",
    username: "testadmin",
  });
  const response = await handleRequest(request, server);
  expect(response.status).toBe(302);
  expectFlash(
    response,
    expect.stringContaining("Username or password was wrong"),
    false,
  );
};

/** Overwrite the owner's wrapped data key, attempt an admin login with the real
 *  password, and assert a 302 redirect whose flash contains `message`. */
const expectLoginRejectedWithWrappedKey = async (
  wrappedDataKey: string | null,
  message: string,
): Promise<void> => {
  const { getDb } = await import("#shared/db/client.ts");
  await getDb().execute({
    args: [wrappedDataKey],
    sql: "UPDATE users SET wrapped_data_key = ? WHERE id = 1",
  });
  const response = await handleRequest(
    await mockAdminLoginRequest({
      password: TEST_ADMIN_PASSWORD,
      username: "testadmin",
    }),
  );
  expect(response.status).toBe(302);
  expectFlash(response, expect.stringContaining(message), false);
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
        await mockAdminLoginRequest({ password: "", username: "testadmin" }),
      );
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Password is required"),
        false,
      );
    });

    test("rejects wrong password", async () => {
      const response = await handleRequest(
        await mockAdminLoginRequest({
          password: "wrong",
          username: "testadmin",
        }),
      );
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Username or password was wrong"),
        false,
      );
    });

    test("accepts correct password and sets cookie", async () => {
      const password = TEST_ADMIN_PASSWORD;
      const response = await handleRequest(
        await mockAdminLoginRequest({ password, username: "testadmin" }),
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

      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Invalid or expired form"),
        false,
      );
    });

    test("rejects login when CSRF token is invalid", async () => {
      const response = await handleRequest(
        mockFormRequest("/admin/login", {
          csrf_token: "invalid-csrf-token",
          password: TEST_ADMIN_PASSWORD,
          username: "testadmin",
        }),
      );

      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Invalid or expired form"),
        false,
      );
    });

    test("returns 429 when rate limited", async () => {
      // Rate limiting uses direct connection IP (falls back to "direct" in tests)
      const makeRequest = () =>
        mockAdminLoginRequest({ password: "wrong", username: "testadmin" });

      // Make 5 failed attempts to trigger lockout
      for (let i = 0; i < 5; i++) {
        await handleRequest(await makeRequest());
      }

      // 6th attempt should be rate limited
      const response = await handleRequest(await makeRequest());
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Too many login attempts"),
        false,
      );
    });

    test("uses server.requestIP when available", async () => {
      // IP is extracted from server.requestIP.
      await expectWrongPasswordLoginVia({
        requestIP: () => ({ address: "192.168.1.100" }),
      });
    });

    test("falls back to direct when server.requestIP returns null", async () => {
      // requestIP returns null, so the handler falls back to "direct".
      await expectWrongPasswordLoginVia({ requestIP: () => null });
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

    test("applies random delay when TEST_SKIP_LOGIN_DELAY is not set", async () => {
      setSkipLoginDelay(false);
      const start = Date.now();
      const response = await handleRequest(
        await mockAdminLoginRequest({
          password: TEST_ADMIN_PASSWORD,
          username: "testadmin",
        }),
      );
      const elapsed = Date.now() - start;
      await expectFlashRedirect("/admin", "Logged in")(response);
      expect(elapsed).toBeGreaterThanOrEqual(100);
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
          username: "testadmin",
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
            username: "testadmin",
          },
          cookie,
        ),
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
});
