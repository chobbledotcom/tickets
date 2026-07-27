/**
 * Migration verify() behaviour: error naming, scoping to the owning migration,
 * primary-pinned schema reads, and the guard that every additive migration has
 * a restore case (see helpers.ts for the sharded restore/chain suites).
 */
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { spy } from "@std/testing/mock";
import { getDb } from "#shared/db/client.ts";
import type { Trigger } from "#shared/db/migrations/schema/types.ts";
import { assertLiveTableColumns } from "#shared/db/migrations/schema-assertions.ts";
import {
  currentSchemaColumnsPresentIn,
  runMigration,
} from "#shared/db/migrations/schema-sync.ts";
import { loadMigrations } from "#shared/db/migrations.ts";
import {
  additiveMigrations,
  dropOwnedObjects,
  migrationById,
  seedSentinelListing,
  triggerExists,
} from "#test/integration/db/migration-restore/helpers.ts";
import {
  downgradeListingDomainToLegacyNames,
  tableRowCount,
} from "#test/test-utils/db/migration-test-helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { indexExists } from "#test-utils/migrations.ts";

const MIGRATIONS = await loadMigrations();
const RESTORE_TRIGGER: Trigger = {
  name: "trg_restore_source_log",
  sql: `CREATE TRIGGER IF NOT EXISTS trg_restore_source_log
AFTER INSERT ON restore_trigger_source
FOR EACH ROW
BEGIN
  INSERT INTO restore_trigger_log (source_id) VALUES (NEW.id);
END`,
  table: "restore_trigger_source",
  uses: { restore_trigger_log: ["source_id"] },
};

describeWithEnv(
  "db > migration verify behaviour",
  { db: true, triggers: true },
  () => {
    test("every additive migration is covered by a restore case", () => {
      // Guards against a future migration slipping through with no restore test.
      // The non-additive migrations excluded here are: the baseline reconcile, the
      // events→listings rename, the transfers time-int rebuild, the transfers
      // backfill (data-only), the nine column-drop migrations (drop_transfers_
      // currency, drop_listing_income, drop_listing_attendee_refunded,
      // drop_listing_attendee_price_paid, drop_attendees_price_paid,
      // drop_attendees_remaining_balance, drop_modifiers_total_revenue,
      // group_flat_prices — which backfills group_listings.package_price into
      // listing_prices then drops the column — and drop_listings_day_prices — which
      // rebuilds the day_count rows from listings.day_prices then drops that
      // column), the ticket-count-no-quantity trigger rewrite (it drops and
      // re-syncs the aggregate triggers from SCHEMA, owning no additive objects to
      // rebuild), the attendees.kind NOT NULL tightening (an empty-`requires`
      // constraint rebuild owning no additive objects to drop/restore), and the
      // attendee-listings-tag settings rewrite (data-only; covered by its own
      // data test), the historical built-site prune marker, listing_image_thumb
      // (historically added a column that
      // first_class_images now drops), remove_broken_image_records (data-only;
      // covered by its own data test), and removal-only migrations whose
      // absent-table checks cannot be rebuilt by a restore case. enabled_features
      // now owns the triggers that keep saved feature data and visibility in step.
      // The built-site marker drop is also removal-only. The activity backfill
      // completion migration is data-only and covered by its direct tests. The
      // five retired payment-table declarations own historical schema only, and
      // the final payment-table retirement is removal-only.
      expect(additiveMigrations.length).toBe(MIGRATIONS.length - 28);
    });

    test("restores triggers attached to a dropped table", async () => {
      await getDb().execute(
        "CREATE TABLE restore_trigger_source (id INTEGER PRIMARY KEY)",
      );
      await getDb().execute(
        "CREATE TABLE restore_trigger_log (source_id INTEGER NOT NULL)",
      );
      await getDb().execute(RESTORE_TRIGGER.sql);
      const droppedTriggers = await dropOwnedObjects(
        { newTables: [RESTORE_TRIGGER.table] },
        [RESTORE_TRIGGER],
      );

      expect(droppedTriggers).toEqual([RESTORE_TRIGGER]);
      expect(await triggerExists(RESTORE_TRIGGER.name)).toBe(false);

      await getDb().execute(
        "CREATE TABLE restore_trigger_source (id INTEGER PRIMARY KEY)",
      );
      for (const trigger of droppedTriggers) await getDb().execute(trigger.sql);
      await getDb().execute(
        "INSERT INTO restore_trigger_source DEFAULT VALUES",
      );

      expect(await triggerExists(RESTORE_TRIGGER.name)).toBe(true);
      expect(await tableRowCount("restore_trigger_log")).toBe(1);
    });

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
      const slotIndex = "idx_listing_attendees_listing_attendee_start";
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
      ).toThrow(
        "Migration verification failed: legacy missing column(s): name",
      );
    });

    test("schema column selection rejects unknown tables", () => {
      expect(() =>
        currentSchemaColumnsPresentIn("missing_schema_table", new Set()),
      ).toThrow("Unknown schema table missing_schema_table");
    });

    test("runMigration ignores idempotent duplicate errors but rethrows real ones", async () => {
      await runMigration("CREATE TABLE duplicate_probe (id TEXT)");
      await runMigration("CREATE TABLE duplicate_probe (id TEXT)");

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
      await seedSentinelListing();
      expect(await tableRowCount("listings")).toBeGreaterThan(0);
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
      const rename = () =>
        migrationById("2026-06-14_rename_events_to_listings");

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
  },
);
