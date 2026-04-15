import { expect } from "@std/expect";
import { beforeEach, describe, it as test } from "@std/testing/bdd";
import { getAllActivityLog } from "#lib/db/activityLog.ts";
import { handleRequest } from "#routes";
import {
  assertJson,
  assertPublicHtml,
  awaitTestRequest,
  createTestDb,
  describeWithEnv,
  expectHtmlResponse,
  expectRedirect,
  expectRedirectWithFlash,
  getSetupCsrfToken,
  mockFormRequest,
  mockRequest,
  mockSetupFormRequest,
  resetDb,
  withExpectedError,
  withMocks,
} from "#test-utils";

describeWithEnv("server (setup)", { db: true }, () => {
  /** Get CSRF token from setup page and submit setup form with given fields */
  async function submitSetupForm(
    fields: Record<string, string>,
  ): Promise<Response> {
    const getResponse = await handleRequest(mockRequest("/setup/"));
    const csrfToken = getSetupCsrfToken(await getResponse.text());
    expect(csrfToken).not.toBeNull();
    return handleRequest(mockSetupFormRequest(fields, csrfToken as string));
  }

  /** Get CSRF token from setup page and submit with standard valid credentials + overrides */
  function submitSetupFormWithDefaults(
    overrides: Record<string, string> = {},
  ): Promise<Response> {
    return submitSetupForm({
      admin_password: "mypassword123",
      admin_password_confirm: "mypassword123",
      admin_username: "testadmin",
      country: "GB",
      ...overrides,
    });
  }

  describe("setup routes", () => {
    describe("when setup not complete", () => {
      beforeEach(async () => {
        // Use a fresh db without setup
        resetDb();
        await createTestDb();
      });

      test("redirects home to /setup/", async () => {
        const response = await handleRequest(mockRequest("/"));
        expectRedirect(response, /^\/setup$/);
      });

      test("redirects admin to /setup/", async () => {
        const response = await handleRequest(mockRequest("/admin/"));
        expectRedirect(response, /^\/setup$/);
      });

      test("health check still works", async () => {
        await assertJson(handleRequest(mockRequest("/health")), 200, (json) => {
          expect(json).toEqual({ status: "ok" });
        });
      });

      test("GET /setup/ shows setup page", async () => {
        await assertPublicHtml(
          "/setup/",
          "Initial Setup",
          "Admin Password",
          "Your Country",
          "Data Controller Agreement",
        );
      });

      test("GET /setup (without trailing slash) shows setup page", async () => {
        await assertPublicHtml("/setup", "Initial Setup");
      });

      test("POST /setup/ with valid data completes setup", async () => {
        const response = await submitSetupFormWithDefaults({
          country: "US",
        });
        expectRedirect(response, /^\/setup\/complete$/);
      });

      test("POST /setup/ without CSRF token rejects request", async () => {
        // POST without getting CSRF token first
        const response = await handleRequest(
          mockFormRequest("/setup/", {
            admin_password: "mypassword123",
            admin_password_confirm: "mypassword123",
            admin_username: "testadmin",
            country: "US",
          }),
        );
        expectRedirectWithFlash(
          "/setup/",
          expect.stringContaining("Invalid or expired form"),
          false,
        )(response);
      });

      test("POST /setup/ with invalid CSRF token rejects request", async () => {
        // Send a wrong token in the form body
        const response = await handleRequest(
          mockFormRequest("/setup/", {
            admin_password: "mypassword123",
            admin_password_confirm: "mypassword123",
            admin_username: "testadmin",
            country: "US",
            csrf_token: "wrong-token-in-form",
          }),
        );
        expectRedirectWithFlash(
          "/setup/",
          expect.stringContaining("Invalid or expired form"),
          false,
        )(response);
      });

      test("POST /setup/ with empty password shows validation error", async () => {
        const response = await submitSetupFormWithDefaults({
          admin_password: "",
          admin_password_confirm: "",
        });
        expectRedirectWithFlash(
          "/setup/",
          expect.stringContaining("Admin Password"),
          false,
        )(response);
      });

      test("POST /setup/ with mismatched passwords shows error", async () => {
        const response = await submitSetupFormWithDefaults({
          admin_password_confirm: "different",
        });
        expectRedirectWithFlash(
          "/setup/",
          expect.stringContaining("Passwords do not match"),
          false,
        )(response);
      });

      test("POST /setup/ with short password shows error", async () => {
        const response = await submitSetupFormWithDefaults({
          admin_password: "short",
          admin_password_confirm: "short",
        });
        expectRedirectWithFlash(
          "/setup/",
          expect.stringContaining("at least 8 characters"),
          false,
        )(response);
      });

      test("POST /setup/ with invalid country shows error", async () => {
        const response = await submitSetupFormWithDefaults({
          country: "XX",
        });
        expectRedirectWithFlash(
          "/setup/",
          expect.stringContaining("valid country"),
          false,
        )(response);
      });

      test("POST /setup/ without accepting agreement shows error", async () => {
        const response = await submitSetupFormWithDefaults({
          accept_agreement: "", // Explicitly not accepting
        });
        expectRedirectWithFlash(
          "/setup/",
          expect.stringContaining("must accept the Data Controller Agreement"),
          false,
        )(response);
      });

      test("POST /setup/ normalizes lowercase country to uppercase", async () => {
        const response = await submitSetupFormWithDefaults({
          country: "us",
        });
        expectRedirect(response, /^\/setup\/complete$/);
      });

      test("POST /setup/ returns 503 when completeSetup fails", async () => {
        const { stub } = await import("@std/testing/mock");
        const { settings } = await import("#lib/db/settings.ts");

        const getResponse = await handleRequest(mockRequest("/setup/"));
        const csrfToken = getSetupCsrfToken(await getResponse.text());

        await withExpectedError(async () => {
          await withMocks(
            () => ({
              mockCompleteSetup: stub(settings.setup, "complete", () =>
                Promise.reject(new Error("Database error")),
              ),
              mockConsoleError: stub(console, "error", () => {}),
            }),
            async () => {
              const response = await handleRequest(
                mockSetupFormRequest(
                  {
                    admin_password: "mypassword123",
                    admin_password_confirm: "mypassword123",
                    admin_username: "testadmin",
                    country: "GB",
                  },
                  csrfToken as string,
                ),
              );
              await expectHtmlResponse(response, 503, "Temporary Error");
            },
          );
        });
      });

      test("PUT /setup/ redirects to /setup/ (unsupported method)", async () => {
        const response = await awaitTestRequest("/setup/", { method: "PUT" });
        // PUT method falls through routeSetup (returns null), then redirects to /setup/
        expectRedirect(response, /^\/setup$/);
      });

      test("setup form works with full browser flow simulation", async () => {
        // This test simulates what a real browser does:
        // 1. GET /setup/ - browser receives the page with CSRF token
        // 2. User fills form and submits
        // 3. Browser sends POST with signed CSRF token

        // Step 1: GET the setup page
        const getResponse = await handleRequest(
          new Request("http://localhost/setup/", {
            headers: { host: "localhost" },
            method: "GET",
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
              admin_password: "mypassword123",
              admin_password_confirm: "mypassword123",
              admin_username: "testadmin",
              country: "GB",
            },
            csrfToken as string,
          ),
        );

        // This should succeed - the full flow should work
        expectRedirect(postResponse, /^\/setup\/complete$/);
      });

      test("setup form works when accessed via /setup (no trailing slash)", async () => {
        // GET /setup (no trailing slash)
        const getResponse = await handleRequest(
          new Request("http://localhost/setup", {
            headers: { host: "localhost" },
            method: "GET",
          }),
        );
        expect(getResponse.status).toBe(200);

        const csrfToken = getSetupCsrfToken(await getResponse.text());
        expect(csrfToken).not.toBeNull();

        // POST to /setup (no trailing slash) with signed CSRF token
        const postResponse = await handleRequest(
          mockSetupFormRequest(
            {
              admin_password: "mypassword123",
              admin_password_confirm: "mypassword123",
              admin_username: "testadmin",
              country: "GB",
            },
            csrfToken as string,
          ),
        );

        expectRedirect(postResponse, /^\/setup\/complete$/);
      });

      test("GET /setup/complete redirects to setup when not yet complete", async () => {
        const response = await handleRequest(mockRequest("/setup/complete"));
        expectRedirect(response, /^\/setup\/$/);
      });
    });

    describe("when setup already complete", () => {
      test("GET /setup/ redirects to home", async () => {
        const response = await handleRequest(mockRequest("/setup/"));
        expectRedirect(response, /^\/$/);
      });

      test("POST /setup/ redirects to home", async () => {
        const response = await handleRequest(
          mockFormRequest("/setup/", {
            admin_password: "newpassword123",
            admin_password_confirm: "newpassword123",
            country: "FR",
          }),
        );
        expectRedirect(response, /^\/$/);
      });

      test("GET /setup/complete shows success page when setup is done", async () => {
        await assertPublicHtml("/setup/complete", "Setup Complete");
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
            admin_password: "mypassword123",
            admin_password_confirm: "mypassword123",
            admin_username: "testadmin",
            country: "US",
          },
          csrfToken as string,
        ),
      );

      const logs = await getAllActivityLog();
      expect(
        logs.some((l) => l.message.includes("Initial setup completed")),
      ).toBe(true);
    });
  });

  describe("setup routes (country default)", () => {
    test("POST /setup/ with empty country defaults to GB", async () => {
      resetDb();
      await createTestDb();

      const response = await submitSetupFormWithDefaults({
        country: "", // Empty defaults to GB
      });
      expectRedirect(response, /^\/setup\/complete$/);
    });
  });
});
