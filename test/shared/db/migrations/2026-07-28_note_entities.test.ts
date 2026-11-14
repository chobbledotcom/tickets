import { assert, assertArrayIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { execute, getDb, queryAll } from "#db/client.ts";
import noteEntities from "#db/migrations/2026-07-28_note_entities.ts";
import { MIGRATION_IDS } from "#db/migrations/registry.ts";
import { recreateTable, syncIndexes } from "#db/migrations/schema-sync.ts";
import type { Migration, MigrationContext } from "#db/migrations/types.ts";
import { type SqlStatement, sql, sqlName } from "#db/sql.ts";
import { expectIncludesAll } from "#test-utils/assertions.ts";
import { columnNames } from "#test-utils/db/migration-test-helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { expectIndexRepaired } from "#test-utils/migration-index-repair.ts";
import { buildMigrationContext, indexExists } from "#test-utils/migrations.ts";

/** Put system_notes back the way it was before this migration: a note belonged
 *  to an attendee and nothing else. */
const downgradeToAttendeeNotes = async (): Promise<void> => {
  await execute(sql`DROP TABLE IF EXISTS system_notes`);
  await execute(sql`CREATE TABLE system_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      attendee_id INTEGER NOT NULL,
      type TEXT NOT NULL DEFAULT 'system' CHECK (type IN ('system', 'owner')),
      note TEXT NOT NULL,
      created TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
  await execute(sql`DROP INDEX IF EXISTS idx_system_notes_entity`);
  await execute(
    sql`CREATE INDEX idx_system_notes_attendee_id ON system_notes(attendee_id)`,
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
      sql`ALTER TABLE system_notes ADD COLUMN ${sqlName(column)} ${
        column === "entity_type"
          ? sql`TEXT NOT NULL DEFAULT 'attendee'`
          : sql`INTEGER NOT NULL DEFAULT 0`
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
    sql`SELECT id, entity_type, entity_id, type, note FROM system_notes ORDER BY id`,
  );

/** One note already in the table when a stopped or retried run meets it: the
 *  columns that run added first, and how many times up() runs over it. */
type StoppedRun = {
  attendeeId: number;
  columns: string[];
  name: string;
  note: string;
  runs: number;
  type: string;
};

const stoppedRuns: StoppedRun[] = [
  {
    attendeeId: 3,
    columns: [],
    name: "leaves an already-migrated table alone",
    note: "only once",
    // A verify retry, or a crash after the work but before the marker, runs
    // up() a second time against the finished table.
    runs: 2,
    type: "system",
  },
  {
    attendeeId: 5,
    columns: ["entity_type"],
    name: "carries on from a run that stopped after the first column",
    note: "half-migrated",
    runs: 1,
    type: "system",
  },
  {
    attendeeId: 6,
    columns: ["entity_type", "entity_id"],
    name: "carries on from a run that stopped after both columns",
    note: "columns already there",
    runs: 1,
    type: "owner",
  },
];

describeWithEnv(
  "db > migrations > 2026-07-28_note_entities",
  { db: true },
  () => {
    test("turns an attendee's notes into notes about an attendee", async () => {
      await downgradeToAttendeeNotes();
      await execute(
        sql`INSERT INTO system_notes (attendee_id, type, note) VALUES (${7}, ${"system"}, ${"kept system"}), (${9}, ${"owner"}, ${"kept owner"})`,
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
      assert(!(await columnNames("system_notes")).includes("attendee_id"));
      expect(await indexExists("idx_system_notes_entity")).toBe(true);
      expect(await indexExists("idx_system_notes_attendee_id")).toBe(false);
    });

    for (const stopped of stoppedRuns) {
      test(stopped.name, async () => {
        await downgradeToAttendeeNotes();
        await execute(
          sql`INSERT INTO system_notes (attendee_id, type, note) VALUES (${stopped.attendeeId}, ${stopped.type}, ${stopped.note})`,
        );
        await addColumnsWithoutRebuilding(...stopped.columns);
        for (let pass = 0; pass < stopped.runs; pass += 1) {
          await runMigration();
        }

        expect(await storedNotes()).toEqual([
          {
            entity_id: stopped.attendeeId,
            entity_type: "attendee",
            id: 1,
            note: stopped.note,
            type: stopped.type,
          },
        ]);
      });
    }

    test("puts the index back when a run died right after the rebuild", async () => {
      await downgradeToAttendeeNotes();
      await runMigration();
      // The state a run that stopped between the rebuild and the index leaves:
      // the columns are moved, but nothing indexes them.
      await expectIndexRepaired("idx_system_notes_entity", runMigration);
    });

    test("finishes when the work is done but the schema read is behind", async () => {
      await downgradeToAttendeeNotes();
      // What a finished table answers to each step, when the read that chose
      // to run them was a moment out of date.
      const finishedDatabase = () => ({
        execute: (statement: SqlStatement) =>
          Promise.reject(
            new Error(
              statement.sql.startsWith("ALTER")
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

    for (const failing of ["ALTER", "UPDATE"]) {
      test(`stops when ${failing} fails for any other reason`, async () => {
        await downgradeToAttendeeNotes();
        // Only this one statement fails, and not with an "already so" answer,
        // so each step's tolerance has to be about its own answer alone.
        const database = () => ({
          execute: (statement: SqlStatement) =>
            statement.sql.startsWith(failing)
              ? Promise.reject(new Error("database or disk is full"))
              : Promise.resolve({}),
        });

        await expect(
          noteEntities(
            buildMigrationContext({
              getDb: database as unknown as MigrationContext["getDb"],
              recreateTable,
              syncIndexes,
            }),
          ).up(),
        ).rejects.toThrow("database or disk is full");
      });
    }

    test("is registered under the id it declares, and says what it does", () => {
      const { description, id } = migration();

      // The id is what the applied-marker is written under: a mismatch with the
      // registry would run the migration again on every boot.
      assertArrayIncludes(MIGRATION_IDS, [id]);
      expectIncludesAll(description, ["entity_type", "entity_id"]);
    });

    test("refuses a note about a kind of record it does not know", async () => {
      await downgradeToAttendeeNotes();
      await runMigration();

      await expect(
        getDb().execute(
          sql`INSERT INTO system_notes (entity_type, entity_id, type, note) VALUES ('spaceship', ${1}, ${"system"}, ${"who?"})`,
        ),
      ).rejects.toThrow();
    });
  },
);
