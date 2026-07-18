import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb } from "#shared/db/client.ts";
import checkoutStagesMigration from "#shared/db/migrations/2026-07-15_checkout_stages.ts";
import dropCheckoutStageRevisionsMigration from "#shared/db/migrations/2026-07-16_drop_checkout_stage_revisions.ts";
import {
  applySchemaChanges,
  syncIndexes,
} from "#shared/db/migrations/schema-sync.ts";
import { additive } from "#shared/db/migrations/verify.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { buildMigrationContext } from "#test-utils/migrations.ts";

const LEGACY_TRIGGER_NAMES = ["insert", "update", "delete"].map(
  (action) => `trg_checkout_stages_revision_${action}`,
);

const context = buildMigrationContext({
  applySchemaChanges,
  syncIndexes,
});
const cleanupContext = buildMigrationContext({ additive });

const runMigration = (): Promise<void> => checkoutStagesMigration(context).up();

describeWithEnv(
  "db > checkout stage schema",
  { db: true, triggers: true },
  () => {
    test("the migration declares only the checkout stage schema objects", () => {
      const migration = checkoutStagesMigration(context);
      expect({
        description: migration.description,
        id: migration.id,
        requires: migration.requires,
      }).toEqual({
        description: "Add dormant checkout stage storage.",
        id: "2026-07-15_checkout_stages",
        requires: {
          indexes: [
            "idx_checkout_stages_attendee_id",
            "idx_checkout_stages_state_created_at",
          ],
          newTables: ["checkout_stages"],
        },
      });
    });

    test("the migration creates only the checkout stage table and indexes", async () => {
      await getDb().execute("DROP TABLE checkout_stages");

      await runMigration();

      const stageColumns = await getDb().execute(
        "PRAGMA table_info(checkout_stages)",
      );
      expect(stageColumns.rows).toEqual([
        {
          cid: 0,
          dflt_value: null,
          name: "payment_session_id",
          notnull: 1,
          pk: 1,
          type: "TEXT",
        },
        {
          cid: 1,
          dflt_value: null,
          name: "attendee_id",
          notnull: 1,
          pk: 0,
          type: "INTEGER",
        },
        {
          cid: 2,
          dflt_value: null,
          name: "provider",
          notnull: 1,
          pk: 0,
          type: "TEXT",
        },
        {
          cid: 3,
          dflt_value: null,
          name: "ticket_tokens",
          notnull: 1,
          pk: 0,
          type: "TEXT",
        },
        {
          cid: 4,
          dflt_value: null,
          name: "state",
          notnull: 1,
          pk: 0,
          type: "TEXT",
        },
        {
          cid: 5,
          dflt_value: null,
          name: "created_at",
          notnull: 1,
          pk: 0,
          type: "TEXT",
        },
      ]);
      const indexes = await getDb().execute(
        "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'checkout_stages' ORDER BY name",
      );
      expect(indexes.rows).toEqual([
        {
          name: "idx_checkout_stages_attendee_id",
          sql: "CREATE UNIQUE INDEX idx_checkout_stages_attendee_id ON checkout_stages(attendee_id)",
        },
        {
          name: "idx_checkout_stages_state_created_at",
          sql: "CREATE INDEX idx_checkout_stages_state_created_at ON checkout_stages(state, created_at)",
        },
        { name: "sqlite_autoindex_checkout_stages_1", sql: null },
      ]);
      const triggers = await getDb().execute(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'checkout_stages' ORDER BY name",
      );
      expect(triggers.rows.map((row) => row.name)).toEqual([]);
      const revisionColumns = await getDb().execute(
        "PRAGMA table_info(checkout_stage_revisions)",
      );
      expect(revisionColumns.rows).toEqual([]);
    });

    test("a stage cannot be stored without a payment session id", async () => {
      await expect(
        getDb().execute(`INSERT INTO checkout_stages
          (payment_session_id, attendee_id, provider, ticket_tokens, state, created_at)
          VALUES (NULL, 42, 'stripe', '["ticket-1"]', 'open', '2026-07-15T12:00:00Z')`),
      ).rejects.toThrow();
      const result = await getDb().execute(
        "SELECT COUNT(*) AS count FROM checkout_stages",
      );
      expect(Number(result.rows[0]?.count)).toBe(0);
    });

    test("the cleanup migration declares the legacy table absent", () => {
      const migration = dropCheckoutStageRevisionsMigration(cleanupContext);
      expect({
        description: migration.description,
        id: migration.id,
        requires: migration.requires,
      }).toEqual({
        description: "Remove unused checkout stage revision tracking.",
        id: "2026-07-16_drop_checkout_stage_revisions",
        requires: { absentTables: ["checkout_stage_revisions"] },
      });
    });

    test("the cleanup migration atomically removes legacy revision storage and reruns safely", async () => {
      await getDb().execute(
        "CREATE TABLE checkout_stage_revisions (id INTEGER PRIMARY KEY, revision INTEGER NOT NULL)",
      );
      for (const [index, name] of LEGACY_TRIGGER_NAMES.entries()) {
        const action = ["INSERT", "UPDATE", "DELETE"][index]!;
        await getDb().execute(`CREATE TRIGGER ${name}
          AFTER ${action} ON checkout_stages BEGIN SELECT 1; END`);
      }
      const migration = dropCheckoutStageRevisionsMigration(cleanupContext);

      await migration.up();
      await migration.up();
      await migration.verify();

      const legacyObjects = await getDb().execute(
        `SELECT name FROM sqlite_master
          WHERE name = 'checkout_stage_revisions'
             OR name LIKE 'trg_checkout_stages_revision_%'
          ORDER BY name`,
      );
      expect(legacyObjects.rows).toEqual([]);
    });

    test("the cleanup migration verification rejects a surviving legacy table", async () => {
      await getDb().execute(
        "CREATE TABLE checkout_stage_revisions (id INTEGER PRIMARY KEY)",
      );

      await expect(
        dropCheckoutStageRevisionsMigration(cleanupContext).verify(),
      ).rejects.toThrow(
        "Migration verification failed: legacy table checkout_stage_revisions still present",
      );
    });
  },
);
