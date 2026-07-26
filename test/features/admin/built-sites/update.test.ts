import { expect } from "@std/expect";
import { afterEach, beforeEach, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { bunnyCdnApi } from "#shared/bunny-cdn.ts";
import {
  backupKey,
  backupTimestamp,
  dbName,
} from "#shared/db/backup-storage.ts";
import { ALL_SETTINGS_KEYS, settings } from "#shared/db/settings.ts";
import { denoDeployApi } from "#shared/deno-deploy-api.ts";
import { uploadRaw } from "#shared/storage.ts";
import { useLocalStoragePath } from "#test/test-utils/_shared-site-update.ts";
import { getAllActivityLog } from "#test-utils/activity-log.ts";
import { expectFlashRedirect } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestBuiltSite } from "#test-utils/db-helpers/built-sites.ts";
import { type EnvScope, withEnv } from "#test-utils/env.ts";
import { type TempPath, tempDir } from "#test-utils/files.ts";
import { stubReleaseFetch } from "#test-utils/mocks.ts";
import { adminFormPost, testCookie } from "#test-utils/session.ts";

/** A built site database URL whose backups land in a site-specific folder. */
const SITE_DB_URL = "libsql://01ABC-client-site.lite.bunnydb.net";

/** Seed a fresh backup for the given site so the pre-update gate passes. */
const seedSiteBackup = (dbUrl: string): Promise<string> =>
  uploadRaw(new Uint8Array([1]), backupKey(backupTimestamp(), dbName(dbUrl)));

/** POST the update for a site and assert it flash-redirects to the edit page
 * with the "no hosting ID" error — the shared expectation of every provider's
 * missing-hosting-id case. */
const expectNoHostingIdError = async (siteId: number): Promise<void> => {
  const { response } = await adminFormPost(
    `/admin/built-sites/${siteId}/update`,
  );
  await expectFlashRedirect(
    `/admin/built-sites/${siteId}/update`,
    "This site has no hosting ID, so it can't be updated.",
    false,
  )(response);
};

describeWithEnv(
  "POST /admin/built-sites/:id/update",
  { db: true, env: { CAN_BUILD_SITES: "true" } },
  () => {
    let storageTmp: TempPath;
    let env: EnvScope;

    beforeEach(() => {
      // The host's Bunny key plus local storage for the per-site backup gate,
      // set as one env layer so teardown can't leak BUNNY_API_KEY into the
      // "without BUNNY_API_KEY" suite below.
      storageTmp = tempDir();
      env = withEnv({
        BUNNY_API_KEY: "host-key",
        LOCAL_STORAGE_PATH: storageTmp.path,
      });
    });

    afterEach(() => {
      settings.clearTestOverrides();
      env.dispose();
      storageTmp.dispose();
    });

    test("deploys the latest release to the site's own script", async () => {
      const site = await createTestBuiltSite({
        dbUrl: SITE_DB_URL,
        hostingId: "8500",
        name: "Update Me",
      });
      await seedSiteBackup(SITE_DB_URL);
      using _fetch = stubReleaseFetch();
      const deployStub = stub(bunnyCdnApi, "deployScriptCode", () =>
        Promise.resolve({ ok: true as const }),
      );
      try {
        const { response } = await adminFormPost(
          `/admin/built-sites/${site.id}/update`,
        );
        await expectFlashRedirect(
          `/admin/built-sites/${site.id}/update`,
          expect.stringContaining(
            "Updated 'Update Me' to 2099-01-01 - Big Update",
          ),
        )(response);

        // Deployed to the site's script id, not this host's.
        expect(deployStub.calls[0]!.args[1]).toBe("8500");

        const logs = await getAllActivityLog();
        expect(
          logs.some((l) =>
            l.message.includes("Updated built site 'Update Me'"),
          ),
        ).toBe(true);
      } finally {
        deployStub.restore();
      }
    });

    test("errors when the site has no Bunny script ID", async () => {
      const site = await createTestBuiltSite({ name: "No Script" });
      await expectNoHostingIdError(site.id);
    });

    test("surfaces a deploy failure", async () => {
      const site = await createTestBuiltSite({
        dbUrl: SITE_DB_URL,
        hostingId: "8501",
        name: "Deploy Fails",
      });
      await seedSiteBackup(SITE_DB_URL);
      using _fetch = stubReleaseFetch();
      const deployStub = stub(bunnyCdnApi, "deployScriptCode", () =>
        Promise.resolve({ error: "upload failed (500)", ok: false as const }),
      );
      try {
        const { response } = await adminFormPost(
          `/admin/built-sites/${site.id}/update`,
        );
        await expectFlashRedirect(
          `/admin/built-sites/${site.id}/update`,
          expect.stringContaining("Update failed"),
          false,
        )(response);
      } finally {
        deployStub.restore();
      }
    });

    test("refuses to start when another task is in progress", async () => {
      const site = await createTestBuiltSite({
        dbUrl: SITE_DB_URL,
        hostingId: "8502",
        name: "Busy Host",
      });
      await seedSiteBackup(SITE_DB_URL);
      await settings.update.currentTask("other-task");
      settings.invalidateCache();
      await settings.loadKeys(ALL_SETTINGS_KEYS);
      using _fetch = stubReleaseFetch();
      try {
        const { response } = await adminFormPost(
          `/admin/built-sites/${site.id}/update`,
        );
        await expectFlashRedirect(
          `/admin/built-sites/${site.id}/update`,
          expect.stringContaining("already in progress"),
          false,
        )(response);
      } finally {
        await settings.update.currentTask("");
      }
    });

    test("blocks the update when the site has no backup in the last hour", async () => {
      const site = await createTestBuiltSite({
        dbUrl: SITE_DB_URL,
        hostingId: "8504",
        name: "No Backup",
      });
      // No backup is seeded for this site, so the gate refuses the update.
      const { response } = await adminFormPost(
        `/admin/built-sites/${site.id}/update`,
      );
      await expectFlashRedirect(
        `/admin/built-sites/${site.id}/update`,
        expect.stringContaining("No backup of this site in the last hour"),
        false,
      )(response);
    });

    test("returns 404 for a non-existent built site", async () => {
      const { response } = await adminFormPost(
        "/admin/built-sites/999999/update",
      );
      expect(response.status).toBe(404);
    });

    test("requires a CSRF token", async () => {
      const site = await createTestBuiltSite({
        hostingId: "8503",
        name: "CSRF Update",
      });
      const cookie = await testCookie();
      const response = await handleRequest(
        new Request(`http://localhost/admin/built-sites/${site.id}/update`, {
          body: "",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie,
          },
          method: "POST",
        }),
      );
      expect(response.status).toBe(403);
    });
  },
);

describeWithEnv(
  "POST /admin/built-sites/:id/update without BUNNY_API_KEY",
  { db: true, env: { CAN_BUILD_SITES: "true" } },
  () => {
    test("errors when the host has no Bunny API key", async () => {
      const site = await createTestBuiltSite({
        hostingId: "8600",
        name: "No Host Key",
      });
      const { response } = await adminFormPost(
        `/admin/built-sites/${site.id}/update`,
      );
      await expectFlashRedirect(
        `/admin/built-sites/${site.id}/update`,
        expect.stringContaining("BUNNY_API_KEY is not configured"),
        false,
      )(response);
    });
  },
);

describeWithEnv(
  "POST /admin/built-sites/:id/update (Deno site)",
  { db: true, env: { CAN_BUILD_SITES: "true", DENO_DEPLOY_TOKEN: "tok123" } },
  () => {
    useLocalStoragePath();

    test("errors when the Deno site has no hostingId", async () => {
      const site = await createTestBuiltSite({
        hostingProvider: "deno",
        name: "No Deno App",
      });
      await expectNoHostingIdError(site.id);
    });

    test("deploys to a Deno app when all conditions are met", async () => {
      const site = await createTestBuiltSite({
        dbUrl: SITE_DB_URL,
        hostingId: "app_deno_8700",
        hostingProvider: "deno",
        name: "Deno Deploy Site",
      });
      await seedSiteBackup(SITE_DB_URL);
      using _fetch = stubReleaseFetch();
      const deployStub = stub(denoDeployApi, "deployCode", () =>
        Promise.resolve({ ok: true as const, value: undefined }),
      );
      const getEnvVarNamesStub = stub(denoDeployApi, "getEnvVarNames", () =>
        Promise.resolve({ ok: true as const, value: [] }),
      );
      try {
        const { response } = await adminFormPost(
          `/admin/built-sites/${site.id}/update`,
        );
        await expectFlashRedirect(
          `/admin/built-sites/${site.id}/update`,
          expect.stringContaining("Updated"),
        )(response);
        expect(deployStub.calls[0]!.args[0]).toBe("app_deno_8700");
      } finally {
        deployStub.restore();
        getEnvVarNamesStub.restore();
      }
    });
  },
);

describeWithEnv(
  "POST /admin/built-sites/:id/update (Deno site, no token)",
  { db: true, env: { CAN_BUILD_SITES: "true", DENO_DEPLOY_TOKEN: undefined } },
  () => {
    test("errors when DENO_DEPLOY_TOKEN is not configured", async () => {
      const site = await createTestBuiltSite({
        hostingId: "app_deno_9000",
        hostingProvider: "deno",
        name: "No Token Deno",
      });
      const { response } = await adminFormPost(
        `/admin/built-sites/${site.id}/update`,
      );
      await expectFlashRedirect(
        `/admin/built-sites/${site.id}/update`,
        expect.stringContaining("DENO_DEPLOY_TOKEN is not configured"),
        false,
      )(response);
    });
  },
);
