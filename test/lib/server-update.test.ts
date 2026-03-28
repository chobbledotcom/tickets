import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { settings } from "#lib/db/settings.ts";
import { setBuildTimestampForTest } from "#lib/update.ts";
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
  setTestEnv,
  testCookie,
  withMocks,
} from "#test-utils";

/** GitHub release API response for a valid release */
const MOCK_RELEASE = {
  tag_name: "v2099-01-01-120000",
  name: "2099-01-01 - Big Update",
  published_at: "2099-01-01T12:00:00Z",
  assets: [
    {
      name: "bunny-script.ts",
      browser_download_url:
        "https://github.com/chobbledotcom/tickets/releases/download/v2099-01-01-120000/bunny-script.ts",
    },
  ],
};

/** GitHub release API response with no assets */
const MOCK_RELEASE_NO_ASSET = {
  tag_name: "v2099-01-01-120000",
  name: "2099-01-01 - No Asset",
  published_at: "2099-01-01T12:00:00Z",
  assets: [],
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

/** Stub fetch for a full successful deploy (GitHub release + asset + Bunny upload + publish) */
const stubSuccessfulDeploy = () =>
  stub(globalThis, "fetch", (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("github.com") && url.includes("releases/latest")) {
      return Promise.resolve(
        new Response(JSON.stringify(MOCK_RELEASE), { status: 200 }),
      );
    }
    if (url.includes("github.com") && url.includes("download")) {
      return Promise.resolve(
        new Response("console.log('updated')", { status: 200 }),
      );
    }
    if (url.includes("bunny.net")) {
      return Promise.resolve(new Response("{}", { status: 200 }));
    }
    return Promise.resolve(new Response("Unexpected", { status: 500 }));
  });

describeWithEnv("server (admin update)", { db: true }, () => {
  afterEach(() => {
    settings.clearTestOverrides();
    setBuildTimestampForTest(null);
  });

  describe("GET /admin/update", () => {
    test("redirects to login when not authenticated", async () => {
      const response = await handleRequest(mockRequest("/admin/update"));
      expectAdminRedirect(response);
    });

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

    test("shows cannot update when Bunny not configured", async () => {
      const restore = setTestEnv({
        BUNNY_API_KEY: undefined,
        BUNNY_SCRIPT_ID: undefined,
      });
      try {
        simulateProductionBuild();
        await settings.update.latestScriptVersion("v2099-01-01-120000");
        await settings.update.latestScriptVersionName(
          "2099-01-01 - Big Update",
        );
        settings.invalidateCache();
        await settings.loadAll();

        const response = await awaitTestRequest("/admin/update", {
          cookie: await testCookie(),
        });
        const html = await response.text();
        expect(html).toContain("Cannot update automatically");
        expect(html).not.toContain("Update Now");
      } finally {
        restore();
      }
    });

    test("shows Update Now button when Bunny is configured", async () => {
      const restore = setTestEnv({
        BUNNY_API_KEY: "test-key",
        BUNNY_SCRIPT_ID: "12345",
      });
      try {
        simulateProductionBuild();
        await settings.update.latestScriptVersion("v2099-01-01-120000");
        await settings.update.latestScriptVersionName(
          "2099-01-01 - Big Update",
        );
        settings.invalidateCache();
        await settings.loadAll();

        const response = await awaitTestRequest("/admin/update", {
          cookie: await testCookie(),
        });
        const html = await response.text();
        expect(html).toContain("Update Now");
        expect(html).not.toContain("Cannot update automatically");
      } finally {
        restore();
      }
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

    test("redirects with error when Bunny env vars are missing", async () => {
      await setupForDeploy();

      let callCount = 0;
      await withMocks(
        () =>
          stub(globalThis, "fetch", () => {
            callCount++;
            if (callCount === 1) {
              return Promise.resolve(
                new Response(JSON.stringify(MOCK_RELEASE), { status: 200 }),
              );
            }
            return Promise.resolve(
              new Response("console.log('hello')", { status: 200 }),
            );
          }),
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
      const restore = setTestEnv({
        BUNNY_API_KEY: "test-key",
        BUNNY_SCRIPT_ID: "12345",
      });
      try {
        await setupForDeploy();
        await withMocks(stubSuccessfulDeploy, async () => {
          const { response } = await adminFormPost("/admin/update");
          expectRedirect(response, "/admin/update");
          expectFlash(response, expect.stringContaining("Updated to"));
        });
      } finally {
        restore();
      }
    });

    test("redirects with error when asset download fails", async () => {
      const restore = setTestEnv({
        BUNNY_API_KEY: "test-key",
        BUNNY_SCRIPT_ID: "12345",
      });
      try {
        await setupForDeploy();
        await withMocks(
          () =>
            stub(globalThis, "fetch", (input: string | URL | Request) => {
              const url = String(input);
              if (url.includes("releases/latest")) {
                return Promise.resolve(
                  new Response(JSON.stringify(MOCK_RELEASE), { status: 200 }),
                );
              }
              return Promise.resolve(
                new Response("Not Found", { status: 404 }),
              );
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
      } finally {
        restore();
      }
    });

    test("redirects with error when Bunny upload fails", async () => {
      const restore = setTestEnv({
        BUNNY_API_KEY: "test-key",
        BUNNY_SCRIPT_ID: "12345",
      });
      try {
        await setupForDeploy();
        await withMocks(
          () =>
            stub(globalThis, "fetch", (input: string | URL | Request) => {
              const url = String(input);
              if (url.includes("releases/latest")) {
                return Promise.resolve(
                  new Response(JSON.stringify(MOCK_RELEASE), { status: 200 }),
                );
              }
              if (url.includes("download")) {
                return Promise.resolve(new Response("code", { status: 200 }));
              }
              return Promise.resolve(
                new Response("Server Error", { status: 500 }),
              );
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
      } finally {
        restore();
      }
    });

    test("redirects with error when Bunny publish fails", async () => {
      const restore = setTestEnv({
        BUNNY_API_KEY: "test-key",
        BUNNY_SCRIPT_ID: "12345",
      });
      try {
        await setupForDeploy();
        await withMocks(
          () =>
            stub(globalThis, "fetch", (input: string | URL | Request) => {
              const url = String(input);
              if (url.includes("releases/latest")) {
                return Promise.resolve(
                  new Response(JSON.stringify(MOCK_RELEASE), { status: 200 }),
                );
              }
              if (url.includes("download")) {
                return Promise.resolve(new Response("code", { status: 200 }));
              }
              if (url.includes("/code")) {
                return Promise.resolve(new Response("{}", { status: 200 }));
              }
              return Promise.resolve(
                new Response("Publish Error", { status: 500 }),
              );
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
      } finally {
        restore();
      }
    });

    test("redirects with error when another task is in progress", async () => {
      const restore = setTestEnv({
        BUNNY_API_KEY: "test-key",
        BUNNY_SCRIPT_ID: "12345",
      });
      try {
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
      } finally {
        restore();
      }
    });

    test("sends correct API calls to Bunny during deploy", async () => {
      const restore = setTestEnv({
        BUNNY_API_KEY: "test-key",
        BUNNY_SCRIPT_ID: "12345",
      });
      try {
        await setupForDeploy();
        const calls: string[] = [];
        await withMocks(
          () =>
            stub(globalThis, "fetch", (input: string | URL | Request) => {
              const url = String(input);
              calls.push(url);
              if (url.includes("releases/latest")) {
                return Promise.resolve(
                  new Response(JSON.stringify(MOCK_RELEASE), { status: 200 }),
                );
              }
              if (url.includes("download")) {
                return Promise.resolve(
                  new Response("console.log('v2')", { status: 200 }),
                );
              }
              return Promise.resolve(new Response("{}", { status: 200 }));
            }),
          async () => {
            await adminFormPost("/admin/update");
            expect(
              calls.some((u) => u.includes("/compute/script/12345/code")),
            ).toBe(true);
            expect(
              calls.some((u) => u.includes("/compute/script/12345/publish")),
            ).toBe(true);
          },
        );
      } finally {
        restore();
      }
    });
  });
});
