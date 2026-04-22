import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { bunnyCdnApi } from "#lib/bunny-cdn.ts";
import { settings } from "#lib/db/settings.ts";
import { setBuildTimestampForTest } from "#lib/update.ts";
import { handleRequest as _handleRequest } from "#routes";
import {
  adminFormPost,
  awaitTestRequest,
  describeWithEnv,
  expectFlash,
  expectHtmlResponse,
  expectRedirect,
  FLASH_TEST_ID,
  flashCookieHeader,
  mockRequest as _mockRequest,
  testCookie,
  testRequiresAuth,
  withMocks,
} from "#test-utils";

/** GitHub release API response for a valid release */
const MOCK_RELEASE = {
  assets: [
    {
      browser_download_url:
        "https://github.com/chobbledotcom/tickets/releases/download/v2099-01-01-120000/bunny-script.ts",
      name: "bunny-script.ts",
    },
  ],
  name: "2099-01-01 - Big Update",
  published_at: "2099-01-01T12:00:00Z",
  tag_name: "v2099-01-01-120000",
};

/** GitHub release API response with no assets */
const MOCK_RELEASE_NO_ASSET = {
  assets: [],
  name: "2099-01-01 - No Asset",
  published_at: "2099-01-01T12:00:00Z",
  tag_name: "v2099-01-01-120000",
};

/** Simulate a production build from a known date */
const simulateProductionBuild = () => {
  setBuildTimestampForTest("2026-01-01T00:00:00Z");
};

/** Set up state for a deploy test: production build + newer version stored */
const setupForDeploy = async () => {
  simulateProductionBuild();
  await settings.update.latestScriptVersion("v2099-01-01-120000");
  settings.invalidateCache();
  await settings.loadAll();
};

/**
 * Stub fetch for GitHub API + asset download, and stub bunnyCdnApi.deployScriptCode
 * for a successful deploy. Returns mocks for cleanup.
 */
const stubSuccessfulDeploy = () => ({
  deployStub: stub(bunnyCdnApi, "deployScriptCode", () =>
    Promise.resolve({ ok: true as const }),
  ),
  fetchStub: stub(globalThis, "fetch", (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("releases/latest")) {
      return Promise.resolve(
        new Response(JSON.stringify(MOCK_RELEASE), { status: 200 }),
      );
    }
    if (url.includes("download")) {
      return Promise.resolve(
        new Response("console.log('updated')", { status: 200 }),
      );
    }
    return Promise.resolve(new Response("Unexpected", { status: 500 }));
  }),
});

describeWithEnv("server (admin update)", { db: true }, () => {
  afterEach(() => {
    settings.clearTestOverrides();
    setBuildTimestampForTest(null);
  });

  describe("GET /admin/update", () => {
    testRequiresAuth("/admin/update");

    test("shows update page when authenticated", async () => {
      const response = await awaitTestRequest("/admin/update", {
        cookie: await testCookie(),
      });
      await expectHtmlResponse(
        response,
        200,
        "Software Update",
        "Current Version",
        "Check for Updates",
      );
    });

    test("shows Development build in dev mode", async () => {
      const response = await awaitTestRequest("/admin/update", {
        cookie: await testCookie(),
      });
      const html = await response.text();
      expect(html).toContain("Development build");
    });

    test("shows update available when latest version is newer", async () => {
      simulateProductionBuild();
      await settings.update.latestScriptVersion("v2099-01-01-120000");
      await settings.update.latestScriptVersionName("2099-01-01 - Big Update");
      settings.invalidateCache();
      await settings.loadAll();

      const response = await awaitTestRequest("/admin/update", {
        cookie: await testCookie(),
      });
      const html = await response.text();
      expect(html).toContain("Update Available");
      expect(html).toContain("2099-01-01 - Big Update");
    });

    test("shows no update available when version is current", async () => {
      simulateProductionBuild();
      await settings.update.latestScriptVersion("v2025-01-01-000000");
      await settings.update.latestScriptVersionName("2025-01-01 - Old");
      settings.invalidateCache();
      await settings.loadAll();

      const response = await awaitTestRequest("/admin/update", {
        cookie: await testCookie(),
      });
      const html = await response.text();
      expect(html).toContain("No Update Available");
    });

    test("displays success flash message", async () => {
      const cookie = await testCookie();
      const response = await awaitTestRequest(
        `/admin/update?flash=${FLASH_TEST_ID}`,
        {
          cookie: `${cookie}; ${flashCookieHeader("Update available: v1")}`,
        },
      );
      const html = await response.text();
      expect(html).toContain("Update available: v1");
    });

    test("displays error flash message", async () => {
      const cookie = await testCookie();
      const response = await awaitTestRequest(
        `/admin/update?flash=${FLASH_TEST_ID}`,
        {
          cookie: `${cookie}; ${flashCookieHeader("Failed to check", false)}`,
        },
      );
      const html = await response.text();
      expect(html).toContain("Failed to check");
    });
  });

  describe("POST /admin/update/check", () => {
    test("stores latest version and redirects on success", async () => {
      await withMocks(
        () =>
          stub(globalThis, "fetch", () =>
            Promise.resolve(
              new Response(JSON.stringify(MOCK_RELEASE), { status: 200 }),
            ),
          ),
        async () => {
          const { response } = await adminFormPost("/admin/update/check");
          expectRedirect(response, "/admin/update");
        },
      );
    });

    test("stores tag name in settings after check", async () => {
      await withMocks(
        () =>
          stub(globalThis, "fetch", () =>
            Promise.resolve(
              new Response(JSON.stringify(MOCK_RELEASE), { status: 200 }),
            ),
          ),
        async () => {
          await adminFormPost("/admin/update/check");
          settings.invalidateCache();
          await settings.loadAll();
          expect(settings.latestScriptVersion).toBe("v2099-01-01-120000");
          expect(settings.latestScriptVersionName).toBe(
            "2099-01-01 - Big Update",
          );
        },
      );
    });

    test("reports update available when release is newer", async () => {
      simulateProductionBuild();
      await withMocks(
        () =>
          stub(globalThis, "fetch", () =>
            Promise.resolve(
              new Response(JSON.stringify(MOCK_RELEASE), { status: 200 }),
            ),
          ),
        async () => {
          const { response } = await adminFormPost("/admin/update/check");
          expectFlash(response, expect.stringContaining("Update available"));
        },
      );
    });

    test("reports up to date when release is older", async () => {
      setBuildTimestampForTest("2099-12-31T23:59:59Z");
      await withMocks(
        () =>
          stub(globalThis, "fetch", () =>
            Promise.resolve(
              new Response(JSON.stringify(MOCK_RELEASE), { status: 200 }),
            ),
          ),
        async () => {
          const { response } = await adminFormPost("/admin/update/check");
          expectFlash(response, expect.stringContaining("latest version"));
        },
      );
    });

    test("redirects with error on GitHub API failure", async () => {
      await withMocks(
        () =>
          stub(globalThis, "fetch", () =>
            Promise.resolve(new Response("Not Found", { status: 404 })),
          ),
        async () => {
          const { response } = await adminFormPost("/admin/update/check");
          expectRedirect(response, "/admin/update");
          expectFlash(
            response,
            expect.stringContaining("Failed to check"),
            false,
          );
        },
      );
    });
  });

  describe("POST /admin/update", () => {
    test("redirects with error when no latest version stored", async () => {
      const { response } = await adminFormPost("/admin/update");
      expectRedirect(response, "/admin/update");
      expectFlash(
        response,
        expect.stringContaining("No update available"),
        false,
      );
    });

    test("redirects with error when version is not newer", async () => {
      setBuildTimestampForTest("2099-12-31T23:59:59Z");
      await settings.update.latestScriptVersion("v2026-01-01-000000");
      settings.invalidateCache();
      await settings.loadAll();

      const { response } = await adminFormPost("/admin/update");
      expectFlash(
        response,
        expect.stringContaining("No update available"),
        false,
      );
    });

    test("redirects with error when release has no asset", async () => {
      await setupForDeploy();

      await withMocks(
        () =>
          stub(globalThis, "fetch", () =>
            Promise.resolve(
              new Response(JSON.stringify(MOCK_RELEASE_NO_ASSET), {
                status: 200,
              }),
            ),
          ),
        async () => {
          const { response } = await adminFormPost("/admin/update");
          expectRedirect(response, "/admin/update");
          expectFlash(
            response,
            expect.stringContaining("Update failed"),
            false,
          );
        },
      );
    });

    test("deploys successfully and redirects with success flash", async () => {
      await setupForDeploy();
      await withMocks(stubSuccessfulDeploy, async ({ deployStub }) => {
        const { response } = await adminFormPost("/admin/update");
        expectRedirect(response, "/admin/update");
        expectFlash(response, expect.stringContaining("Updated to"));
        expect(deployStub.calls.length).toBe(1);
      });
    });

    test("redirects with error when asset download fails", async () => {
      await setupForDeploy();
      await withMocks(
        () => ({
          deployStub: stub(bunnyCdnApi, "deployScriptCode", () =>
            Promise.resolve({ ok: true as const }),
          ),
          fetchStub: stub(
            globalThis,
            "fetch",
            (input: string | URL | Request) => {
              const url = String(input);
              if (url.includes("releases/latest")) {
                return Promise.resolve(
                  new Response(JSON.stringify(MOCK_RELEASE), { status: 200 }),
                );
              }
              return Promise.resolve(
                new Response("Not Found", { status: 404 }),
              );
            },
          ),
        }),
        async () => {
          const { response } = await adminFormPost("/admin/update");
          expectFlash(
            response,
            expect.stringContaining("Update failed"),
            false,
          );
        },
      );
    });

    test("redirects with error when Bunny deploy fails", async () => {
      await setupForDeploy();
      await withMocks(
        () => ({
          deployStub: stub(bunnyCdnApi, "deployScriptCode", () =>
            Promise.resolve({
              error: "Upload script code failed (500): Server Error",
              ok: false as const,
            }),
          ),
          fetchStub: stub(
            globalThis,
            "fetch",
            (input: string | URL | Request) => {
              const url = String(input);
              if (url.includes("releases/latest")) {
                return Promise.resolve(
                  new Response(JSON.stringify(MOCK_RELEASE), { status: 200 }),
                );
              }
              return Promise.resolve(
                new Response("console.log('code')", { status: 200 }),
              );
            },
          ),
        }),
        async () => {
          const { response } = await adminFormPost("/admin/update");
          expectFlash(
            response,
            expect.stringContaining("Update failed"),
            false,
          );
        },
      );
    });

    test("redirects with error when another task is in progress", async () => {
      await setupForDeploy();
      await settings.update.currentTask("other-task");
      settings.invalidateCache();
      await settings.loadAll();

      await withMocks(
        () =>
          stub(globalThis, "fetch", () =>
            Promise.resolve(
              new Response(JSON.stringify(MOCK_RELEASE), { status: 200 }),
            ),
          ),
        async () => {
          const { response } = await adminFormPost("/admin/update");
          expectFlash(
            response,
            expect.stringContaining("already in progress"),
            false,
          );
        },
      );

      await settings.update.currentTask("");
    });
  });
});
