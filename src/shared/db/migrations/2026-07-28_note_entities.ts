import { queryBatchPrimary } from "#shared/db/client.ts";
import { errorMessage } from "#shared/error-message.ts";
import { bareSchemaMigration } from "./define.ts";

/** A column already there is the state this asks for, so the work is done. */
const ALREADY_ADDED = "duplicate column name";

/**
 * Add a column, treating one that is already there as added. A run that added
 * it and then died leaves the database ahead of what a read reports — even a
 * read from the primary, which can briefly answer with the schema as it was
 * (see the backoff note in ./runner.ts) — so the database's own answer is the
 * one to trust.
 */
const addColumn = async (
  getDb: () => { execute(sql: string): Promise<unknown> },
  column: string,
): Promise<void> => {
  try {
    await getDb().execute(`ALTER TABLE system_notes ADD COLUMN ${column}`);
  } catch (error) {
    if (!errorMessage(error).includes(ALREADY_ADDED)) throw error;
  }
};

/**
 * Notes used to belong to an attendee and nothing else. They now name the kind
 * of record they are about and which one, so any record can carry notes.
 *
 * The two new columns are added with a default so the database accepts them on
 * a table that already has rows; the rebuild at the end drops `attendee_id` and
 * takes the columns' final form from SCHEMA, which has no default.
 *
 * Every step can be done again: adding a column that is there is taken as done,
 * and the rebuild and the index sync each describe an end state rather than a
 * change. So a run that stopped anywhere — a failed verify, a request that died
 * — is picked up by the next one. The only early exit is "there is no
 * `attendee_id` left to move", which is the state *after* this work; a stale
 * read can only report the state before it, so it cannot end the run early.
 */
export default bareSchemaMigration(
  "2026-07-28_note_entities",
  "Replace system_notes.attendee_id with entity_type + entity_id, so notes can be about any record and not only an attendee. Existing notes become notes about an attendee",
  async ({ getDb, recreateTable, syncIndexes }) => {
    const [info] = await queryBatchPrimary([
      { args: [], sql: "SELECT name FROM pragma_table_info('system_notes')" },
    ]);
    const columns = new Set(info!.rows.map((row) => String(row.name)));
    if (!columns.has("attendee_id")) {
      // The columns are already moved, but a run that died right after the
      // rebuild never reached the index. Asking for it again is cheap.
      await syncIndexes();
      return;
    }

    await addColumn(getDb, "entity_type TEXT NOT NULL DEFAULT 'attendee'");
    await addColumn(getDb, "entity_id INTEGER NOT NULL DEFAULT 0");
    await getDb().execute(
      "UPDATE system_notes SET entity_type = 'attendee', entity_id = attendee_id",
    );
    await recreateTable("system_notes"); // rebuild from SCHEMA, dropping attendee_id
    await syncIndexes(); // idx_system_notes_entity in place of the attendee one
  },
);
