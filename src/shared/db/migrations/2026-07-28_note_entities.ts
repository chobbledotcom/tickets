import { bareSchemaMigration } from "./define.ts";

/**
 * Notes used to belong to an attendee and nothing else. They now name the kind
 * of record they are about and which one, so any record can carry notes.
 *
 * The two new columns are added with a default so the database accepts them on
 * a table that already has rows; the rebuild at the end drops `attendee_id` and
 * takes the columns' final form from SCHEMA, which has no default. Each step is
 * skipped when it has already been done, so a re-run after a failed verify is a
 * cheap no-op.
 */
export default bareSchemaMigration(
  "2026-07-28_note_entities",
  "Replace system_notes.attendee_id with entity_type + entity_id, so notes can be about any record and not only an attendee. Existing notes become notes about an attendee",
  async ({ getDb, recreateTable, syncIndexes }) => {
    const info = await getDb().execute("PRAGMA table_info(system_notes)");
    const columns = new Set(info.rows.map((row) => String(row.name)));
    if (!columns.has("attendee_id")) return;

    if (!columns.has("entity_type")) {
      await getDb().execute(
        "ALTER TABLE system_notes ADD COLUMN entity_type TEXT NOT NULL DEFAULT 'attendee'",
      );
    }
    if (!columns.has("entity_id")) {
      await getDb().execute(
        "ALTER TABLE system_notes ADD COLUMN entity_id INTEGER NOT NULL DEFAULT 0",
      );
    }
    await getDb().execute(
      "UPDATE system_notes SET entity_type = 'attendee', entity_id = attendee_id",
    );
    await recreateTable("system_notes"); // rebuild from SCHEMA, dropping attendee_id
    await syncIndexes(); // idx_system_notes_entity in place of the attendee one
  },
);
