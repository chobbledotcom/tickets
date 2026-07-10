import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { spy } from "@std/testing/mock";
import { getDb, insert } from "#shared/db/client.ts";
import { SLOT_INDEX } from "#shared/db/migrations/booking-slot-index.ts";
import { assertLiveTableColumns } from "#shared/db/migrations/schema-assertions.ts";
import {
  currentSchemaColumnsPresentIn,
  runMigration,
} from "#shared/db/migrations/schema-sync.ts";
import { MIGRATIONS, type Migration } from "#shared/db/migrations.ts";
import { describeWithEnv, indexExists } from "#test-utils";
import {
  downgradeListingDomainToLegacyNames,
  tableRowCount,
} from "./migration-test-helpers.ts";

/**
 * Verify-naming and schema-assertion tests — split from the restore loop in
 * `migration-restore.test.ts` so each file stays under the ~400-line guidance.
 * These tests drop a single schema object, assert verify() names it in the
 * failure message, and (where relevant) confirm a sibling migration's verify()
 * is unaffected.
 */
describeWithEnv("db > migration verify", { db: true, triggers: true }, () => {
  const migrationById = (id: string): Migration =>
    MIGRATIONS.find((m) => m.id === id)!;

  const seedSentinelListing = (): Promise<unknown> =>
    getDb().execute(
      insert("listings", {
        created: "2024-01-01T00:00:00Z",
        max_attendees: 10,
        name: "sentinel-listing",
      }),
    );

  test("verify reads the live schema from the primary, not a replica", async () => {
    // A replica can lag behind the DDL a migration just committed, so verify()
    // must read its own writes from the primary or it reports a freshly-created
    // table as missing. libsql routes "write"-mode batches to the primary and
    // "read"-mode batches to a (possibly stale) replica.
    const client = getDb();
    const batchSpy = spy(client, "batch");
    try {
      await migrationById("2026-06-16_email_templates").verify();
    } finally {
      batchSpy.restore();
    }

    const schemaReads = batchSpy.calls.filter(({ args }) =>
      (args[0] as Array<{ sql: string }>).some((stmt) =>
        stmt.sql.includes("pragma_table_info"),
      ),
    );
    expect(schemaReads.length).toBeGreaterThan(0);
    for (const call of schemaReads) {
      expect(call.args[1]).toBe("write");
    }
  });

  test("a fully-migrated database satisfies every migration's verify()", async () => {
    for (const migration of MIGRATIONS) {
      await migration.verify();
    }
  });

  test("narrowed verify fails only for the owning migration", async () => {
    // Drop an index owned solely by the activity-log-index migration.
    await getDb().execute("DROP INDEX IF EXISTS idx_activity_log_listing_id");

    await expect(
      migrationById("2026-06-15_activity_log_listing_id_index").verify(),
    ).rejects.toThrow("idx_activity_log_listing_id");

    // A migration that does not own that index is unaffected — the old
    // full-schema verify would have failed here too.
    await migrationById("2026-06-12_sumup_checkouts").verify();
  });

  test("verify names the missing object", async () => {
    await getDb().execute("DROP TABLE IF EXISTS attendee_statuses");
    await expect(
      migrationById("2026-06-14_attendee_statuses").verify(),
    ).rejects.toThrow("missing table attendee_statuses");
  });

  test("the slot-index verify demands the widened columns, not bare existence", async () => {
    // The widening migrations recreate the slot index under its OLD name, so a
    // name-existence check cannot tell a landed widening from a stale pre-drop
    // definition that somehow survived. Simulate that survivor: same name,
    // pre-widening column list.
    const slotIndex = SLOT_INDEX;
    await getDb().execute(`DROP INDEX IF EXISTS ${slotIndex}`);
    await getDb().execute(
      `CREATE UNIQUE INDEX ${slotIndex} ON listing_attendees ` +
        "(listing_id, attendee_id, start_at, parent_listing_id)",
    );
    await expect(
      migrationById("2026-07-05_package_slot_identity").verify(),
    ).rejects.toThrow("package_group_id");
    // Both widening migrations share the check: the 06-23 verify's own
    // requirement is satisfied by the stale survivor (name + columns exist),
    // so only the live-definition check can catch it.
    await expect(
      migrationById("2026-06-23_attendee_order_parent").verify(),
    ).rejects.toThrow("package_group_id");
    // An ABSENT index reads as lacking every column — never a silent pass.
    await getDb().execute(`DROP INDEX IF EXISTS ${slotIndex}`);
    await expect(
      migrationById("2026-07-05_package_slot_identity").verify(),
    ).rejects.toThrow("absent");
    // Re-running the real up() restores the widened index and verify passes.
    await migrationById("2026-07-05_package_slot_identity").up();
    await migrationById("2026-07-05_package_slot_identity").verify();
    expect(await indexExists(slotIndex)).toBe(true);
  });

  test("schema assertions use context-specific missing table and column messages", () => {
    const live = { tables: new Map([["legacy", new Set(["id"])]]) };

    expect(() =>
      assertLiveTableColumns("appSchema", live, "missing", ["id"]),
    ).toThrow("Database schema verification failed: missing table missing");
    expect(() =>
      assertLiveTableColumns("legacy", live, "missing", ["id"]),
    ).toThrow("Cannot migrate missing: missing expected legacy table");
    expect(() =>
      assertLiveTableColumns("appSchema", live, "legacy", ["name"]),
    ).toThrow(
      "Database schema verification failed: legacy missing column(s): name",
    );
    expect(() =>
      assertLiveTableColumns("migration", live, "legacy", ["name"]),
    ).toThrow("Migration verification failed: legacy missing column(s): name");
  });

  test("schema column selection rejects unknown tables", () => {
    expect(() =>
      currentSchemaColumnsPresentIn("missing_schema_table", new Set()),
    ).toThrow("Unknown schema table missing_schema_table");
  });

  test("runMigration ignores idempotent duplicate-create errors", async () => {
    await runMigration("CREATE TABLE duplicate_probe (id TEXT)");
    await runMigration("CREATE TABLE duplicate_probe (id TEXT)");
  });

  test("runMigration rethrows non-idempotent errors", async () => {
    await expect(
      runMigration("SELECT * FROM missing_probe_table"),
    ).rejects.toThrow("missing_probe_table");
  });

  test("verify names legacy tables that should be absent", async () => {
    await getDb().execute("CREATE TABLE events (id TEXT)");
    await expect(
      migrationById("2026-06-14_rename_events_to_listings").verify(),
    ).rejects.toThrow("legacy table events still present");
  });

  test("tableRowCount returns the count for populated tables", async () => {
    const before = await tableRowCount("listings");
    await seedSentinelListing();
    expect(await tableRowCount("listings")).toBe(before + 1);
  });

  test("a migration's verify names a missing trigger it owns", async () => {
    await getDb().execute(
      "DROP TRIGGER IF EXISTS trg_listing_attendees_aggregates_insert",
    );
    await expect(
      migrationById("2026-06-16_listing_aggregates").verify(),
    ).rejects.toThrow(
      "missing trigger trg_listing_attendees_aggregates_insert",
    );
  });

  test("the baseline schema verify names a missing trigger", async () => {
    // The baseline reconcile verifies the whole schema, triggers included.
    await getDb().execute(
      "DROP TRIGGER IF EXISTS trg_listing_attendees_aggregates_delete",
    );
    await expect(
      migrationById("2026-06-11_current_schema").verify(),
    ).rejects.toThrow(
      "missing trigger trg_listing_attendees_aggregates_delete",
    );
  });

  describe("rename migration verify", () => {
    const rename = () => migrationById("2026-06-14_rename_events_to_listings");

    test("rejects while legacy event tables are still present", async () => {
      await downgradeListingDomainToLegacyNames();
      await expect(rename().verify()).rejects.toThrow(
        "Migration verification failed",
      );
    });

    test("resolves after up() renames everything to listing", async () => {
      await downgradeListingDomainToLegacyNames();
      await rename().up();
      await rename().verify();
    });
  });

  describe("overlap index migration on pre-rename database", () => {
    const overlapIdx = () =>
      migrationById("2026-06-13_event_attendees_overlap_index");

    test("up() is a no-op when legacy 'events' table exists", async () => {
      await downgradeListingDomainToLegacyNames();
      // Must not throw (would fail with "no such table: main.listings" before fix)
      await overlapIdx().up();
    });

    test("verify() passes when legacy 'events' table exists", async () => {
      await downgradeListingDomainToLegacyNames();
      // Defers to rename migration — nothing to verify yet
      await overlapIdx().verify();
    });
  });
});
