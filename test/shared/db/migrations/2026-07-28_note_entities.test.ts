import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { execute, getDb, queryAll } from "#shared/db/client.ts";
import noteEntities from "#shared/db/migrations/2026-07-28_note_entities.ts";
import { MIGRATION_IDS } from "#shared/db/migrations/registry.ts";
import {
  recreateTable,
  syncIndexes,
} from "#shared/db/migrations/schema-sync.ts";
import type {
  Migration,
  MigrationContext,
} from "#shared/db/migrations/types.ts";
import { columnNames } from "#test/test-utils/db/migration-test-helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { buildMigrationContext, indexExists } from "#test-utils/migrations.ts";

/** Put system_notes back the way it was before this migration: a note belonged
 *  to an attendee and nothing else. */
const downgradeToAttendeeNotes = async (): Promise<void> => {
  await execute("DROP TABLE IF EXISTS system_notes");
  await execute(`CREATE TABLE system_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      attendee_id INTEGER NOT NULL,
      type TEXT NOT NULL DEFAULT 'system' CHECK (type IN ('system', 'owner')),
      note TEXT NOT NULL,
      created TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
  await execute("DROP INDEX IF EXISTS idx_system_notes_entity");
  await execute(
    "CREATE INDEX idx_system_notes_attendee_id ON system_notes(attendee_id)",
  );
};

const migration = (): Migration =>
  noteEntities(buildMigrationContext({ recreateTable, syncIndexes }));

const runMigration = (): Promise<void> => migration().up();

/** Stop partway: the columns are added, but the rebuild never happened. */
const addColumnsWithoutRebuilding = async (
  ...columns: string[]
): Promise<void> => {
  for (const column of columns) {
    await execute(
      `ALTER TABLE system_notes ADD COLUMN ${column} ${
        column === "entity_type"
          ? "TEXT NOT NULL DEFAULT 'attendee'"
          : "INTEGER NOT NULL DEFAULT 0"
      }`,
    );
  }
};

type StoredNote = {
  entity_id: number;
  entity_type: string;
  id: number;
  note: string;
  type: string;
};

const storedNotes = (): Promise<StoredNote[]> =>
  queryAll<StoredNote>(
    "SELECT id, entity_type, entity_id, type, note FROM system_notes ORDER BY id",
  );

describeWithEnv(
  "db > migrations > 2026-07-28_note_entities",
  { db: true },
  () => {
    test("turns an attendee's notes into notes about an attendee", async () => {
      await downgradeToAttendeeNotes();
      await execute(
        "INSERT INTO system_notes (attendee_id, type, note) VALUES (?, ?, ?), (?, ?, ?)",
        [7, "system", "kept system", 9, "owner", "kept owner"],
      );

      await runMigration();

      expect(await storedNotes()).toEqual([
        {
          entity_id: 7,
          entity_type: "attendee",
          id: 1,
          note: "kept system",
          type: "system",
        },
        {
          entity_id: 9,
          entity_type: "attendee",
          id: 2,
          note: "kept owner",
          type: "owner",
        },
      ]);
      expect(await columnNames("system_notes")).not.toContain("attendee_id");
      expect(await indexExists("idx_system_notes_entity")).toBe(true);
      expect(await indexExists("idx_system_notes_attendee_id")).toBe(false);
    });

    test("leaves an already-migrated table alone", async () => {
      await downgradeToAttendeeNotes();
      await execute(
        "INSERT INTO system_notes (attendee_id, type, note) VALUES (?, ?, ?)",
        [3, "system", "only once"],
      );
      await runMigration();

      // A verify retry, or a crash after the work but before the marker, runs
      // up() a second time against the finished table.
      await runMigration();

      expect(await storedNotes()).toEqual([
        {
          entity_id: 3,
          entity_type: "attendee",
          id: 1,
          note: "only once",
          type: "system",
        },
      ]);
    });

    test("carries on from a run that stopped after the first column", async () => {
      await downgradeToAttendeeNotes();
      await execute(
        "INSERT INTO system_notes (attendee_id, type, note) VALUES (?, ?, ?)",
        [5, "system", "half-migrated"],
      );
      await addColumnsWithoutRebuilding("entity_type");

      await runMigration();

      expect(await storedNotes()).toEqual([
        {
          entity_id: 5,
          entity_type: "attendee",
          id: 1,
          note: "half-migrated",
          type: "system",
        },
      ]);
    });

    test("carries on from a run that stopped after both columns", async () => {
      await downgradeToAttendeeNotes();
      await execute(
        "INSERT INTO system_notes (attendee_id, type, note) VALUES (?, ?, ?)",
        [6, "owner", "columns already there"],
      );
      await addColumnsWithoutRebuilding("entity_type", "entity_id");

      await runMigration();

      expect(await storedNotes()).toEqual([
        {
          entity_id: 6,
          entity_type: "attendee",
          id: 1,
          note: "columns already there",
          type: "owner",
        },
      ]);
    });

    test("puts the index back when a run died right after the rebuild", async () => {
      await downgradeToAttendeeNotes();
      await runMigration();
      // The state a run that stopped between the rebuild and the index leaves:
      // the columns are moved, but nothing indexes them.
      await execute("DROP INDEX idx_system_notes_entity");
      expect(await indexExists("idx_system_notes_entity")).toBe(false);

      await runMigration();

      expect(await indexExists("idx_system_notes_entity")).toBe(true);
    });

    test("finishes when the work is done but the schema read is behind", async () => {
      await downgradeToAttendeeNotes();
      // What a finished table answers to each step, when the read that chose
      // to run them was a moment out of date.
      const finishedDatabase = () => ({
        execute: (sql: string) =>
          Promise.reject(
            new Error(
              sql.startsWith("ALTER")
                ? "duplicate column name: entity_type"
                : "no such column: attendee_id",
            ),
          ),
      });

      await noteEntities(
        buildMigrationContext({
          getDb: finishedDatabase as unknown as MigrationContext["getDb"],
          recreateTable,
          syncIndexes,
        }),
      ).up();

      expect(await indexExists("idx_system_notes_entity")).toBe(true);
    });

    test("stops when adding a column fails for any other reason", async () => {
      await downgradeToAttendeeNotes();
      const brokenDatabase = () => ({
        execute: () => Promise.reject(new Error("database or disk is full")),
      });

      // A column that is already there is taken as done; anything else means
      // the database could not do what was asked, and must not be swallowed.
      await expect(
        noteEntities(
          buildMigrationContext({
            getDb: brokenDatabase as unknown as MigrationContext["getDb"],
            recreateTable,
            syncIndexes,
          }),
        ).up(),
      ).rejects.toThrow("database or disk is full");
    });

    test("is registered under the id it declares, and says what it does", () => {
      const { description, id } = migration();

      // The id is what the applied-marker is written under: a mismatch with the
      // registry would run the migration again on every boot.
      expect(MIGRATION_IDS).toContain(id);
      expect(description).toContain("entity_type");
      expect(description).toContain("entity_id");
    });

    test("refuses a note about a kind of record it does not know", async () => {
      await downgradeToAttendeeNotes();
      await runMigration();

      await expect(
        getDb().execute({
          args: [1, "system", "who?"],
          sql: "INSERT INTO system_notes (entity_type, entity_id, type, note) VALUES ('spaceship', ?, ?, ?)",
        }),
      ).rejects.toThrow();
    });
  },
);
