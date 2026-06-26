import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { bunnyCdnApi } from "#shared/bunny-cdn.ts";
import { backupKey, backupTimestamp } from "#shared/db/backup.ts";
import { ALL_SETTINGS_KEYS, settings } from "#shared/db/settings.ts";
import { uploadRaw } from "#shared/storage.ts";
import { setBuildTimestampForTest } from "#shared/update.ts";
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
  stubReleaseFetch,
  testCookie,
  testRequiresAuth,
  withMocks,
} from "#test-utils";

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

/** Seed a fresh backup so the pre-update gate passes. */
const seedRecentBackup = (): Promise<string> =>
  uploadRaw(new Uint8Array([1]), backupKey(backupTimestamp()));

/** Set up state for a deploy test: production build + newer version stored,
 *  plus a recent backup so the pre-update gate is satisfied. */
const setupForDeploy = async () => {
  simulateProductionBuild();
  await settings.update.latestScriptVersion("v2099-01-01-120000");
  settings.invalidateCache();
  await settings.loadKeys(ALL_SETTINGS_KEYS);
  await seedRecentBackup();
};

/** deployScriptCode + release-fetch stubs for an /admin/update deploy. */
const deployMocks = (
  opts: {
    deployResult?: Awaited<ReturnType<typeof bunnyCdnApi.deployScriptCode>>;
    download?: () => Response;
  } = {},
) => ({
  deployStub: stub(bunnyCdnApi, "deployScriptCode", () =>
    Promise.resolve(opts.deployResult ?? { ok: true as const }),
  ),
  fetchStub: stubReleaseFetch(opts.download),
});

const stubSuccessfulDeploy = () => deployMocks();

/** Production build with the given latest version + name stored, cache reloaded. */
const setLatestVersion = async (
  version: string,
  name: string,
): Promise<void> => {
  simulateProductionBuild();
  await settings.update.latestScriptVersion(version);
  await settings.update.latestScriptVersionName(name);
  settings.invalidateCache();
  await settings.loadKeys(ALL_SETTINGS_KEYS);
};

/** Fetch the /admin/update page HTML as the owner. */
const getUpdatePageHtml = async (): Promise<string> => {
  const response = await adminGet("/admin/update");
  return response.text();
};

describeWithEnv("server (admin update)", { db: true }, () => {
  let storageTmp: string;
  let restoreStorage: () => void;

  beforeEach(() => {
    // Local storage so the pre-update backup gate has somewhere to look.
    storageTmp = Deno.makeTempDirSync();
    restoreStorage = setTestEnv({ LOCAL_STORAGE_PATH: storageTmp });
  });

  afterEach(() => {
    settings.clearTestOverrides();
    setBuildTimestampForTest(null);
    restoreStorage?.();
    if (storageTmp) Deno.removeSync(storageTmp, { recursive: true });
  });

  describe("GET /admin/update", () => {
    testRequiresAuth("/admin/update");

    test("shows update page when authenticated", async () => {
      const response = await adminGet("/admin/update");
      await expectHtmlResponse(
        response,
        200,
        "Software Update",
        "Current Version",
        "Check for Updates",
      );
    });

    test("shows Development build in dev mode", async () => {
      const response = await adminGet("/admin/update");
      const html = await response.text();
      expect(html).toContain("Development build");
    });

    test("shows update available when latest version is newer", async () => {
      await setLatestVersion("v2099-01-01-120000", "2099-01-01 - Big Update");
      const html = await getUpdatePageHtml();
      expect(html).toContain("Update Available");
      expect(html).toContain("2099-01-01 - Big Update");
    });

    test("shows no update available when version is current", async () => {
      await setLatestVersion("v2025-01-01-000000", "2025-01-01 - Old");
      const html = await getUpdatePageHtml();
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
      await withMocks(stubReleaseFetch, async () => {
        const { response } = await adminFormPost("/admin/update/check");
        expectRedirect(response, "/admin/update");
      });
    });

    test("stores tag name in settings after check", async () => {
      await withMocks(stubReleaseFetch, async () => {
        await adminFormPost("/admin/update/check");
        settings.invalidateCache();
        await settings.loadKeys(ALL_SETTINGS_KEYS);
        expect(settings.latestScriptVersion).toBe("v2099-01-01-120000");
        expect(settings.latestScriptVersionName).toBe(
          "2099-01-01 - Big Update",
        );
      });
    });

    test("reports update available when release is newer", async () => {
      simulateProductionBuild();
      await withMocks(stubReleaseFetch, async () => {
        const { response } = await adminFormPost("/admin/update/check");
        expectFlash(response, expect.stringContaining("Update available"));
      });
    });

    test("reports up to date when release is older", async () => {
      setBuildTimestampForTest("2099-12-31T23:59:59Z");
      await withMocks(stubReleaseFetch, async () => {
        const { response } = await adminFormPost("/admin/update/check");
        expectFlash(response, expect.stringContaining("latest version"));
      });
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
      await settings.loadKeys(ALL_SETTINGS_KEYS);

      const { response } = await adminFormPost("/admin/update");
      expectFlash(
        response,
        expect.stringContaining("No update available"),
        false,
      );
    });

    test("blocks the update when no backup was taken in the last hour", async () => {
      // A newer version is available (passes the version check), but storage
      // holds no recent backup, so the gate refuses to deploy.
      simulateProductionBuild();
      await settings.update.latestScriptVersion("v2099-01-01-120000");
      settings.invalidateCache();
      await settings.loadKeys(ALL_SETTINGS_KEYS);

      const { response } = await adminFormPost("/admin/update");
      expectRedirect(response, "/admin/update");
      expectFlash(
        response,
        expect.stringContaining("No database backup in the last hour"),
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
        () =>
          deployMocks({
            download: () => new Response("Not Found", { status: 404 }),
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
        () =>
          deployMocks({
            deployResult: {
              error: "Upload script code failed (500): Server Error",
              ok: false as const,
            },
            download: () =>
              new Response("console.log('code')", { status: 200 }),
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
      await settings.loadKeys(ALL_SETTINGS_KEYS);

      await withMocks(stubReleaseFetch, async () => {
        const { response } = await adminFormPost("/admin/update");
        expectFlash(
          response,
          expect.stringContaining("already in progress"),
          false,
        );
      });

      await settings.update.currentTask("");
    });
  });
});
