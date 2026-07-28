import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { execute, getDb, queryAll } from "#shared/db/client.ts";
import noteEntities from "#shared/db/migrations/2026-07-28_note_entities.ts";
import {
  recreateTable,
  syncIndexes,
} from "#shared/db/migrations/schema-sync.ts";
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

const runMigration = (): Promise<void> =>
  noteEntities(buildMigrationContext({ recreateTable, syncIndexes })).up();

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
