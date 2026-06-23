import { expect } from "@std/expect";
import { beforeEach, describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { getDb } from "#shared/db/client.ts";
import { invalidateInitDbCache, resetDatabase } from "#shared/db/migrations.ts";
import { settings } from "#shared/db/settings.ts";
import {
  assertPublicHtml,
  awaitTestRequest,
  createTestDb,
  describeWithEnv,
  expectFlashRedirect,
  expectHtmlResponse,
  expectRedirect,
  getAllActivityLog,
  getSetupCsrfToken,
  invalidateTestDbCache,
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

  async function resetToBrandNewDatabase(): Promise<void> {
    await resetDatabase();
    invalidateTestDbCache();
    settings.invalidateCache();
    settings.setup.clearCache();
  }

  async function settingsTableExists(): Promise<boolean> {
    const result = await getDb().execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='settings'",
    );
    return result.rows.length > 0;
  }

  async function tableExists(table: string): Promise<boolean> {
    const result = await getDb().execute({
      args: [table],
      sql: "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
    });
    return result.rows.length > 0;
  }

  async function createEmptySettingsTable(): Promise<void> {
    await getDb().execute(
      "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
    settings.invalidateCache();
    settings.setup.clearCache();
  }

  async function schemaMarkerKeys(): Promise<string[]> {
    const result = await getDb().execute(
      "SELECT key FROM settings WHERE key IN ('latest_db_update', 'db_schema_hash') ORDER BY key",
    );
    return result.rows.map((row) => String(row.key));
  }

  describe("setup routes", () => {
    describe("when setup not complete", () => {
      beforeEach(async () => {
        // Use a fresh db without setup
        resetDb();
        await createTestDb();
      });

      test("returns not-activated page for home when setup is incomplete", async () => {
        const response = await handleRequest(mockRequest("/"));
        await expectHtmlResponse(
          response,
          503,
          "This site has not been activated yet",
        );
      });

      test("returns not-activated page without bootstrapping a missing settings table", async () => {
        await resetToBrandNewDatabase();

        const response = await handleRequest(mockRequest("/"));
        const html = await expectHtmlResponse(
          response,
          503,
          "This site has not been activated yet",
        );
        expect(html).not.toContain('http-equiv="refresh"');

        expect(await settingsTableExists()).toBe(false);
      });

      test("returns not-activated page without bootstrapping an empty settings table", async () => {
        await resetToBrandNewDatabase();
        await createEmptySettingsTable();

        const response = await handleRequest(mockRequest("/"));
        await expectHtmlResponse(
          response,
          503,
          "This site has not been activated yet",
        );

        expect(await settingsTableExists()).toBe(true);
        expect(await tableExists("listings")).toBe(false);
        expect(await schemaMarkerKeys()).toEqual([]);
      });

      test("returns not-activated page for admin when setup is incomplete", async () => {
        const response = await handleRequest(mockRequest("/admin/"));
        await expectHtmlResponse(
          response,
          503,
          "This site has not been activated yet",
        );
      });

      test("health check still works", async () => {
        const response = await handleRequest(mockRequest("/health"));
        expect(response.status).toBe(200);
        expect(await response.text()).toBe("Up :)");
      });

      test("health check works without a settings table", async () => {
        await resetToBrandNewDatabase();

        const response = await handleRequest(mockRequest("/health"));
        expect(response.status).toBe(200);
        expect(await response.text()).toBe("Up :)");
        expect(await settingsTableExists()).toBe(false);
      });

      test("static assets work without a settings table", async () => {
        await resetToBrandNewDatabase();

        const response = await handleRequest(mockRequest("/style.css"));

        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain("text/css");
        expect(await settingsTableExists()).toBe(false);
      });

      test("health and static assets work when settings DB cannot be read", async () => {
        const { stub } = await import("@std/testing/mock");
        const executeStub = stub(getDb(), "execute", () =>
          Promise.reject(new Error("db unavailable")),
        );

        try {
          const health = await handleRequest(mockRequest("/health"));
          expect(health.status).toBe(200);
          expect(await health.text()).toBe("Up :)");

          const response = await handleRequest(mockRequest("/style.css"));
          expect(response.status).toBe(200);
          expect(response.headers.get("content-type")).toContain("text/css");
        } finally {
          executeStub.restore();
        }
      });

      test("returns the temporary status page when settings DB cannot be read", async () => {
        const { stub } = await import("@std/testing/mock");
        // Drop the per-isolate "ready" cache so initDb really runs and the
        // generic DB failure propagates through initializeDatabaseForPath.
        invalidateInitDbCache();
        const executeStub = stub(getDb(), "execute", () =>
          Promise.reject(new Error("db unavailable")),
        );

        try {
          await withExpectedError(async () => {
            const response = await handleRequest(mockRequest("/"));
            await expectHtmlResponse(
              response,
              503,
              "Temporary Error",
              "status.bunny.net",
            );
          });
        } finally {
          executeStub.restore();
        }
      });

      test("GET /setup/ bootstraps a database with no settings table", async () => {
        await resetToBrandNewDatabase();

        const response = await handleRequest(mockRequest("/setup/"));

        await expectHtmlResponse(response, 200, "Initial Setup");
        expect(await settingsTableExists()).toBe(true);
      });

      test("GET /setup/ bootstraps an empty settings table with schema markers", async () => {
        await resetToBrandNewDatabase();
        await createEmptySettingsTable();

        const response = await handleRequest(mockRequest("/setup/"));

        await expectHtmlResponse(response, 200, "Initial Setup");
        expect(await settingsTableExists()).toBe(true);
        expect(await tableExists("listings")).toBe(true);
        expect(await schemaMarkerKeys()).toEqual([
          "db_schema_hash",
          "latest_db_update",
        ]);
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
        await expectFlashRedirect(
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
        await expectFlashRedirect(
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
        await expectFlashRedirect(
          "/setup/",
          expect.stringContaining("Admin Password"),
          false,
        )(response);
      });

      test("POST /setup/ with mismatched passwords shows error", async () => {
        const response = await submitSetupFormWithDefaults({
          admin_password_confirm: "different",
        });
        await expectFlashRedirect(
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
        await expectFlashRedirect(
          "/setup/",
          expect.stringContaining("at least 8 characters"),
          false,
        )(response);
      });

      test("POST /setup/ with invalid country shows error", async () => {
        const response = await submitSetupFormWithDefaults({
          country: "XX",
        });
        await expectFlashRedirect(
          "/setup/",
          expect.stringContaining("valid country"),
          false,
        )(response);
      });

      test("POST /setup/ without accepting agreement shows error", async () => {
        const response = await submitSetupFormWithDefaults({
          accept_agreement: "", // Explicitly not accepting
        });
        await expectFlashRedirect(
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
        const { settings } = await import("#shared/db/settings.ts");

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
