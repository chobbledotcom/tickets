import { afterEach, beforeEach, describe, expect, test } from "#test-compat";
import { getAllActivityLog } from "#lib/db/activityLog.ts";
import { handleRequest } from "#routes";
import {
  awaitTestRequest,
  createTestDb,
  createTestDbWithSetup,
  getSetupCsrfToken,
  mockFormRequest,
  mockRequest,
  mockSetupFormRequest,
  resetDb,
  resetTestSlugCounter,
  expectRedirect,
  withMocks,
} from "#test-utils";

describe("server (setup)", () => {
  beforeEach(async () => {
    resetTestSlugCounter();
    await createTestDbWithSetup();
  });

  afterEach(() => {
    resetDb();
  });

  describe("setup routes", () => {
    describe("when setup not complete", () => {
      beforeEach(async () => {
        // Use a fresh db without setup
        resetDb();
        await createTestDb();
      });

      test("redirects home to /setup/", async () => {
        const response = await handleRequest(mockRequest("/"));
        expectRedirect("/setup")(response);
      });

      test("redirects admin to /setup/", async () => {
        const response = await handleRequest(mockRequest("/admin/"));
        expectRedirect("/setup")(response);
      });

      test("health check still works", async () => {
        const response = await handleRequest(mockRequest("/health"));
        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json).toEqual({ status: "ok" });
      });

      test("GET /setup/ shows setup page", async () => {
        const response = await handleRequest(mockRequest("/setup/"));
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain("Initial Setup");
        expect(html).toContain("Admin Password");
        expect(html).toContain("Currency Code");
        expect(html).toContain("Data Controller Agreement");
      });

      test("GET /setup (without trailing slash) shows setup page", async () => {
        const response = await handleRequest(mockRequest("/setup"));
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain("Initial Setup");
      });

      test("POST /setup/ with valid data completes setup", async () => {
        // First get CSRF token from GET request
        const getResponse = await handleRequest(mockRequest("/setup/"));
        const csrfToken = getSetupCsrfToken(await getResponse.text());
        expect(csrfToken).not.toBeNull();

        const response = await handleRequest(
          mockSetupFormRequest(
            {
              admin_username: "testadmin",
              admin_password: "mypassword123",
              admin_password_confirm: "mypassword123",
              currency_code: "USD",
            },
            csrfToken as string,
          ),
        );
        expectRedirect("/setup/complete")(response);
      });

      test("POST /setup/ without CSRF token rejects request", async () => {
        // POST without getting CSRF token first
        const response = await handleRequest(
          mockFormRequest("/setup/", {
            admin_username: "testadmin",
              admin_password: "mypassword123",
            admin_password_confirm: "mypassword123",
            currency_code: "USD",
          }),
        );
        expect(response.status).toBe(403);
        const html = await response.text();
        expect(html).toContain("Invalid or expired form");
      });

      test("POST /setup/ with invalid CSRF token rejects request", async () => {
        // Send a wrong token in the form body
        const response = await handleRequest(
          mockFormRequest("/setup/", {
            admin_username: "testadmin",
            admin_password: "mypassword123",
            admin_password_confirm: "mypassword123",
            currency_code: "USD",
            csrf_token: "wrong-token-in-form",
          }),
        );
        expect(response.status).toBe(403);
        const html = await response.text();
        expect(html).toContain("Invalid or expired form");
      });

      test("POST /setup/ with empty password shows validation error", async () => {
        const getResponse = await handleRequest(mockRequest("/setup/"));
        const csrfToken = getSetupCsrfToken(await getResponse.text());

        const response = await handleRequest(
          mockSetupFormRequest(
            {
              admin_username: "testadmin",
              admin_password: "",
              admin_password_confirm: "",
              currency_code: "GBP",
            },
            csrfToken as string,
          ),
        );
        expect(response.status).toBe(400);
        const html = await response.text();
        expect(html).toContain("Admin Password * is required");
      });

      test("POST /setup/ with mismatched passwords shows error", async () => {
        const getResponse = await handleRequest(mockRequest("/setup/"));
        const csrfToken = getSetupCsrfToken(await getResponse.text());

        const response = await handleRequest(
          mockSetupFormRequest(
            {
              admin_username: "testadmin",
              admin_password: "mypassword123",
              admin_password_confirm: "different",
              currency_code: "GBP",
            },
            csrfToken as string,
          ),
        );
        expect(response.status).toBe(400);
        const html = await response.text();
        expect(html).toContain("Passwords do not match");
      });

      test("POST /setup/ with short password shows error", async () => {
        const getResponse = await handleRequest(mockRequest("/setup/"));
        const csrfToken = getSetupCsrfToken(await getResponse.text());

        const response = await handleRequest(
          mockSetupFormRequest(
            {
              admin_username: "testadmin",
              admin_password: "short",
              admin_password_confirm: "short",
              currency_code: "GBP",
            },
            csrfToken as string,
          ),
        );
        expect(response.status).toBe(400);
        const html = await response.text();
        expect(html).toContain("at least 8 characters");
      });

      test("POST /setup/ with invalid currency shows error", async () => {
        const getResponse = await handleRequest(mockRequest("/setup/"));
        const csrfToken = getSetupCsrfToken(await getResponse.text());

        const response = await handleRequest(
          mockSetupFormRequest(
            {
              admin_username: "testadmin",
              admin_password: "mypassword123",
              admin_password_confirm: "mypassword123",
              currency_code: "INVALID",
            },
            csrfToken as string,
          ),
        );
        expect(response.status).toBe(400);
        const html = await response.text();
        expect(html).toContain("Currency code must be 3 uppercase letters");
      });

      test("POST /setup/ without accepting agreement shows error", async () => {
        const getResponse = await handleRequest(mockRequest("/setup/"));
        const csrfToken = getSetupCsrfToken(await getResponse.text());

        const response = await handleRequest(
          mockSetupFormRequest(
            {
              admin_username: "testadmin",
              admin_password: "mypassword123",
              admin_password_confirm: "mypassword123",
              currency_code: "GBP",
              accept_agreement: "", // Explicitly not accepting
            },
            csrfToken as string,
          ),
        );
        expect(response.status).toBe(400);
        const html = await response.text();
        expect(html).toContain("must accept the Data Controller Agreement");
      });

      test("POST /setup/ normalizes lowercase currency to uppercase", async () => {
        const getResponse = await handleRequest(mockRequest("/setup/"));
        const csrfToken = getSetupCsrfToken(await getResponse.text());

        const response = await handleRequest(
          mockSetupFormRequest(
            {
              admin_username: "testadmin",
              admin_password: "mypassword123",
              admin_password_confirm: "mypassword123",
              currency_code: "usd",
            },
            csrfToken as string,
          ),
        );
        expectRedirect("/setup/complete")(response);
      });

      test("POST /setup/ returns 503 when completeSetup fails", async () => {
        const { spyOn } = await import("#test-compat");
        const { settingsApi } = await import("#lib/db/settings.ts");

        const getResponse = await handleRequest(mockRequest("/setup/"));
        const csrfToken = getSetupCsrfToken(await getResponse.text());

        await withMocks(
          () => ({
            mockCompleteSetup: spyOn(settingsApi, "completeSetup").mockRejectedValue(
              new Error("Database error"),
            ),
            mockConsoleError: spyOn(console, "error").mockImplementation(() => {}),
          }),
          async () => {
            const response = await handleRequest(
              mockSetupFormRequest(
                {
                  admin_username: "testadmin",
                  admin_password: "mypassword123",
                  admin_password_confirm: "mypassword123",
                  currency_code: "GBP",
                },
                csrfToken as string,
              ),
            );
            expect(response.status).toBe(503);
            const text = await response.text();
            expect(text).toContain("Temporary Error");
          },
        );
      });

      test("PUT /setup/ redirects to /setup/ (unsupported method)", async () => {
        const response = await awaitTestRequest("/setup/", { method: "PUT" });
        // PUT method falls through routeSetup (returns null), then redirects to /setup/
        expectRedirect("/setup")(response);
      });

      test("setup form works with full browser flow simulation", async () => {
        // This test simulates what a real browser does:
        // 1. GET /setup/ - browser receives the page with CSRF token
        // 2. User fills form and submits
        // 3. Browser sends POST with signed CSRF token

        // Step 1: GET the setup page
        const getResponse = await handleRequest(
          new Request("http://localhost/setup/", {
            method: "GET",
            headers: { host: "localhost" },
          }),
        );
        expect(getResponse.status).toBe(200);

        // Extract CSRF token from the HTML body
        const csrfToken = getSetupCsrfToken(await getResponse.text());
        expect(csrfToken).not.toBeNull();

        // Step 2: Simulate browser POST with signed CSRF token
        const postResponse = await handleRequest(
          mockSetupFormRequest(
            {
              admin_username: "testadmin",
              admin_password: "mypassword123",
              admin_password_confirm: "mypassword123",
              currency_code: "GBP",
            },
            csrfToken as string,
          ),
        );

        // This should succeed - the full flow should work
        expectRedirect("/setup/complete")(postResponse);
      });

      test("setup form works when accessed via /setup (no trailing slash)", async () => {
        // GET /setup (no trailing slash)
        const getResponse = await handleRequest(
          new Request("http://localhost/setup", {
            method: "GET",
            headers: { host: "localhost" },
          }),
        );
        expect(getResponse.status).toBe(200);

        const csrfToken = getSetupCsrfToken(await getResponse.text());
        expect(csrfToken).not.toBeNull();

        // POST to /setup (no trailing slash) with signed CSRF token
        const postResponse = await handleRequest(
          mockSetupFormRequest(
            {
              admin_username: "testadmin",
              admin_password: "mypassword123",
              admin_password_confirm: "mypassword123",
              currency_code: "GBP",
            },
            csrfToken as string,
          ),
        );

        expectRedirect("/setup/complete")(postResponse);
      });

      test("GET /setup/complete redirects to setup when not yet complete", async () => {
        const response = await handleRequest(mockRequest("/setup/complete"));
        expectRedirect("/setup/")(response);
      });
    });

    describe("when setup already complete", () => {
      test("GET /setup/ redirects to home", async () => {
        const response = await handleRequest(mockRequest("/setup/"));
        expectRedirect("/")(response);
      });

      test("POST /setup/ redirects to home", async () => {
        const response = await handleRequest(
          mockFormRequest("/setup/", {
            admin_password: "newpassword123",
            admin_password_confirm: "newpassword123",
            currency_code: "EUR",
          }),
        );
        expectRedirect("/")(response);
      });

      test("GET /setup/complete shows success page when setup is done", async () => {
        const response = await handleRequest(mockRequest("/setup/complete"));
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain("Setup Complete");
      });
    });
  });

  describe("audit logging", () => {
    test("logs activity when setup is completed", async () => {
      resetDb();
      await createTestDb();

      const getResponse = await handleRequest(mockRequest("/setup/"));
      const csrfToken = getSetupCsrfToken(await getResponse.text());

      await handleRequest(
        mockSetupFormRequest(
          {
            admin_username: "testadmin",
            admin_password: "mypassword123",
            admin_password_confirm: "mypassword123",
            currency_code: "USD",
          },
          csrfToken as string,
        ),
      );

      const logs = await getAllActivityLog();
      expect(logs.some((l) => l.message.includes("Initial setup completed"))).toBe(true);
    });
  });

  describe("setup routes (currency code default)", () => {
    test("POST /setup/ with empty currency code defaults to GBP", async () => {
      resetDb();
      await createTestDb();

      const getResponse = await handleRequest(mockRequest("/setup/"));
      const csrfToken = getSetupCsrfToken(await getResponse.text());
      expect(csrfToken).not.toBeNull();

      const response = await handleRequest(
        mockSetupFormRequest(
          {
            admin_username: "testadmin",
            admin_password: "mypassword123",
            admin_password_confirm: "mypassword123",
            currency_code: "", // Empty defaults to GBP
          },
          csrfToken as string,
        ),
      );
      expectRedirect("/setup/complete")(response);
    });
  });

});
