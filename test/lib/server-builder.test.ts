import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { builderApi } from "#shared/builder.ts";
import { bunnyCdnApi } from "#shared/bunny-cdn.ts";
import { getAllBuiltSites } from "#shared/db/built-sites.ts";
import { ALL_SETTINGS_KEYS, settings } from "#shared/db/settings.ts";

const MOCK_DB_RESULT = {
  dbId: "db_auto123",
  dbToken: "auto-token",
  dbUrl: "libsql://auto.lite.bunnydb.net",
  ok: true as const,
};

/** Stub `testDbConnection` to resolve `ok: true`. The build-error and
 *  task-in-progress tests both pair a per-test `buildSite` stub with this
 *  identical `testDbConnection` stub; hoisting it avoids restating the same
 *  `stub(builderApi, "testDbConnection", …)` line in each. */
const stubDbOk = () =>
  stub(builderApi, "testDbConnection", () =>
    Promise.resolve({ ok: true as const }),
  );

import {
  adminFormPost,
  adminGet,
  awaitTestRequest,
  describeWithEnv,
  expectFlash,
  expectHtmlResponse,
  expectRedirect,
  FLASH_TEST_ID,
  flashCookieHeader,
  setTestEnv,
  testCookie,
  testRequiresAuth,
  withMocks,
} from "#test-utils";

/** Stub all Bunny + GitHub APIs for a successful build */
const stubSuccessfulBuild = () => ({
  createDbStub: stub(builderApi, "createDatabase", () =>
    Promise.resolve(MOCK_DB_RESULT),
  ),
  createStub: stub(bunnyCdnApi, "createEdgeScript", () =>
    Promise.resolve({
      defaultHostname: "https://test-42.b-cdn.net",
      ok: true as const,
      pullZoneId: 99,
      scriptId: 42,
    }),
  ),
  dbTestStub: stubDbOk(),
  encKeyStub: stub(builderApi, "generateEncryptionKey", () => "dGVzdGtleQ=="),
  fetchStub: stub(globalThis, "fetch", (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("releases/latest")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            assets: [
              {
                browser_download_url: "https://example.com/script.ts",
                name: "bunny-script.ts",
              },
            ],
            name: "Test Release",
            published_at: "2026-01-01T00:00:00Z",
            tag_name: "v2026-01-01-000000",
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
  publishStub: stub(bunnyCdnApi, "publishEdgeScript", () =>
    Promise.resolve({ ok: true as const }),
  ),
  secretStub: stub(bunnyCdnApi, "setEdgeScriptSecret", () =>
    Promise.resolve({ ok: true as const }),
  ),
  updatePzStub: stub(bunnyCdnApi, "updatePullZone", () =>
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

    /** POST a build request and assert it redirects to /admin/builder with
     *  an error flash containing `message`. Collapses the shared
     *  `adminFormPost` + `expectRedirect` + `expectFlash(false)` body used by
     *  the build-fails, task-in-progress, and db-connection-fails tests. */
    const expectBuildFlashError = async (message: string): Promise<void> => {
      const { response } = await adminFormPost("/admin/builder", {
        db_token: "token",
        db_url: "libsql://test.turso.io",
        site_name: "Test",
      });
      expectRedirect(response, "/admin/builder");
      expectFlash(response, expect.stringContaining(message), false);
    };

    test("GET /admin/builder returns 404 when CAN_BUILD_SITES is not set", async () => {
      const restore = setTestEnv({ CAN_BUILD_SITES: undefined });
      try {
        const cookie = await testCookie();
        const response = await awaitTestRequest("/admin/builder", { cookie });
        expect(response.status).toBe(404);
      } finally {
        restore();
      }
    });

    testRequiresAuth("/admin/builder");

    test("GET /admin/builder shows builder page when authenticated", async () => {
      const response = await adminGet("/admin/builder");
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
      const response = await adminGet("/admin/builder");
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
        db_token: "token",
        db_url: "libsql://test.turso.io",
        site_name: "",
      });
      expectRedirect(response, "/admin/builder");
      expectFlash(
        response,
        expect.stringContaining("Site Name is required"),
        false,
      );
    });

    test("POST /admin/builder returns error when db connection fails with provided URL", async () => {
      await withMocks(
        () =>
          stub(builderApi, "testDbConnection", () =>
            Promise.resolve({
              error: "Connection refused",
              ok: false as const,
            }),
          ),
        async () => {
          const { response } = await adminFormPost("/admin/builder", {
            db_token: "token",
            db_url: "libsql://test.turso.io",
            site_name: "Test",
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

    test("POST /admin/builder passes empty token to testDbConnection when db_token omitted", async () => {
      await withMocks(
        () => ({
          dbTestStub: stub(builderApi, "testDbConnection", () =>
            Promise.resolve({ error: "no auth", ok: false as const }),
          ),
        }),
        async ({ dbTestStub }) => {
          await adminFormPost("/admin/builder", {
            db_url: "libsql://test.turso.io",
            site_name: "NoTokenSite",
          });
          expect(dbTestStub.calls).toHaveLength(1);
          expect(dbTestStub.calls[0]!.args[1]).toBe("");
        },
      );
    });

    test("POST /admin/builder creates site and records it on success with provided db", async () => {
      await withMocks(stubSuccessfulBuild, async () => {
        const { response } = await adminFormPost("/admin/builder", {
          db_token: "token123",
          db_url: "libsql://test.turso.io",
          site_name: "My Test Site",
        });

        expectRedirect(response, "/admin/builder");
        expectFlash(response, expect.stringContaining("created successfully"));

        // Verify site was recorded with db credentials from buildResult
        const sites = await getAllBuiltSites();
        expect(sites).toHaveLength(1);
        expect(sites[0]!.name).toBe("My Test Site");
        expect(sites[0]!.bunnyUrl).toBe("https://test-42.b-cdn.net");
        expect(sites[0]!.dbUrl).toBe("libsql://test.turso.io");
        expect(sites[0]!.dbToken).toBe("token123");
        expect(sites[0]!.bunnyScriptId).toBe("42");
        expect(sites[0]!.assignable).toBe(false);
      });
    });

    test("POST /admin/builder auto-creates database when db_url is blank", async () => {
      await withMocks(stubSuccessfulBuild, async () => {
        const { response } = await adminFormPost("/admin/builder", {
          db_url: "",
          site_name: "Auto DB Site",
        });

        expectRedirect(response, "/admin/builder");
        expectFlash(response, expect.stringContaining("created successfully"));

        const sites = await getAllBuiltSites();
        expect(sites).toHaveLength(1);
        expect(sites[0]!.name).toBe("Auto DB Site");
        expect(sites[0]!.dbUrl).toBe(MOCK_DB_RESULT.dbUrl);
        expect(sites[0]!.dbToken).toBe(MOCK_DB_RESULT.dbToken);
      });
    });

    test("POST /admin/builder passes assignable flag", async () => {
      await withMocks(stubSuccessfulBuild, async () => {
        const { response } = await adminFormPost("/admin/builder", {
          assignable: "1",
          db_token: "token123",
          db_url: "libsql://test.turso.io",
          site_name: "Assignable Site",
        });

        expectRedirect(response, "/admin/builder");
        const sites = await getAllBuiltSites();
        expect(sites).toHaveLength(1);
        expect(sites[0]!.assignable).toBe(true);
      });
    });

    test("POST /admin/builder returns error when build fails", async () => {
      await withMocks(
        () => ({
          buildStub: stub(builderApi, "buildSite", () =>
            Promise.resolve({
              error: "Create edge script failed (500): Error",
              ok: false as const,
            }),
          ),
          dbTestStub: stubDbOk(),
        }),
        async () => {
          await expectBuildFlashError("Create edge script failed");
        },
      );
    });

    test("POST /admin/builder returns 404 when CAN_BUILD_SITES is not set", async () => {
      const restore = setTestEnv({ CAN_BUILD_SITES: undefined });
      try {
        const { response } = await adminFormPost("/admin/builder", {
          db_token: "token",
          db_url: "libsql://test.turso.io",
          site_name: "Test",
        });
        expect(response.status).toBe(404);
      } finally {
        restore();
      }
    });

    test("POST /admin/builder returns error when another task in progress", async () => {
      await settings.update.currentTask("other-task");
      settings.invalidateCache();
      await settings.loadKeys(ALL_SETTINGS_KEYS);

      await withMocks(
        () => ({
          buildStub: stub(builderApi, "buildSite", () =>
            Promise.resolve({
              dbToken: "tok",
              dbUrl: "libsql://test.io",
              defaultHostname: "https://test.b-cdn.net",
              ok: true as const,
              scriptId: 1,
            }),
          ),
          dbTestStub: stubDbOk(),
        }),
        async () => {
          await expectBuildFlashError("already in progress");
        },
      );

      await settings.update.currentTask("");
    });

    test("GET /admin/builder shows built sites in table", async () => {
      // Build a site first
      await withMocks(stubSuccessfulBuild, async () => {
        await adminFormPost("/admin/builder", {
          db_token: "token123",
          db_url: "libsql://test.turso.io",
          site_name: "Table Test Site",
        });
      });

      const response = await adminGet("/admin/builder");
      const html = await response.text();
      expect(html).toContain("Table Test Site");
      expect(html).toContain("test-42.b-cdn.net");
    });
  },
);
