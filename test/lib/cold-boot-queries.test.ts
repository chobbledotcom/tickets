/**
 * Locks the cold-boot database chain measured in docs/cold-start.md: warm
 * database, cold isolate — every statement of the first request is recorded
 * and the complete set asserted, so a new boot query fails loudly.
 */
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { invalidateInitDbCache } from "#shared/db/migrations.ts";
import { settings } from "#shared/db/settings.ts";
import {
  setBuildCommitForTest,
  setBuildTimestampForTest,
} from "#shared/update.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { recordQueries } from "#test-utils/record-queries.ts";

const request = (path: string): Request =>
  new Request(`http://localhost${path}`, { headers: { host: "localhost" } });

describeWithEnv("cold-boot query chain", { db: true }, () => {
  test("a cold isolate's first request runs only the expected boot queries", async () => {
    // Behave like a deployed build so recordScriptVersion takes its real
    // steady-state path (one marker read, no writes).
    setBuildTimestampForTest("2026-01-01T00:00:00.000Z");
    setBuildCommitForTest("coldboot00");
    try {
      // First request: stamps the one-off housekeeping (script version
      // markers, prune timestamps, backfill markers) exactly as an earlier
      // isolate of the same deploy would have.
      await (await handleRequest(request("/"))).text();

      // Now simulate the isolate dying and a fresh one booting against the
      // same database: forget the ready-client and settings caches.
      invalidateInitDbCache();
      settings.invalidateCache();

      const seen: string[] = [];
      const restore = recordQueries(seen);
      try {
        // A cold isolate must also re-run initDb for the recording client.
        invalidateInitDbCache();
        const response = await handleRequest(request("/"));
        await response.text();
        expect(response.status).toBeLessThan(400);
      } finally {
        restore();
      }

      const boot = {
        loadKeys: seen.filter(
          (sql) =>
            sql.startsWith("SELECT key, value FROM settings WHERE key IN") &&
            !sql.includes("latest_db_update"),
        ),
        schemaProbe: seen.filter((sql) => sql.includes("latest_db_update")),
        versionProbe: seen.filter((sql) =>
          sql.startsWith("SELECT value FROM settings WHERE key = ?"),
        ),
      };

      // One combined round trip answers "is the schema current?" AND "is the
      // migration history complete?" — the CREATE TABLE + SELECT id pair that
      // used to run on every boot must not come back.
      expect(boot.schemaProbe.length).toBe(1);
      expect(boot.schemaProbe[0]).toContain("applied_migrations");
      expect(seen.filter((sql) => sql.includes("CREATE TABLE")).length).toBe(0);
      expect(
        seen.filter((sql) => sql.includes("SELECT id FROM schema_migrations"))
          .length,
      ).toBe(0);

      // The settings loads: one version probe plus one targeted key load.
      // The script-version markers share the loadKeys SQL shape ("WHERE key
      // IN (?, ?)"), so they show up here too — but only as ONE extra read.
      expect(boot.versionProbe.length).toBe(1);
      expect(boot.loadKeys.length).toBeLessThanOrEqual(2);

      // No writes at all on a steady-state cold boot.
      expect(
        seen.filter((sql) => sql.includes("INSERT") || sql.includes("UPDATE"))
          .length,
      ).toBe(0);

      // The line in the sand: the whole first request, boot tax included.
      // If this grows, a new query joined the cold-start path — make sure it
      // is deliberate (and overlapped, not sequential) before raising it.
      expect(seen.length).toBeLessThanOrEqual(6);
    } finally {
      setBuildTimestampForTest(null);
      setBuildCommitForTest(null);
    }
  });
});
