import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { execute, queryAll } from "#db/client.ts";
import noteEntitiesGroupListing from "#db/migrations/2026-10-27_note_entities_group_listing.ts";
import { MIGRATION_IDS } from "#db/migrations/registry.ts";
import { recreateTable, syncIndexes } from "#db/migrations/schema-sync.ts";
import type { Migration } from "#db/migrations/types.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { buildMigrationContext } from "#test-utils/migrations.ts";

/** Put system_notes back the way it was before this migration: its CHECK names
 *  only attendees, so a note about a group or a listing is rejected. */
const downgradeToAttendeeOnlyNotes = async (): Promise<void> => {
  await execute("DROP TABLE IF EXISTS system_notes");
  await execute(`CREATE TABLE system_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL CHECK (entity_type IN ('attendee')),
      entity_id INTEGER NOT NULL,
      type TEXT NOT NULL DEFAULT 'system' CHECK (type IN ('system', 'owner')),
      note TEXT NOT NULL,
      system_name TEXT CHECK (
        system_name IS NULL OR (type = 'system' AND system_name GLOB 'system-note:1:?*')
      ),
      created TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
  await execute("DROP INDEX IF EXISTS idx_system_notes_entity");
  await execute("DROP INDEX IF EXISTS idx_system_notes_named_unique");
  await execute(
    "CREATE INDEX idx_system_notes_entity ON system_notes(entity_type, entity_id)",
  );
};

const migration = (): Migration =>
  noteEntitiesGroupListing(
    buildMigrationContext({ recreateTable, syncIndexes }),
  );

const runMigration = (): Promise<void> => migration().up();

describeWithEnv(
  "db > migrations > 2026-10-27_note_entities_group_listing",
  { db: true },
  () => {
    test("rebuilds system_notes so its CHECK accepts group and listing notes", async () => {
      await downgradeToAttendeeOnlyNotes();
      await execute(
        "INSERT INTO system_notes (entity_type, entity_id, type, note) VALUES ('attendee', 7, 'owner', 'kept')",
      );

      await runMigration();

      // The existing attendee note survives the rebuild.
      const rows = await queryAll<{ entity_type: string; note: string }>(
        "SELECT entity_type, note FROM system_notes",
      );
      expect(rows).toEqual([{ entity_type: "attendee", note: "kept" }]);

      // The rebuilt table's CHECK names 'group' and 'listing' too, so notes
      // the old CHECK would have refused are accepted.
      await execute(
        "INSERT INTO system_notes (entity_type, entity_id, type, note, created) VALUES ('group', 3, 'owner', 'about a group', '2026-10-27T00:00:00.000Z')",
      );
      await execute(
        "INSERT INTO system_notes (entity_type, entity_id, type, note, created) VALUES ('listing', 4, 'owner', 'about a listing', '2026-10-27T00:00:00.000Z')",
      );
    });

    test("leaves an already-rebuilt table alone", async () => {
      await downgradeToAttendeeOnlyNotes();
      await runMigration();

      // A verify retry, or a crash after the work but before the marker, runs
      // up() a second time against the finished table.
      await runMigration();

      await execute(
        "INSERT INTO system_notes (entity_type, entity_id, type, note, created) VALUES ('listing', 1, 'owner', 'twice', '2026-10-27T00:00:00.000Z')",
      );
      const rows = await queryAll<{ entity_type: string }>(
        "SELECT entity_type FROM system_notes",
      );
      expect(rows).toEqual([{ entity_type: "listing" }]);
    });
  },
);

test("registers the migration after the one before it", () => {
  const index = MIGRATION_IDS.indexOf("2026-10-27_note_entities_group_listing");
  expect(MIGRATION_IDS[index - 1]).toBe(
    "2026-10-26_attendees_pending_flags_index",
  );
});
