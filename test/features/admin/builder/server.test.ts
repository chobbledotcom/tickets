import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { builtSites } from "#db/built-sites.ts";
import { ALL_SETTINGS_KEYS, settings } from "#db/settings.ts";
import { builderForm } from "#routes/admin/builder.ts";
import { builderApi } from "#shared/builder.ts";
import {
  MOCK_DB_RESULT,
  stubBuildSiteApis,
} from "#test-utils/builder-mocks.ts";

/** Stub `testDbConnection` to resolve `ok: true`. */
const stubDbOk = () =>
  stub(builderApi, "testDbConnection", () =>
    Promise.resolve({ ok: true as const }),
  );

import {
  expectFlash,
  expectHtmlResponse,
  expectRedirect,
  FLASH_TEST_ID,
  flashCookieHeader,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { withEnv } from "#test-utils/env.ts";
import {
  awaitTestRequest,
  withExpectedError,
  withMocks,
} from "#test-utils/mocks.ts";
import { TEST_SCHEDULED_KEY } from "#test-utils/scheduled.ts";
import { adminFormPost, adminGet, testCookie } from "#test-utils/session.ts";

/** Stub all Bunny + GitHub APIs for a successful build */
const stubSuccessfulBuild = () => ({
  ...stubBuildSiteApis(),
  dbTestStub: stubDbOk(),
});

/** Assert a build redirected to /admin/builder with the "created successfully"
 *  flash, then return the single recorded built site for per-test checks. */
const expectSiteCreated = async (response: Response) => {
  expectRedirect(response, "/admin/builder");
  expectFlash(response, expect.stringContaining("created successfully"));
  const sites = await builtSites.getAll();
  expect(sites).toHaveLength(1);
  return sites[0]!;
};

/** Stub `buildSite` to capture its input and return a success result. */
const stubBuildAndCapture = () => {
  const capture: {
    currentTask: string | null;
    input: Parameters<typeof builderApi.buildSite>[0] | null;
    restore?: () => void;
  } = { currentTask: null, input: null };
  return {
    buildStub: stub(builderApi, "buildSite", async (input, retain) => {
      capture.currentTask = settings.currentTask;
      capture.input = input;
      const result = {
        dbProvider: "bunny" as const,
        dbToken: "tok",
        dbUrl: "libsql://test.io",
        defaultHostname: "https://test-42.b-cdn.net",
        hostingId: "42",
        hostingProvider: "bunny" as const,
        ok: true as const,
      };
      await retain({ ...result, scheduledTaskKey: TEST_SCHEDULED_KEY });
      return result;
    }),
    capture,
    dbTestStub: stub(builderApi, "testDbConnection", () =>
      Promise.resolve({ ok: true as const }),
    ),
  };
};

test("builder form defines every field and option exactly", () => {
  expect(JSON.parse(JSON.stringify(builderForm.fields))).toEqual([
    {
      label: "Site name",
      maxlength: 64,
      minlength: 1,
      name: "site_name",
      placeholder: "My Ticket Site",
      required: true,
      type: "text",
    },
    {
      label: "Hosting provider",
      name: "hosting_provider",
      options: [
        { label: "Bunny Edge Scripting", value: "bunny" },
        { label: "Deno Deploy", value: "deno" },
      ],
      type: "select",
    },
    {
      label: "Database provider",
      name: "db_provider",
      options: [
        { label: "Bunny DB (auto-provision)", value: "bunny" },
        { label: "Turso (auto-provision)", value: "turso" },
        { label: "Manual (enter URL below)", value: "manual" },
      ],
      type: "select",
    },
    {
      hint: "Leave blank to auto-provision a database.",
      label: "Database URL",
      name: "db_url",
      placeholder: "libsql://your-db.turso.io",
      type: "url",
    },
    {
      hint: "Leave blank to auto-provision a database.",
      label: "Database token",
      name: "db_token",
      placeholder: "Database auth token",
      type: "password",
    },
  ]);
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
      using _env = withEnv({ CAN_BUILD_SITES: undefined });
      const cookie = await testCookie();
      const response = await awaitTestRequest("/admin/builder", { cookie });
      expect(response.status).toBe(404);
    });

    testRequiresAuth("/admin/builder");

    test("GET /admin/builder shows builder page when authenticated", async () => {
      const response = await adminGet("/admin/builder");
      await expectHtmlResponse(
        response,
        200,
        "Site builder",
        "Create new site",
        "Site name",
        "Database URL",
        "Database token",
        "Built sites",
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
        expect.stringContaining("Site name is required"),
        false,
      );
    });

    test("POST /admin/builder returns error when Deno Deploy is not configured", async () => {
      using _env = withEnv({
        DENO_DEPLOY_ORG_ID: undefined,
        DENO_DEPLOY_ORG_SLUG: undefined,
        DENO_DEPLOY_TOKEN: undefined,
      });
      const { response } = await adminFormPost("/admin/builder", {
        hosting_provider: "deno",
        site_name: "Deno Site",
      });
      expectRedirect(response, "/admin/builder");
      expectFlash(
        response,
        expect.stringContaining("Deno Deploy is not configured"),
        false,
      );
    });

    test("POST /admin/builder returns error when Bunny DB is not configured", async () => {
      using _env = withEnv({ BUNNY_API_KEY: undefined });
      const { response } = await adminFormPost("/admin/builder", {
        db_provider: "bunny",
        site_name: "Bunny DB Site",
      });
      expectRedirect(response, "/admin/builder");
      expectFlash(
        response,
        expect.stringContaining("Bunny database is not configured"),
        false,
      );
    });

    test("POST /admin/builder returns error when Turso is not configured", async () => {
      using _env = withEnv({
        TURSO_API_TOKEN: undefined,
        TURSO_GROUP: undefined,
        TURSO_ORGANIZATION: undefined,
      });
      const { response } = await adminFormPost("/admin/builder", {
        db_provider: "turso",
        site_name: "Turso Site",
      });
      expectRedirect(response, "/admin/builder");
      expectFlash(
        response,
        expect.stringContaining("Turso is not configured"),
        false,
      );
    });

    test("POST /admin/builder returns error when manual provider has no db_url", async () => {
      const { response } = await adminFormPost("/admin/builder", {
        db_provider: "manual",
        site_name: "Manual Site",
      });
      expectRedirect(response, "/admin/builder");
      expectFlash(
        response,
        expect.stringContaining("Database URL is required"),
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

        // Verify site was recorded with db credentials from buildResult
        const site = await expectSiteCreated(response);
        expect(site.name).toBe("My Test Site");
        expect(site.siteUrl).toBe("https://test-42.b-cdn.net");
        expect(site.dbUrl).toBe("libsql://test.turso.io");
        expect(site.dbToken).toBe("token123");
        expect(site.hostingId).toBe("42");
        expect(site.assignable).toBe(false);
      });
    });

    test("POST /admin/builder auto-creates database when db_url is blank", async () => {
      await withMocks(stubSuccessfulBuild, async () => {
        const { response } = await adminFormPost("/admin/builder", {
          db_url: "",
          site_name: "Auto DB Site",
        });

        const site = await expectSiteCreated(response);
        expect(site.name).toBe("Auto DB Site");
        expect(site.dbUrl).toBe(MOCK_DB_RESULT.value.dbUrl);
        expect(site.dbToken).toBe(MOCK_DB_RESULT.value.dbToken);
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
        const sites = await builtSites.getAll();
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

    test("fails if a provider reports success without retaining the site", async () => {
      await withMocks(
        () => ({
          buildStub: stub(builderApi, "buildSite", () =>
            Promise.resolve({
              dbProvider: "bunny" as const,
              dbToken: "token",
              dbUrl: "libsql://test.io",
              defaultHostname: "child.example.test",
              hostingId: "42",
              hostingProvider: "bunny" as const,
              ok: true as const,
            }),
          ),
          dbTestStub: stubDbOk(),
        }),
        async () => {
          const errorStub = stub(console, "error", () => {});
          try {
            const { response } = await withExpectedError(() =>
              adminFormPost("/admin/builder", {
                db_token: "token",
                db_url: "libsql://test.io",
                site_name: "Unretained",
              }),
            );
            expect(response.status).toBe(503);
            expect(
              errorStub.calls.some((call) =>
                call.args.some((arg) =>
                  String(arg).includes(
                    "Built site was published before it was retained",
                  ),
                ),
              ),
            ).toBe(true);
          } finally {
            errorStub.restore();
          }
        },
      );
    });

    test("POST /admin/builder returns 404 when CAN_BUILD_SITES is not set", async () => {
      using _env = withEnv({ CAN_BUILD_SITES: undefined });
      const { response } = await adminFormPost("/admin/builder", {
        db_token: "token",
        db_url: "libsql://test.turso.io",
        site_name: "Test",
      });
      expect(response.status).toBe(404);
    });

    test("POST /admin/builder returns error when another task in progress", async () => {
      await settings.update.currentTask("other-task");
      settings.invalidateCache();
      await settings.loadKeys(ALL_SETTINGS_KEYS);

      await withMocks(
        () => ({
          buildStub: stub(builderApi, "buildSite", () =>
            Promise.resolve({
              dbProvider: "bunny" as const,
              dbToken: "tok",
              dbUrl: "libsql://test.io",
              defaultHostname: "https://test.b-cdn.net",
              hostingId: "1",
              hostingProvider: "bunny" as const,
              ok: true as const,
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

    test("POST /admin/builder passes deno hosting_provider to buildSite", async () => {
      using _env = withEnv({
        DENO_DEPLOY_ORG_ID: "test-org",
        DENO_DEPLOY_ORG_SLUG: "test-org",
        DENO_DEPLOY_TOKEN: "test-token",
      });
      await withMocks(
        () => stubBuildAndCapture(),
        async ({ capture }) => {
          const { response } = await adminFormPost("/admin/builder", {
            db_token: "tok",
            db_url: "libsql://test.io",
            hosting_provider: "deno",
            site_name: "Deno Site",
          });
          expectRedirect(response, "/admin/builder");
          expect(capture.input?.hostingProvider).toBe("deno");
          expect(capture.currentTask).toBe("builder");
          expect(settings.currentTask).toBe("");
        },
      );
    });

    test("POST /admin/builder passes turso db_provider to buildSite", async () => {
      using _env = withEnv({
        TURSO_API_TOKEN: "test-token",
        TURSO_GROUP: "test-group",
        TURSO_ORGANIZATION: "test-org",
      });
      await withMocks(
        () => stubBuildAndCapture(),
        async ({ capture }) => {
          const { response } = await adminFormPost("/admin/builder", {
            db_provider: "turso",
            db_token: "tok",
            db_url: "libsql://test.turso.io",
            site_name: "Turso Site",
          });
          expectRedirect(response, "/admin/builder");
          expect(capture.input?.dbProvider).toBe("turso");
        },
      );
    });

    test("POST /admin/builder passes undefined dbProvider when db_provider is manual", async () => {
      await withMocks(
        () => stubBuildAndCapture(),
        async ({ capture }) => {
          await adminFormPost("/admin/builder", {
            db_provider: "manual",
            db_url: "libsql://test.io",
            site_name: "Manual DB Site",
          });
          expect(capture.input?.dbProvider).toBeUndefined();
        },
      );
    });
  },
);
