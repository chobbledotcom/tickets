import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { builderApi } from "#lib/builder.ts";
import { bunnyCdnApi } from "#lib/bunny-cdn.ts";
import { getAllBuiltSites } from "#lib/db/built-sites.ts";
import { settings } from "#lib/db/settings.ts";
import { handleRequest } from "#routes";
import {
  adminFormPost,
  awaitTestRequest,
  describeWithEnv,
  expectAdminRedirect,
  expectFlash,
  expectHtmlResponse,
  expectRedirect,
  FLASH_TEST_ID,
  flashCookieHeader,
  mockRequest,
  testCookie,
  withMocks,
} from "#test-utils";

/** Stub all Bunny + GitHub APIs for a successful build */
const stubSuccessfulBuild = () => ({
  fetchStub: stub(globalThis, "fetch", (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("releases/latest")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            tag_name: "v2026-01-01-000000",
            name: "Test Release",
            published_at: "2026-01-01T00:00:00Z",
            assets: [
              {
                name: "bunny-script.ts",
                browser_download_url: "https://example.com/script.ts",
              },
            ],
          }),
          { status: 200 },
        ),
      );
    }
    if (url.includes("example.com/script.ts")) {
      return Promise.resolve(
        new Response("console.log('code')", { status: 200 }),
      );
    }
    return Promise.resolve(new Response("error", { status: 500 }));
  }),
  createStub: stub(bunnyCdnApi, "createEdgeScript", () =>
    Promise.resolve({
      ok: true as const,
      scriptId: 42,
      pullZoneId: 99,
      defaultHostname: "https://test-42.b-cdn.net",
    }),
  ),
  updatePzStub: stub(bunnyCdnApi, "updatePullZone", () =>
    Promise.resolve({ ok: true as const }),
  ),
  secretStub: stub(bunnyCdnApi, "setEdgeScriptSecret", () =>
    Promise.resolve({ ok: true as const }),
  ),
  publishStub: stub(bunnyCdnApi, "publishEdgeScript", () =>
    Promise.resolve({ ok: true as const }),
  ),
  encKeyStub: stub(builderApi, "generateEncryptionKey", () => "dGVzdGtleQ=="),
  dbTestStub: stub(builderApi, "testDbConnection", () =>
    Promise.resolve({ ok: true as const }),
  ),
});

describeWithEnv(
  "server (admin builder)",
  {
    db: true,
    env: { CAN_BUILD_SITES: "true" },
  },
  () => {
    afterEach(() => {
      settings.clearTestOverrides();
    });

    test("GET /admin/builder returns 404 when CAN_BUILD_SITES is not set", async () => {
      Deno.env.delete("CAN_BUILD_SITES");
      const cookie = await testCookie();
      const response = await awaitTestRequest("/admin/builder", { cookie });
      expect(response.status).toBe(404);
    });

    test("GET /admin/builder redirects to login when not authenticated", async () => {
      const response = await handleRequest(mockRequest("/admin/builder"));
      expectAdminRedirect(response);
    });

    test("GET /admin/builder shows builder page when authenticated", async () => {
      const response = await awaitTestRequest("/admin/builder", {
        cookie: await testCookie(),
      });
      await expectHtmlResponse(
        response,
        200,
        "Site Builder",
        "Create New Site",
        "Site Name",
        "Database URL",
        "Database Token",
        "Built Sites",
      );
    });

    test("GET /admin/builder shows empty sites message", async () => {
      const response = await awaitTestRequest("/admin/builder", {
        cookie: await testCookie(),
      });
      const html = await response.text();
      expect(html).toContain("No sites have been built yet");
    });

    test("GET /admin/builder displays success flash", async () => {
      const cookie = await testCookie();
      const response = await awaitTestRequest(
        `/admin/builder?flash=${FLASH_TEST_ID}`,
        {
          cookie: `${cookie}; ${flashCookieHeader("Site created")}`,
        },
      );
      const html = await response.text();
      expect(html).toContain("Site created");
    });

    test("GET /admin/builder displays error flash", async () => {
      const cookie = await testCookie();
      const response = await awaitTestRequest(
        `/admin/builder?flash=${FLASH_TEST_ID}`,
        {
          cookie: `${cookie}; ${flashCookieHeader("Build failed", false)}`,
        },
      );
      const html = await response.text();
      expect(html).toContain("Build failed");
    });

    test("POST /admin/builder returns error when site name is empty", async () => {
      const { response } = await adminFormPost("/admin/builder", {
        site_name: "",
        db_url: "libsql://test.turso.io",
        db_token: "token",
      });
      expectRedirect(response, "/admin/builder");
      expectFlash(
        response,
        expect.stringContaining("Site name is required"),
        false,
      );
    });

    test("POST /admin/builder returns error when db_url is empty", async () => {
      const { response } = await adminFormPost("/admin/builder", {
        site_name: "Test",
        db_url: "",
        db_token: "token",
      });
      expectRedirect(response, "/admin/builder");
      expectFlash(
        response,
        expect.stringContaining("Database URL is required"),
        false,
      );
    });

    test("POST /admin/builder returns error when db_token is empty", async () => {
      const { response } = await adminFormPost("/admin/builder", {
        site_name: "Test",
        db_url: "libsql://test.turso.io",
        db_token: "",
      });
      expectRedirect(response, "/admin/builder");
      expectFlash(
        response,
        expect.stringContaining("Database token is required"),
        false,
      );
    });

    test("POST /admin/builder returns error when db connection fails", async () => {
      await withMocks(
        () =>
          stub(builderApi, "testDbConnection", () =>
            Promise.resolve({
              ok: false as const,
              error: "Connection refused",
            }),
          ),
        async () => {
          const { response } = await adminFormPost("/admin/builder", {
            site_name: "Test",
            db_url: "libsql://test.turso.io",
            db_token: "token",
          });
          expectRedirect(response, "/admin/builder");
          expectFlash(
            response,
            expect.stringContaining("Database connection failed"),
            false,
          );
        },
      );
    });

    test("POST /admin/builder creates site and records it on success", async () => {
      await withMocks(stubSuccessfulBuild, async () => {
        const { response } = await adminFormPost("/admin/builder", {
          site_name: "My Test Site",
          db_url: "libsql://test.turso.io",
          db_token: "token123",
        });

        expectRedirect(response, "/admin/builder");
        expectFlash(response, expect.stringContaining("created successfully"));

        // Verify site was recorded with db credentials
        const sites = await getAllBuiltSites();
        expect(sites).toHaveLength(1);
        expect(sites[0]!.name).toBe("My Test Site");
        expect(sites[0]!.bunnyUrl).toBe("https://test-42.b-cdn.net");
        expect(sites[0]!.dbUrl).toBe("libsql://test.turso.io");
        expect(sites[0]!.dbToken).toBe("token123");
      });
    });

    test("POST /admin/builder returns error when build fails", async () => {
      await withMocks(
        () => ({
          dbTestStub: stub(builderApi, "testDbConnection", () =>
            Promise.resolve({ ok: true as const }),
          ),
          buildStub: stub(builderApi, "buildSite", () =>
            Promise.resolve({
              ok: false as const,
              error: "Create edge script failed (500): Error",
            }),
          ),
        }),
        async () => {
          const { response } = await adminFormPost("/admin/builder", {
            site_name: "Test",
            db_url: "libsql://test.turso.io",
            db_token: "token",
          });
          expectRedirect(response, "/admin/builder");
          expectFlash(
            response,
            expect.stringContaining("Create edge script failed"),
            false,
          );
        },
      );
    });

    test("POST /admin/builder returns 404 when CAN_BUILD_SITES is not set", async () => {
      Deno.env.delete("CAN_BUILD_SITES");
      const { response } = await adminFormPost("/admin/builder", {
        site_name: "Test",
        db_url: "libsql://test.turso.io",
        db_token: "token",
      });
      expect(response.status).toBe(404);
    });

    test("POST /admin/builder returns error when another task in progress", async () => {
      await settings.update.currentTask("other-task");
      settings.invalidateCache();
      await settings.loadAll();

      await withMocks(
        () => ({
          dbTestStub: stub(builderApi, "testDbConnection", () =>
            Promise.resolve({ ok: true as const }),
          ),
          buildStub: stub(builderApi, "buildSite", () =>
            Promise.resolve({
              ok: true as const,
              scriptId: 1,
              defaultHostname: "https://test.b-cdn.net",
            }),
          ),
        }),
        async () => {
          const { response } = await adminFormPost("/admin/builder", {
            site_name: "Test",
            db_url: "libsql://test.turso.io",
            db_token: "token",
          });
          expectRedirect(response, "/admin/builder");
          expectFlash(
            response,
            expect.stringContaining("already in progress"),
            false,
          );
        },
      );

      await settings.update.currentTask("");
    });

    test("GET /admin/builder shows built sites in table", async () => {
      // Build a site first
      await withMocks(stubSuccessfulBuild, async () => {
        await adminFormPost("/admin/builder", {
          site_name: "Table Test Site",
          db_url: "libsql://test.turso.io",
          db_token: "token123",
        });
      });

      const response = await awaitTestRequest("/admin/builder", {
        cookie: await testCookie(),
      });
      const html = await response.text();
      expect(html).toContain("Table Test Site");
      expect(html).toContain("test-42.b-cdn.net");
    });
  },
);
