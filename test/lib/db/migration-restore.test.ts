import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { spy } from "@std/testing/mock";
import { getDb, insert } from "#shared/db/client.ts";
import { assertLiveTableColumns } from "#shared/db/migrations/schema-assertions.ts";
import {
  currentSchemaColumnsPresentIn,
  runMigration,
} from "#shared/db/migrations/schema-sync.ts";
import {
  initDb,
  invalidateInitDbCache,
  LATEST_UPDATE,
  MIGRATIONS,
  type Migration,
  SCHEMA_HASH,
  type SchemaRequirement,
} from "#shared/db/migrations.ts";
import { describeWithEnv } from "#test-utils";
import {
  downgradeListingDomainToLegacyNames,
  tableRowCount,
} from "./migration-test-helpers.ts";

/**
 * "Restore from each migration" — for every additive migration, start from a
 * fully-migrated database, drop exactly the objects that migration owns, prove
 * its verify() now fails, then re-run its up() and prove verify() passes again
 * and that pre-existing data survived. This exercises the real production up()
 * and verify() for each migration in isolation, and keeps each migration's
 * declared `requires` honest against what up() actually creates.
 */
describeWithEnv("db > migration restore", { db: true, triggers: true }, () => {
  const migrationById = (id: string): Migration =>
    MIGRATIONS.find((m) => m.id === id)!;

  const tableColumns = async (table: string): Promise<Set<string>> => {
    const result = await getDb().execute(
      `SELECT name FROM pragma_table_info('${table}')`,
    );
    return new Set(result.rows.map((row) => String(row.name)));
  };

  const indexExists = async (name: string): Promise<boolean> => {
    const result = await getDb().execute({
      args: [name],
      sql: "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?",
    });
    return result.rows.length > 0;
  };

  const triggerExists = async (name: string): Promise<boolean> => {
    const result = await getDb().execute({
      args: [name],
      sql: "SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?",
    });
    return result.rows.length > 0;
  };

  // Drop a migration's owned objects in an order SQLite accepts: triggers and
  // indexes first (a column can't be dropped while a trigger or index
  // references it), then the columns added to existing tables, then the tables
  // the migration created.
  const dropOwnedObjects = async (req: SchemaRequirement): Promise<void> => {
    for (const trigger of req.triggers ?? []) {
      await getDb().execute(`DROP TRIGGER IF EXISTS ${trigger}`);
    }
    for (const index of req.indexes ?? []) {
      await getDb().execute(`DROP INDEX IF EXISTS ${index}`);
    }
    for (const [table, cols] of Object.entries(req.columns ?? {})) {
      for (const col of cols) {
        await getDb().execute(`ALTER TABLE ${table} DROP COLUMN ${col}`);
      }
    }
    for (const table of req.newTables ?? []) {
      await getDb().execute(`DROP TABLE IF EXISTS ${table}`);
    }
  };

  const seedSentinelListing = (): Promise<unknown> =>
    getDb().execute(
      insert("listings", {
        created: "2024-01-01T00:00:00Z",
        max_attendees: 10,
        name: "sentinel-listing",
      }),
    );

  const scalar = async (sql: string): Promise<unknown> => {
    const result = await getDb().execute(sql);
    return result.rows[0]?.value;
  };

  const seedPopulatedMigrationFixture = () =>
    getDb().batch(
      [
        `INSERT INTO groups (id, slug, slug_index, name, description, max_attendees)
         VALUES (901, 'migration-group', 'group-index', 'Migration Group', 'historic group', 50)`,
        `INSERT INTO listings (id, created, max_attendees, name, slug, slug_index, group_id, unit_price, max_quantity, listing_type, date, location, customisable_days, uses_logistics)
         VALUES (902, '2024-01-01T00:00:00Z', 25, 'migration-listing', 'migration-listing', 'listing-index', 901, 1200, 4, 'standard', '2024-02-01', 'Town Hall', 1, 1)`,
        `INSERT INTO attendees (id, created, price_paid, checked_in, ticket_token_index, pii_blob, status_id, remaining_balance, split_logistics_agents, phone_index)
         VALUES (903, '2024-01-02T00:00:00Z', '1800', '', 'ticket-index', '{"name":"Migration Guest"}', 1, 300, 1, 'phone-index')`,
        `INSERT INTO listing_attendees (id, listing_id, attendee_id, start_at, end_at, quantity, checked_in, price_paid, start_agent_id, end_agent_id, start_time, end_time, start_done, end_done)
         VALUES (904, 902, 903, '2024-02-01T10:00:00Z', '2024-02-01T12:00:00Z', 2, 1, 1800, NULL, NULL, '10:00', '12:00', 1, 0)`,
        `INSERT INTO processed_payments (payment_session_id, attendee_id, processed_at, ticket_tokens, failure_data)
         VALUES ('payment-session', 903, '2024-01-02T00:10:00Z', 'ticket-token', '{"code":"card_declined"}')`,
        `INSERT INTO activity_log (id, created, listing_id, message, attendee_id)
         VALUES (905, '2024-01-02T00:15:00Z', 902, 'fixture activity', 903)`,
        `INSERT INTO sumup_checkouts (reference_index, wrapped_key, metadata, sumup_id, created_at)
         VALUES ('sumup-reference', 'wrapped', '{"attendeeId":903}', 'sumup-id', '2024-01-02T00:20:00Z')`,
        `INSERT INTO questions (id, text, sort_order, display_type, assign_all)
         VALUES (906, 'Meal choice?', 7, 'select', 1)`,
        `INSERT INTO modifiers (id, name, calc_kind, calc_value, direction, active, trigger, code, code_index, scope, stock, max_per_order, min_subtotal, min_visits)
         VALUES (907, 'VIP uplift', 'fixed', 5, 'increase', 1, 'answer', '', NULL, 'listing', 20, 2, 1000, 1)`,
        `INSERT INTO answers (id, question_id, text, sort_order, modifier_id)
         VALUES (908, 906, 'Vegetarian', 3, 907)`,
        `INSERT INTO listing_questions (id, listing_id, question_id, sort_order)
         VALUES (909, 902, 906, 4)`,
        `INSERT INTO attendee_answers (id, attendee_id, answer_id, question_id)
         VALUES (910, 903, 908, 906)`,
        `INSERT INTO modifier_listings (modifier_id, listing_id)
         VALUES (907, 902)`,
        `INSERT INTO modifier_groups (modifier_id, group_id)
         VALUES (907, 901)`,
        `INSERT INTO modifier_usages (id, modifier_id, attendee_id, quantity, amount_applied, created)
         VALUES (911, 907, 903, 2, 500, '2024-01-02T00:25:00Z')`,
        `INSERT INTO holidays (id, name, start_date, end_date)
         VALUES (912, 'Fixture holiday', '2024-03-01', '2024-03-03')`,
        `INSERT INTO built_sites (id, site_data, assignable, assigned_attendee_id, assigned_listing_id, created, renewal_token_index, read_only_from)
         VALUES (913, '{"site":"fixture"}', 1, 903, 902, '2024-01-03T00:00:00Z', 'renewal-index', '')`,
        `INSERT INTO email_templates (id, subject, body)
         VALUES (914, 'Fixture subject', 'Fixture body')`,
        `INSERT INTO sms_messages (id, attendee_id, listing_id, provider_id, created)
         VALUES (915, 903, 902, 'provider-message', '2024-01-03T00:05:00Z')`,
        `INSERT INTO processed_sms_inbound (webhook_id, created)
         VALUES ('sms-webhook', '2024-01-03T00:06:00Z')`,
        `INSERT INTO contact_preferences (contact_hash, unsubscribed, visits, stats_blob, last_activity)
         VALUES ('contact-hash', 1, 5, '{}', 1700000000)`,
      ],
      "write",
    );

  const migrationIndex = (id: string): number =>
    MIGRATIONS.findIndex((migration) => migration.id === id);

  const assertPopulatedFixtureSurvived = async (
    baseMigrationId: string,
  ): Promise<void> => {
    expect(
      await scalar(
        "SELECT COUNT(*) AS value FROM listings WHERE id = 902 AND name = 'migration-listing' AND booked_quantity = 2 AND tickets_count = 1 AND income = 1800",
      ),
    ).toBe(1);
    expect(
      await scalar(
        "SELECT COUNT(*) AS value FROM listing_attendees WHERE id = 904 AND listing_id = 902 AND attendee_id = 903 AND quantity = 2 AND price_paid = 1800",
      ),
    ).toBe(1);
    expect(
      await scalar(
        "SELECT COUNT(*) AS value FROM attendees WHERE id = 903 AND ticket_token_index = 'ticket-index'",
      ),
    ).toBe(1);
    expect(
      await scalar(
        "SELECT COUNT(*) AS value FROM activity_log WHERE id = 905 AND listing_id = 902 AND message = 'fixture activity'",
      ),
    ).toBe(1);
    expect(
      await scalar(
        "SELECT COUNT(*) AS value FROM groups WHERE id = 901 AND slug_index = 'group-index'",
      ),
    ).toBe(1);
    expect(
      await scalar(
        "SELECT COUNT(*) AS value FROM built_sites WHERE id = 913 AND assigned_listing_id = 902 AND assigned_attendee_id = 903",
      ),
    ).toBe(1);
    expect(
      await scalar(
        "SELECT COUNT(*) AS value FROM questions WHERE id = 906 AND text = 'Meal choice?'",
      ),
    ).toBe(1);
    expect(
      await scalar(
        "SELECT COUNT(*) AS value FROM answers WHERE id = 908 AND question_id = 906 AND times_selected = 1",
      ),
    ).toBe(1);
    expect(
      await scalar(
        "SELECT COUNT(*) AS value FROM attendee_answers WHERE id = 910 AND attendee_id = 903 AND answer_id = 908",
      ),
    ).toBe(1);

    if (
      migrationIndex(baseMigrationId) >=
      migrationIndex("2026-06-14_attendee_statuses")
    ) {
      expect(
        await scalar(
          "SELECT COUNT(*) AS value FROM activity_log WHERE id = 905 AND attendee_id = 903",
        ),
      ).toBe(1);
    }

    if (
      migrationIndex(baseMigrationId) >= migrationIndex("2026-06-16_modifiers")
    ) {
      expect(
        await scalar(
          "SELECT COUNT(*) AS value FROM modifiers WHERE id = 907 AND total_uses = 2 AND usage_count = 1 AND total_revenue = 500",
        ),
      ).toBe(1);
      expect(
        await scalar(
          "SELECT COUNT(*) AS value FROM modifier_usages WHERE id = 911 AND modifier_id = 907 AND attendee_id = 903",
        ),
      ).toBe(1);
    }
  };

  const sentinelListingExists = async (): Promise<boolean> => {
    const result = await getDb().execute(
      "SELECT 1 FROM listings WHERE name = 'sentinel-listing'",
    );
    return result.rows.length > 0;
  };

  const markAppliedThrough = async (lastAppliedId: string): Promise<void> => {
    const applied = MIGRATIONS.slice(
      0,
      MIGRATIONS.findIndex((migration) => migration.id === lastAppliedId) + 1,
    );
    await getDb().execute("DELETE FROM schema_migrations");
    for (const migration of applied) {
      await getDb().execute({
        args: [migration.id, migration.description],
        sql: "INSERT INTO schema_migrations (id, description, applied_at) VALUES (?, ?, '2026-01-01T00:00:00.000Z')",
      });
    }
    await getDb().execute({
      args: [LATEST_UPDATE],
      sql: "UPDATE settings SET value = ? WHERE key = 'latest_db_update'",
    });
    await getDb().execute({
      args: [SCHEMA_HASH],
      sql: "UPDATE settings SET value = ? WHERE key = 'db_schema_hash'",
    });
    invalidateInitDbCache();
  };

  const markSchemaMarkersStale = () =>
    getDb().batch(
      [
        "UPDATE settings SET value = 'stale' WHERE key = 'latest_db_update'",
        "UPDATE settings SET value = 'stale' WHERE key = 'db_schema_hash'",
      ],
      "write",
    );

  // A migration is restore-testable only if it owns concrete schema objects to
  // drop and rebuild; a data-only migration (empty `requires`, e.g. a ledger
  // backfill) owns nothing, so dropping "its objects" is a no-op and verify()
  // could never fail — it is covered by its own data test instead.
  const ownsSchemaObjects = (req: SchemaRequirement): boolean =>
    Boolean(
      req.newTables?.length ||
        req.indexes?.length ||
        req.triggers?.length ||
        Object.values(req.columns ?? {}).some((cols) => cols.length > 0),
    );

  // Additive migrations own concrete objects and can be reconstructed by
  // re-running up(). The baseline reconcile (no `requires`), migrations that
  // remove legacy tables, and data-only migrations are covered separately.
  const additiveMigrations = MIGRATIONS.filter(
    (m) =>
      m.requires && !m.requires.absentTables && ownsSchemaObjects(m.requires),
  );

  test("every additive migration is covered by a restore case", () => {
    // Guards against a future migration slipping through with no restore test.
    expect(additiveMigrations.length).toBe(MIGRATIONS.length - 4);
  });

  for (const migration of additiveMigrations) {
    const req = migration.requires!;

    test(`restores ${migration.id} after its objects are dropped`, async () => {
      await seedSentinelListing();

      // Precondition: a freshly-migrated DB satisfies the migration.
      await migration.verify();

      await dropOwnedObjects(req);

      // With its objects gone, the migration's verify() must fail.
      await expect(migration.verify()).rejects.toThrow(
        "Migration verification failed",
      );

      // Re-running up() restores exactly those objects...
      await migration.up();
      await migration.verify();

      // ...and the row that existed before the drop/restore is untouched.
      expect(await sentinelListingExists()).toBe(true);

      // Spot-check that each declared object is actually present again.
      for (const table of req.newTables ?? []) {
        expect((await tableColumns(table)).size).toBeGreaterThan(0);
      }
      for (const [table, cols] of Object.entries(req.columns ?? {})) {
        const present = await tableColumns(table);
        for (const col of cols) expect(present.has(col)).toBe(true);
      }
      for (const index of req.indexes ?? []) {
        expect(await indexExists(index)).toBe(true);
      }
      for (const trigger of req.triggers ?? []) {
        expect(await triggerExists(trigger)).toBe(true);
      }
    });
  }

  const migrationBoundaries = MIGRATIONS.slice(
    MIGRATIONS.findIndex(
      (m) => m.id === "2026-06-14_rename_events_to_listings",
    ),
    -1,
  );

  for (const baseMigration of migrationBoundaries) {
    test(`migrates a populated database from ${baseMigration.id} to the current schema`, async () => {
      await seedPopulatedMigrationFixture();

      const pending = MIGRATIONS.slice(MIGRATIONS.indexOf(baseMigration) + 1);
      for (const migration of [...pending].reverse()) {
        if (
          migration.requires &&
          !migration.requires.absentTables &&
          ownsSchemaObjects(migration.requires)
        ) {
          await dropOwnedObjects(migration.requires);
        }
      }

      await markAppliedThrough(baseMigration.id);
      await markSchemaMarkersStale();

      await initDb();

      for (const migration of MIGRATIONS) {
        await migration.verify();
      }
      await assertPopulatedFixtureSurvived(baseMigration.id);
    });
  }

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
