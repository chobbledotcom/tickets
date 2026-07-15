import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb } from "#shared/db/client.ts";
import checkoutStagesMigration from "#shared/db/migrations/2026-07-15_checkout_stages.ts";
import {
  applySchemaChanges,
  syncIndexes,
  syncTriggers,
} from "#shared/db/migrations/schema-sync.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { buildMigrationContext } from "#test-utils/migrations.ts";

const TRIGGER_NAMES = [
  "trg_checkout_stages_revision_insert",
  "trg_checkout_stages_revision_update",
  "trg_checkout_stages_revision_delete",
];

const context = buildMigrationContext({
  applySchemaChanges,
  syncIndexes,
  syncTriggers,
});

const runMigration = (): Promise<void> => checkoutStagesMigration(context).up();

const revision = async (): Promise<number> => {
  const result = await getDb().execute(
    "SELECT revision FROM checkout_stage_revisions WHERE id = 1",
  );
  return Number(result.rows[0]?.revision);
};

const insertStage = (): Promise<unknown> =>
  getDb().execute(`INSERT INTO checkout_stages
    (payment_session_id, attendee_id, provider, ticket_tokens, state, created_at)
    VALUES ('session-1', 42, 'stripe', '["ticket-1"]', 'open', '2026-07-15T12:00:00Z')`);

describeWithEnv(
  "db > checkout stage schema",
  { db: true, triggers: true },
  () => {
    test("the migration declares only the checkout stage schema objects", () => {
      expect(checkoutStagesMigration(context).requires).toEqual({
        indexes: [
          "idx_checkout_stages_attendee_id",
          "idx_checkout_stages_state_created_at",
        ],
        newTables: ["checkout_stage_revisions", "checkout_stages"],
        triggers: TRIGGER_NAMES,
      });
    });

    test("the migration creates the exact columns, indexes, and triggers", async () => {
      for (const name of TRIGGER_NAMES) {
        await getDb().execute(`DROP TRIGGER ${name}`);
      }
      await getDb().execute("DROP TABLE checkout_stages");
      await getDb().execute("DROP TABLE checkout_stage_revisions");

      await runMigration();

      const revisionColumns = await getDb().execute(
        "PRAGMA table_info(checkout_stage_revisions)",
      );
      expect(revisionColumns.rows).toEqual([
        {
          cid: 0,
          dflt_value: null,
          name: "id",
          notnull: 0,
          pk: 1,
          type: "INTEGER",
        },
        {
          cid: 1,
          dflt_value: null,
          name: "revision",
          notnull: 1,
          pk: 0,
          type: "INTEGER",
        },
      ]);
      const stageColumns = await getDb().execute(
        "PRAGMA table_info(checkout_stages)",
      );
      expect(stageColumns.rows).toEqual([
        {
          cid: 0,
          dflt_value: null,
          name: "payment_session_id",
          notnull: 0,
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
      expect(triggers.rows.map((row) => row.name)).toEqual(
        [...TRIGGER_NAMES].sort(),
      );
    });

    test("the revision table allows only singleton id 1", async () => {
      await expect(
        getDb().execute(
          "INSERT INTO checkout_stage_revisions (id, revision) VALUES (2, 1)",
        ),
      ).rejects.toThrow();
    });

    test("inserting the first stage creates revision 1", async () => {
      await insertStage();
      expect(await revision()).toBe(1);
    });

    test("updating a stage increments its revision once", async () => {
      await insertStage();
      await getDb().execute(
        "UPDATE checkout_stages SET state = 'paid' WHERE payment_session_id = 'session-1'",
      );
      expect(await revision()).toBe(2);
    });

    test("deleting a stage increments its revision once", async () => {
      await insertStage();
      await getDb().execute(
        "DELETE FROM checkout_stages WHERE payment_session_id = 'session-1'",
      );
      expect(await revision()).toBe(2);
    });
  },
);
