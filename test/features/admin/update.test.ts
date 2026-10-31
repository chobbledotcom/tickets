import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { backupKey, backupTimestamp } from "#db/backup-storage.ts";
import { ALL_SETTINGS_KEYS, settings } from "#db/settings.ts";
import type { BunnyApiResult } from "#shared/bunny-api.ts";
import { bunnyCdnApi } from "#shared/bunny-cdn.ts";
import { uploadRaw } from "#shared/storage.ts";
import { setBuildTimestampForTest } from "#shared/update.ts";
import {
  expectDeployFailure,
  stubBunnyUpdateFlag,
  stubUpdateFetch,
  useLocalStoragePath,
} from "#test-utils/_shared-site-update.ts";
import { expectFlash, expectRedirect } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { withEnv } from "#test-utils/env.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";
import { stubReleaseFetch, withMocks } from "#test-utils/mocks.ts";
import { adminFormPost, adminGet } from "#test-utils/session.ts";
import { withVirtualBackoff } from "#test-utils/virtual-time.ts";

/** Persist a checked release (and its display name) as the host's settings. */
const storeRelease = async (version: string, name?: string): Promise<void> => {
  await settings.update.latestScriptVersion(version);
  if (name !== undefined) await settings.update.latestScriptVersionName(name);
  settings.invalidateCache();
  await settings.loadKeys(ALL_SETTINGS_KEYS);
};

/** Seed one fresh backup, so the deploy's backup gate passes. */
const seedBackup = (): Promise<string> =>
  uploadRaw(new Uint8Array([1]), backupKey(backupTimestamp()));

/** The stubs a guarded deploy runs behind: the code upload answering `upload`,
 * the release and code fetches, and the update-flag secret write. */
const deployStubs = (upload: BunnyApiResult = { ok: true as const }) => ({
  deployStub: stub(bunnyCdnApi, "deployScriptCode", () =>
    Promise.resolve(upload),
  ),
  fetchStub: stubUpdateFetch(),
  flagStub: stubBunnyUpdateFlag(),
});

/** State a successful deploy needs: a production build date, a newer checked
 * release, and a fresh backup. */
const readyToDeploy = async (): Promise<void> => {
  setBuildTimestampForTest("2026-01-01T00:00:00Z");
  await storeRelease("v2099-01-01-120000", "2099-01-01 - Big Update");
  await seedBackup();
};

describeWithEnv("admin update routes", { db: true }, () => {
  useLocalStoragePath();

  afterEach(() => {
    settings.clearTestOverrides();
    setBuildTimestampForTest(null);
  });

  test("declares the check and deploy routes", async () => {
    // A static or destructured import would make the test-only-export scan
    // count every adminHandlers export as test-only, so the routes load the
    // way the area loader loads them: dynamic import, member access.
    const update = await import("#routes/admin/update.ts");
    expect(Object.keys(update.adminHandlers).toSorted()).toEqual([
      "GET /admin/update",
      "POST /admin/update",
      "POST /admin/update/check",
    ]);
  });

  test("shows the update page", async () => {
    const response = await adminGet("/admin/update");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Check for Updates");
  });

  test("shows the newer release when one is available", async () => {
    setBuildTimestampForTest("2026-01-01T00:00:00Z");
    await storeRelease("v2099-01-01-120000", "2099-01-01 - Big Update");
    const html = await (await adminGet("/admin/update")).text();
    expect(html).toContain("Update Available");
    expect(html).toContain("2099-01-01 - Big Update");
  });

  test("shows no update available when the stored release is not newer", async () => {
    await storeRelease("v2025-01-01-000000", "2025-01-01 - Old");
    const html = await (await adminGet("/admin/update")).text();
    expect(html).toContain("No Update Available");
  });

  test("check stores the release and reports it as available", async () => {
    setBuildTimestampForTest("2026-01-01T00:00:00Z");
    await withMocks(stubReleaseFetch, async () => {
      const { response } = await adminFormPost("/admin/update/check");
      expectRedirect(response, "/admin/update");
      expectFlash(response, expect.stringContaining("Update available"));
      settings.invalidateCache();
      await settings.loadKeys(ALL_SETTINGS_KEYS);
      expect(settings.latestScriptVersion).toBe("v2099-01-01-120000");
      expect(settings.latestScriptVersionName).toBe("2099-01-01 - Big Update");
    });
  });

  test("check reports the running release as the latest when it is newer than the build", async () => {
    setBuildTimestampForTest("2099-12-31T23:59:59Z");
    await withMocks(stubReleaseFetch, async () => {
      const { response } = await adminFormPost("/admin/update/check");
      expectFlash(response, expect.stringContaining("latest version"));
    });
  });

  test("check reports the GitHub failure", async () => {
    using _fetch = stubFetch(new Response("Not Found", { status: 404 }));
    const { response } = await adminFormPost("/admin/update/check");
    expectRedirect(response, "/admin/update");
    expectFlash(response, expect.stringContaining("Failed to check"), false);
  });

  test("deploy refuses when no release is checked", async () => {
    await storeRelease("");
    const { response } = await adminFormPost("/admin/update");
    expectRedirect(response, "/admin/update");
    expectFlash(
      response,
      expect.stringContaining("No update available"),
      false,
    );
  });

  test("deploy refuses when the checked release is not newer than the build", async () => {
    await storeRelease("v2026-01-01-000000");
    const { response } = await adminFormPost("/admin/update");
    expectFlash(
      response,
      expect.stringContaining("No update available"),
      false,
    );
  });

  test("deploy refuses without a recent backup", async () => {
    setBuildTimestampForTest("2026-01-01T00:00:00Z");
    await storeRelease("v2099-01-01-120000");
    using _env = withEnv({ BUNNY_SCRIPT_ID: "42" });
    // The stubs only serve the mutant path that skips the backup gate; the
    // real path must stop at the gate and never reach a deploy.
    await withMocks(deployStubs, async () => {
      const { response } = await withVirtualBackoff(() =>
        adminFormPost("/admin/update"),
      );
      expectFlash(
        response,
        expect.stringContaining("No database backup in the last hour"),
        false,
      );
    });
  });

  test("deploy updates the script and reports the new release", async () => {
    await readyToDeploy();
    using _env = withEnv({ BUNNY_SCRIPT_ID: "42" });
    await withMocks(deployStubs, async ({ deployStub }) => {
      const { response } = await withVirtualBackoff(() =>
        adminFormPost("/admin/update"),
      );
      expectRedirect(response, "/admin/update");
      expectFlash(response, expect.stringContaining("Updated to"));
      expect(deployStub.calls.length).toBe(1);
    });
  });

  test("deploy reports the upload failure", async () => {
    await readyToDeploy();
    using _env = withEnv({ BUNNY_SCRIPT_ID: "42" });
    await withMocks(
      () =>
        deployStubs({
          error: "Upload script code failed (500): Server Error",
          ok: false as const,
        }),
      async () => expectDeployFailure(),
    );
  });
});
