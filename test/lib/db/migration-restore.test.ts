import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb, insert, queryBatch } from "#shared/db/client.ts";
import {
  initDb,
  invalidateInitDbCache,
  MIGRATIONS,
  type SchemaRequirement,
} from "#shared/db/migrations.ts";
import { describeWithEnv } from "#test-utils";
import {
  executeStatements,
  type LabelledStatement,
  queryLabelledBatch,
  seedPreDropLedgerColumns,
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
  // Collect every explicitly-created index name on `table` (sql IS NOT NULL
  // excludes the auto-indexes backing UNIQUE/PK constraints), then read each
  // index's column list in one batched round-trip. Returns the index names
  // that include `column` — SQLite refuses DROP COLUMN while any index
  // references it, so the restore drops these first.
  const indexesReferencingColumn = async (
    table: string,
    column: string,
  ): Promise<string[]> => {
    const indexes = await getDb().execute({
      args: [table],
      sql: "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL",
    });
    if (indexes.rows.length === 0) return [];
    const colResults = await queryBatch(
      indexes.rows.map((row) => ({
        args: [],
        sql: `SELECT name FROM pragma_index_info('${String(row.name)}')`,
      })),
    );
    return indexes.rows
      .map((row, i) => ({
        cols: colResults[i]!.rows.map((c) => String(c.name)),
        name: String(row.name),
      }))
      .filter((idx) => idx.cols.includes(column))
      .map((idx) => idx.name);
  };

  // Collect every DROP statement for a migration's owned objects, doing all
  // the index-referencing-column lookups as one batched read first. The
  // statements are ordered so SQLite accepts them: triggers and indexes first
  // (a column can't be dropped while a trigger or index references it), then
  // the columns, then the tables.
  const dropStatementsFor = async (
    req: SchemaRequirement,
  ): Promise<string[]> => {
    const triggers = req.triggers ?? [];
    const indexes = req.indexes ?? [];
    const columnEntries = Object.entries(req.columns ?? {});
    const newTables = req.newTables ?? [];

    // For each column being dropped, find indexes (possibly declared by a LATER
    // migration) that reference it — these must be dropped before the column.
    const indexDropsForColumns: string[] = [];
    for (const [table, cols] of columnEntries) {
      for (const col of cols) {
        indexDropsForColumns.push(
          ...(await indexesReferencingColumn(table, col)),
        );
      }
    }

    return [
      ...triggers.map((t) => `DROP TRIGGER IF EXISTS ${t}`),
      ...indexes.map((i) => `DROP INDEX IF EXISTS ${i}`),
      ...indexDropsForColumns.map((i) => `DROP INDEX IF EXISTS ${i}`),
      ...columnEntries.flatMap(([table, cols]) =>
        cols.map((col) => `ALTER TABLE ${table} DROP COLUMN ${col}`),
      ),
      ...newTables.map((t) => `DROP TABLE IF EXISTS ${t}`),
    ];
  };

  // Drop a migration's owned objects in an order SQLite accepts, batched into
  // a single write round-trip.
  const dropOwnedObjects = async (req: SchemaRequirement): Promise<void> => {
    await executeStatements(await dropStatementsFor(req));
  };

  const seedSentinelListing = (): Promise<unknown> =>
    getDb().execute(
      insert("listings", {
        created: "2024-01-01T00:00:00Z",
        max_attendees: 10,
        name: "sentinel-listing",
      }),
    );

  const seedPopulatedMigrationFixture = () =>
    getDb().batch(
      [
        `INSERT INTO groups (id, slug, slug_index, name, description, max_attendees)
         VALUES (901, 'migration-group', 'group-index', 'Migration Group', 'historic group', 50)`,
        `INSERT INTO listings (id, created, max_attendees, name, slug, slug_index, unit_price, max_quantity, listing_type, date, location, customisable_days, uses_logistics)
         VALUES (902, '2024-01-01T00:00:00Z', 25, 'migration-listing', 'migration-listing', 'listing-index', 1200, 4, 'standard', '2024-02-01', 'Town Hall', 1, 1)`,
        `INSERT INTO attendees (id, created, checked_in, ticket_token_index, pii_blob, status_id, split_logistics_agents, phone_index)
         VALUES (903, '2024-01-02T00:00:00Z', '', 'ticket-index', '{"name":"Migration Guest"}', 1, 1, 'phone-index')`,
        `INSERT INTO listing_attendees (id, listing_id, attendee_id, start_at, end_at, quantity, checked_in, start_agent_id, end_agent_id, start_time, end_time, start_done, end_done)
         VALUES (904, 902, 903, '2024-02-01T10:00:00Z', '2024-02-01T12:00:00Z', 2, 1, NULL, NULL, '10:00', '12:00', 1, 0)`,
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
    // Build the list of survival-check queries, including the conditional
    // ones for migrations past certain boundaries, then run them all as one
    // batched read round-trip. Each query is labelled so the assertion reads
    // by name — adding or reordering a check can't silently shift the indices.
    const checks: LabelledStatement[] = [
      {
        args: [],
        label: "listing",
        sql: "SELECT COUNT(*) AS value FROM listings WHERE id = 902 AND name = 'migration-listing' AND booked_quantity = 2 AND tickets_count = 1",
      },
      {
        args: [],
        label: "listing_attendee",
        sql: "SELECT COUNT(*) AS value FROM listing_attendees WHERE id = 904 AND listing_id = 902 AND attendee_id = 903 AND quantity = 2",
      },
      {
        args: [],
        label: "attendee",
        sql: "SELECT COUNT(*) AS value FROM attendees WHERE id = 903 AND ticket_token_index = 'ticket-index'",
      },
      {
        args: [],
        label: "activity_log",
        sql: "SELECT COUNT(*) AS value FROM activity_log WHERE id = 905 AND listing_id = 902 AND message = 'fixture activity'",
      },
      {
        args: [],
        label: "group",
        sql: "SELECT COUNT(*) AS value FROM groups WHERE id = 901 AND slug_index = 'group-index'",
      },
      {
        args: [],
        label: "built_site",
        sql: "SELECT COUNT(*) AS value FROM built_sites WHERE id = 913 AND assigned_listing_id = 902 AND assigned_attendee_id = 903",
      },
      {
        args: [],
        label: "question",
        sql: "SELECT COUNT(*) AS value FROM questions WHERE id = 906 AND text = 'Meal choice?'",
      },
      {
        args: [],
        label: "answer",
        sql: "SELECT COUNT(*) AS value FROM answers WHERE id = 908 AND question_id = 906 AND times_selected = 1",
      },
      {
        args: [],
        label: "attendee_answer",
        sql: "SELECT COUNT(*) AS value FROM attendee_answers WHERE id = 910 AND attendee_id = 903 AND answer_id = 908",
      },
    ];
    const hasAttendeeStatuses =
      migrationIndex(baseMigrationId) >=
      migrationIndex("2026-06-14_attendee_statuses");
    const hasModifiers =
      migrationIndex(baseMigrationId) >= migrationIndex("2026-06-16_modifiers");
    if (hasAttendeeStatuses) {
      checks.push({
        args: [],
        label: "activity_log_attendee",
        sql: "SELECT COUNT(*) AS value FROM activity_log WHERE id = 905 AND attendee_id = 903",
      });
    }
    if (hasModifiers) {
      checks.push({
        args: [],
        label: "modifier",
        sql: "SELECT COUNT(*) AS value FROM modifiers WHERE id = 907 AND total_uses = 2 AND usage_count = 1",
      });
      checks.push({
        args: [],
        label: "modifier_usage",
        sql: "SELECT COUNT(*) AS value FROM modifier_usages WHERE id = 911 AND modifier_id = 907 AND attendee_id = 903",
      });
    }
    const results = await queryLabelledBatch(checks);
    const one = (label: string) =>
      expect(Number(results.get(label)!.rows[0]?.value)).toBe(1);
    one("listing");
    one("listing_attendee");
    one("attendee");
    one("activity_log");
    one("group");
    one("built_site");
    one("question");
    one("answer");
    one("attendee_answer");
    if (hasAttendeeStatuses) one("activity_log_attendee");
    if (hasModifiers) {
      one("modifier");
      one("modifier_usage");
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
    await getDb().batch(
      [
        { args: [], sql: "DELETE FROM schema_migrations" },
        ...applied.map((migration) => ({
          args: [migration.id, migration.description],
          sql: "INSERT INTO schema_migrations (id, description, applied_at) VALUES (?, ?, '2026-01-01T00:00:00.000Z')",
        })),
        {
          args: [],
          sql: "UPDATE settings SET value = 'stale' WHERE key = 'latest_db_update'",
        },
        {
          args: [],
          sql: "UPDATE settings SET value = 'stale' WHERE key = 'db_schema_hash'",
        },
      ],
      "write",
    );
    invalidateInitDbCache();
  };

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
    // data test), and listing_image_thumb (historically added a column that
    // first_class_images now drops).
    expect(additiveMigrations.length).toBe(MIGRATIONS.length - 17);
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

      // Spot-check that each declared object is actually present again,
      // batched into one read round-trip. Each statement is labelled by its
      // object name so the assertions read by name — adding or reordering a
      // declared object can't silently shift the indices.
      const newTables = req.newTables ?? [];
      const columnTables = Object.entries(req.columns ?? {});
      const indexes = req.indexes ?? [];
      const triggers = req.triggers ?? [];
      const checks = await queryLabelledBatch([
        ...newTables.map((t) => ({
          args: [],
          label: `table:${t}`,
          sql: `SELECT name FROM pragma_table_info('${t}')`,
        })),
        ...columnTables.map(([t]) => ({
          args: [],
          label: `columns:${t}`,
          sql: `SELECT name FROM pragma_table_info('${t}')`,
        })),
        ...indexes.map((name) => ({
          args: [name],
          label: `index:${name}`,
          sql: "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?",
        })),
        ...triggers.map((name) => ({
          args: [name],
          label: `trigger:${name}`,
          sql: "SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?",
        })),
      ]);
      for (const t of newTables) {
        expect(checks.get(`table:${t}`)!.rows.length).toBeGreaterThan(0);
      }
      for (const [t, cols] of columnTables) {
        const present = new Set(
          checks.get(`columns:${t}`)!.rows.map((r) => String(r.name)),
        );
        for (const col of cols) expect(present.has(col)).toBe(true);
      }
      for (const name of indexes) {
        expect(checks.get(`index:${name}`)!.rows.length).toBeGreaterThan(0);
      }
      for (const name of triggers) {
        expect(checks.get(`trigger:${name}`)!.rows.length).toBeGreaterThan(0);
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
      // The fixture is built from the current (post-drop) schema, but the
      // 2026-06-22_backfill_transfers migration in the chain reads
      // listing_attendees.refunded and price_paid — present in production until
      // the later drop_listing_attendee_refunded / drop_listing_attendee_price_paid
      // migrations recreate the table without them. Restore the columns so the
      // chain reproduces production; the drop migrations then remove them again,
      // leaving the verified schema correct.
      await seedPreDropLedgerColumns();

      const pending = MIGRATIONS.slice(MIGRATIONS.indexOf(baseMigration) + 1);
      const dropStatements: string[] = [];
      for (const migration of [...pending].reverse()) {
        if (
          migration.requires &&
          !migration.requires.absentTables &&
          ownsSchemaObjects(migration.requires)
        ) {
          dropStatements.push(...(await dropStatementsFor(migration.requires)));
        }
      }
      await executeStatements(dropStatements);

      await markAppliedThrough(baseMigration.id);

      await initDb();

      for (const migration of MIGRATIONS) {
        await migration.verify();
      }
      await assertPopulatedFixtureSurvived(baseMigration.id);
    });
  }
});
