import { expect } from "@std/expect";
import { afterEach, beforeEach, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { bunnyCdnApi } from "#shared/bunny-cdn.ts";
import { getAllActivityLog } from "#shared/db/activityLog.ts";
import { backupPrefix, backupTimestamp, dbName } from "#shared/db/backup.ts";
import { ALL_SETTINGS_KEYS, settings } from "#shared/db/settings.ts";
import { uploadRaw } from "#shared/storage.ts";
import {
  adminFormPost,
  createTestBuiltSite,
  describeWithEnv,
  expectRedirectWithFlash,
  setTestEnv,
  testCookie,
} from "#test-utils";

/** A built site database URL whose backups land under a site-specific prefix. */
const SITE_DB_URL = "libsql://01ABC-client-site.lite.bunnydb.net";

/** Seed a fresh backup for the given site so the pre-update gate passes. */
const seedSiteBackup = (dbUrl: string): Promise<string> =>
  uploadRaw(
    new Uint8Array([1]),
    `${backupPrefix(dbName(dbUrl))}${backupTimestamp()}.zip`,
  );

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

/** Stub the GitHub release fetch + asset download. */
const stubReleaseFetch = () =>
  stub(globalThis, "fetch", (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("releases/latest")) {
      return Promise.resolve(
        new Response(JSON.stringify(MOCK_RELEASE), { status: 200 }),
      );
    }
    return Promise.resolve(
      new Response("console.log('updated')", { status: 200 }),
    );
  });

describeWithEnv("POST /admin/built-sites/:id/update", { db: true }, () => {
  let storageTmp: string;
  let restoreEnv: () => void;

  beforeEach(() => {
    // The host's Bunny key plus local storage for the per-site backup gate,
    // set as one env layer so teardown can't leak BUNNY_API_KEY into the
    // "without BUNNY_API_KEY" suite below.
    storageTmp = Deno.makeTempDirSync();
    restoreEnv = setTestEnv({
      BUNNY_API_KEY: "host-key",
      LOCAL_STORAGE_PATH: storageTmp,
    });
  });

  afterEach(() => {
    settings.clearTestOverrides();
    restoreEnv?.();
    if (storageTmp) Deno.removeSync(storageTmp, { recursive: true });
  });

  test("deploys the latest release to the site's own script", async () => {
    const site = await createTestBuiltSite({
      bunnyScriptId: "8500",
      dbUrl: SITE_DB_URL,
      name: "Update Me",
    });
    await seedSiteBackup(SITE_DB_URL);
    const fetchStub = stubReleaseFetch();
    const deployStub = stub(bunnyCdnApi, "deployScriptCode", () =>
      Promise.resolve({ ok: true as const }),
    );
    try {
      const { response } = await adminFormPost(
        `/admin/built-sites/${site.id}/update`,
      );
      expectRedirectWithFlash(
        `/admin/built-sites/${site.id}/edit`,
        expect.stringContaining(
          "Updated 'Update Me' to 2099-01-01 - Big Update",
        ),
      )(response);

      // Deployed to the site's script id, not this host's.
      expect(deployStub.calls[0]!.args[1]).toBe("8500");

      const logs = await getAllActivityLog();
      expect(
        logs.some((l) => l.message.includes("Updated built site 'Update Me'")),
      ).toBe(true);
    } finally {
      deployStub.restore();
      fetchStub.restore();
    }
  });

  test("errors when the site has no Bunny script ID", async () => {
    const site = await createTestBuiltSite({ name: "No Script" });
    const { response } = await adminFormPost(
      `/admin/built-sites/${site.id}/update`,
    );
    expectRedirectWithFlash(
      `/admin/built-sites/${site.id}/edit`,
      expect.stringContaining("no Bunny script ID"),
      false,
    )(response);
  });

  test("surfaces a deploy failure", async () => {
    const site = await createTestBuiltSite({
      bunnyScriptId: "8501",
      dbUrl: SITE_DB_URL,
      name: "Deploy Fails",
    });
    await seedSiteBackup(SITE_DB_URL);
    const fetchStub = stubReleaseFetch();
    const deployStub = stub(bunnyCdnApi, "deployScriptCode", () =>
      Promise.resolve({ error: "upload failed (500)", ok: false as const }),
    );
    try {
      const { response } = await adminFormPost(
        `/admin/built-sites/${site.id}/update`,
      );
      expectRedirectWithFlash(
        `/admin/built-sites/${site.id}/edit`,
        expect.stringContaining("Update failed"),
        false,
      )(response);
    } finally {
      deployStub.restore();
      fetchStub.restore();
    }
  });

  test("refuses to start when another task is in progress", async () => {
    const site = await createTestBuiltSite({
      bunnyScriptId: "8502",
      dbUrl: SITE_DB_URL,
      name: "Busy Host",
    });
    await seedSiteBackup(SITE_DB_URL);
    await settings.update.currentTask("other-task");
    settings.invalidateCache();
    await settings.loadKeys(ALL_SETTINGS_KEYS);
    const fetchStub = stubReleaseFetch();
    try {
      const { response } = await adminFormPost(
        `/admin/built-sites/${site.id}/update`,
      );
      expectRedirectWithFlash(
        `/admin/built-sites/${site.id}/edit`,
        expect.stringContaining("already in progress"),
        false,
      )(response);
    } finally {
      fetchStub.restore();
      await settings.update.currentTask("");
    }
  });

  test("blocks the update when the site has no backup in the last hour", async () => {
    const site = await createTestBuiltSite({
      bunnyScriptId: "8504",
      dbUrl: SITE_DB_URL,
      name: "No Backup",
    });
    // No backup is seeded for this site, so the gate refuses the update.
    const { response } = await adminFormPost(
      `/admin/built-sites/${site.id}/update`,
    );
    expectRedirectWithFlash(
      `/admin/built-sites/${site.id}/edit`,
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
      bunnyScriptId: "8503",
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
});

describeWithEnv(
  "POST /admin/built-sites/:id/update without BUNNY_API_KEY",
  { db: true },
  () => {
    test("errors when the host has no Bunny API key", async () => {
      const site = await createTestBuiltSite({
        bunnyScriptId: "8600",
        name: "No Host Key",
      });
      const { response } = await adminFormPost(
        `/admin/built-sites/${site.id}/update`,
      );
      expectRedirectWithFlash(
        `/admin/built-sites/${site.id}/edit`,
        expect.stringContaining("BUNNY_API_KEY is not configured"),
        false,
      )(response);
    });
  },
);
