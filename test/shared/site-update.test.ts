import { type Client, createClient } from "@libsql/client";
import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { type Stub, stub } from "@std/testing/mock";
import { ALL_SETTINGS_KEYS, settings } from "#shared/db/settings.ts";
import { siteDbApi } from "#shared/site-db.ts";
import { loadBuiltSiteUpdateState } from "#shared/site-update.ts";
import { CURRENT_SCRIPT_VERSION_KEY } from "#shared/update.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestBuiltSite } from "#test-utils/db-helpers/built-sites.ts";

const LATEST_TAG = "v2099-01-01-120000";

/** Seed an in-memory libsql client standing in for the remote site's DB. */
const seedSiteDb = async (version: string | null): Promise<Client> => {
  const client = createClient({ url: ":memory:" });
  await client.execute(
    "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)",
  );
  if (version !== null) {
    await client.execute({
      args: [CURRENT_SCRIPT_VERSION_KEY, version],
      sql: "INSERT INTO settings (key, value) VALUES (?, ?)",
    });
  }
  return client;
};

/** Store a host-known latest release and refresh the settings snapshot. */
const setLatestRelease = async (tag: string): Promise<void> => {
  await settings.update.latestScriptVersion(tag);
  await settings.update.latestScriptVersionName("2099-01-01 - Big Update");
  settings.invalidateCache();
  await settings.loadKeys(ALL_SETTINGS_KEYS);
};

/** Per-test scaffolding shared by the loadBuiltSiteUpdateState describes: a
 *  restorable createClient stub, its afterEach cleanup, and stubbers that
 *  point the site-db factory at a seeded client (or a throwing factory). Call
 *  inside a describe so the hook registers on that suite. */
const useStubbedSiteDb = (): {
  stubSiteDb: (client: Client) => void;
  stubSiteDbFactory: (factory: () => Client) => void;
} => {
  let createStub: Stub | null = null;
  afterEach(() => {
    createStub?.restore();
    createStub = null;
    settings.clearTestOverrides();
  });
  const stubSiteDbFactory = (factory: () => Client): void => {
    createStub = stub(siteDbApi, "createClient", factory);
  };
  return {
    stubSiteDb: (client) => stubSiteDbFactory(() => client),
    stubSiteDbFactory,
  };
};

describeWithEnv(
  "loadBuiltSiteUpdateState",
  { db: true, env: { BUNNY_API_KEY: "host-key" } },
  () => {
    const { stubSiteDb, stubSiteDbFactory } = useStubbedSiteDb();

    test("reports an update when the latest release is newer than the site", async () => {
      await setLatestRelease(LATEST_TAG);
      stubSiteDb(await seedSiteDb("2026-01-01T00:00:00Z"));
      const site = await createTestBuiltSite({
        dbToken: "ro",
        dbUrl: "libsql://site",
        hostingId: "8001",
        name: "Behind Site",
      });

      const state = await loadBuiltSiteUpdateState(site);

      expect(state.siteVersionLabel).toContain("2026");
      expect(state.updateAvailable).toBe(true);
      expect(state.upToDate).toBe(false);
      expect(state.providerConfigured).toBe(true);
      expect(state.hasHostingId).toBe(true);
      expect(state.siteVersionError).toBeNull();
    });

    test("reports up to date when the site is on the latest release", async () => {
      await setLatestRelease(LATEST_TAG);
      stubSiteDb(await seedSiteDb("2100-01-01T00:00:00Z"));
      const site = await createTestBuiltSite({
        dbToken: "ro",
        dbUrl: "libsql://site",
        hostingId: "8002",
        name: "Current Site",
      });

      const state = await loadBuiltSiteUpdateState(site);

      expect(state.updateAvailable).toBe(false);
      expect(state.upToDate).toBe(true);
    });

    test("leaves the version unknown when no database keys are stored", async () => {
      await setLatestRelease(LATEST_TAG);
      const site = await createTestBuiltSite({ name: "No DB Site" });

      const state = await loadBuiltSiteUpdateState(site);

      expect(state.siteVersionLabel).toBeNull();
      expect(state.siteVersionError).toBeNull();
      expect(state.updateAvailable).toBe(false);
      expect(state.upToDate).toBe(false);
      expect(state.hasHostingId).toBe(false);
    });

    test("surfaces a read error when the site's database is unreachable", async () => {
      await setLatestRelease(LATEST_TAG);
      stubSiteDbFactory(() => {
        throw new Error("connection refused");
      });
      const site = await createTestBuiltSite({
        dbToken: "ro",
        dbUrl: "libsql://unreachable",
        name: "Broken DB Site",
      });

      const state = await loadBuiltSiteUpdateState(site);

      expect(state.siteVersionLabel).toBeNull();
      expect(state.siteVersionError).toBe("connection refused");
    });

    test("cannot compare when the host has never checked for a release", async () => {
      stubSiteDb(await seedSiteDb("2026-01-01T00:00:00Z"));
      const site = await createTestBuiltSite({
        dbToken: "ro",
        dbUrl: "libsql://site",
        name: "No Latest Site",
      });

      const state = await loadBuiltSiteUpdateState(site);

      expect(state.latestVersion).toBe("");
      expect(state.siteVersionLabel).toContain("2026");
      expect(state.updateAvailable).toBe(false);
      expect(state.upToDate).toBe(false);
    });
  },
);

describeWithEnv(
  "loadBuiltSiteUpdateState (Deno site)",
  { db: true, env: { DENO_DEPLOY_TOKEN: "tok123" } },
  () => {
    const { stubSiteDb } = useStubbedSiteDb();

    test("reports providerConfigured true for a Deno site when DENO_DEPLOY_TOKEN is set", async () => {
      await setLatestRelease(LATEST_TAG);
      stubSiteDb(await seedSiteDb("2026-01-01T00:00:00Z"));
      const site = await createTestBuiltSite({
        dbToken: "ro",
        dbUrl: "libsql://site",
        hostingId: "app_abc123",
        hostingProvider: "deno",
        name: "Deno Update Site",
      });

      const state = await loadBuiltSiteUpdateState(site);

      expect(state.providerConfigured).toBe(true);
      expect(state.hasHostingId).toBe(true);
      expect(state.updateAvailable).toBe(true);
    });
  },
);
