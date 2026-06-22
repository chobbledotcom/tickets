import { type Client, createClient } from "@libsql/client";
import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { type Stub, stub } from "@std/testing/mock";
import { queryOne } from "#shared/db/client.ts";
import { ALL_SETTINGS_KEYS, settings } from "#shared/db/settings.ts";
import { siteDbApi } from "#shared/site-db.ts";
import { loadBuiltSiteUpdateState } from "#shared/site-update.ts";
import {
  CURRENT_SCRIPT_VERSION_KEY,
  readRecordedScriptCommit,
  recordScriptVersion,
  setBuildCommitForTest,
  setBuildTimestampForTest,
} from "#shared/update.ts";
import { createTestBuiltSite, describeWithEnv } from "#test-utils";

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

describeWithEnv(
  "loadBuiltSiteUpdateState",
  { db: true, env: { BUNNY_API_KEY: "host-key" } },
  () => {
    let createStub: Stub | null;

    afterEach(() => {
      createStub?.restore();
      createStub = null;
      settings.clearTestOverrides();
    });

    /** Point the site-db factory at a seeded in-memory client. */
    const stubSiteDb = (client: Client): void => {
      createStub = stub(siteDbApi, "createClient", () => client);
    };

    test("reports an update when the latest release is newer than the site", async () => {
      await setLatestRelease(LATEST_TAG);
      stubSiteDb(await seedSiteDb("2026-01-01T00:00:00Z"));
      const site = await createTestBuiltSite({
        bunnyScriptId: "8001",
        dbToken: "ro",
        dbUrl: "libsql://site",
        name: "Behind Site",
      });

      const state = await loadBuiltSiteUpdateState(site);

      expect(state.siteVersionLabel).toContain("2026");
      expect(state.updateAvailable).toBe(true);
      expect(state.upToDate).toBe(false);
      expect(state.bunnyConfigured).toBe(true);
      expect(state.hasScriptId).toBe(true);
      expect(state.siteVersionError).toBeNull();
    });

    test("reports up to date when the site is on the latest release", async () => {
      await setLatestRelease(LATEST_TAG);
      stubSiteDb(await seedSiteDb("2100-01-01T00:00:00Z"));
      const site = await createTestBuiltSite({
        bunnyScriptId: "8002",
        dbToken: "ro",
        dbUrl: "libsql://site",
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
      expect(state.hasScriptId).toBe(false);
    });

    test("surfaces a read error when the site's database is unreachable", async () => {
      await setLatestRelease(LATEST_TAG);
      createStub = stub(siteDbApi, "createClient", () => {
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

describeWithEnv("recordScriptVersion", { db: true }, () => {
  afterEach(() => {
    setBuildTimestampForTest(null);
    setBuildCommitForTest(null);
  });

  const readVersion = (): Promise<{ value: string } | null> =>
    queryOne<{ value: string }>("SELECT value FROM settings WHERE key = ?", [
      CURRENT_SCRIPT_VERSION_KEY,
    ]);

  test("records the running build's version", async () => {
    setBuildTimestampForTest("2026-06-19T12:00:00Z");
    await recordScriptVersion();
    expect((await readVersion())?.value).toBe("2026-06-19T12:00:00Z");
  });

  test("records the running build's commit alongside the version", async () => {
    setBuildTimestampForTest("2026-06-19T12:00:00Z");
    setBuildCommitForTest("abc123def4567890");
    await recordScriptVersion();
    // Reads back through the public helper a restore uses to surface it.
    expect(await readRecordedScriptCommit()).toBe("abc123def4567890");
  });

  test("records the commit even when the timestamp is empty", async () => {
    // The two markers are independent — a missing timestamp must not suppress
    // the commit (and vice versa).
    setBuildTimestampForTest(null);
    setBuildCommitForTest("deadbeefcafe");
    await recordScriptVersion();
    expect(await readVersion()).toBeNull();
    expect(await readRecordedScriptCommit()).toBe("deadbeefcafe");
  });

  test("readRecordedScriptCommit returns empty string when unrecorded", async () => {
    // Older backups / dev builds have no commit row.
    expect(await readRecordedScriptCommit()).toBe("");
  });

  test("leaves the stored version untouched when it is unchanged", async () => {
    setBuildTimestampForTest("2026-06-19T12:00:00Z");
    await recordScriptVersion();
    // Second call takes the unchanged fast-path and must not corrupt the value.
    await recordScriptVersion();
    expect((await readVersion())?.value).toBe("2026-06-19T12:00:00Z");
  });

  test("is a no-op for development builds with no version", async () => {
    setBuildTimestampForTest(null);
    await recordScriptVersion();
    expect(await readVersion()).toBeNull();
  });

  test("swallows database errors so it can never block boot", async () => {
    setBuildTimestampForTest("2026-06-19T12:00:00Z");
    const { getDb } = await import("#shared/db/client.ts");
    await getDb().execute("DROP TABLE settings");
    // Reading/writing the missing table throws inside; the call must still resolve.
    await recordScriptVersion();
  });
});
