import { queryBatchPrimary } from "#shared/db/client.ts";
import { errorMessage } from "#shared/error-message.ts";
import { bareSchemaMigration } from "./define.ts";

/** What the database says when a column is already there. */
const ALREADY_ADDED = "duplicate column name";

/** What it says when `attendee_id` has already gone, so its notes are moved. */
const ALREADY_MOVED = "no such column: attendee_id";

type RunSql = (sql: string) => Promise<unknown>;

/**
 * Do a step, treating the database's own "that is already so" as done.
 *
 * A run that got partway and died leaves the database ahead of what a read
 * reports — even a read from the primary, which can briefly answer with the
 * schema as it was (see the backoff note in ./runner.ts). So each step asks the
 * database to do the thing and believes its answer, rather than deciding from a
 * picture of the schema that may be out of date.
 */
const stepDone = async (
  run: () => Promise<unknown>,
  alreadySo: string,
): Promise<void> => {
  try {
    await run();
  } catch (error) {
    if (!errorMessage(error).includes(alreadySo)) throw error;
  }
};

const addColumn = (execute: RunSql, column: string): Promise<void> =>
  stepDone(
    () => execute(`ALTER TABLE system_notes ADD COLUMN ${column}`),
    ALREADY_ADDED,
  );

const moveNotesToTargets = (execute: RunSql): Promise<void> =>
  stepDone(
    () =>
      execute(
        "UPDATE system_notes SET entity_type = 'attendee', entity_id = attendee_id",
      ),
    ALREADY_MOVED,
  );

/**
 * Notes used to belong to an attendee and nothing else. They now name the kind
 * of record they are about and which one, so any record can carry notes.
 *
 * The two new columns are added with a default so the database accepts them on
 * a table that already has rows; the rebuild at the end drops `attendee_id` and
 * takes the columns' final form from SCHEMA, which has no default.
 *
 * Every step can be done again, and each one takes the database's word for
 * whether it is already so — a column that is there, an `attendee_id` that has
 * gone. The rebuild and the index sync describe an end state rather than a
 * change. So a run that stopped anywhere is picked up by the next one, even
 * when what it reads about the schema is a moment behind what is true.
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

    const execute: RunSql = (sql) => getDb().execute(sql);
    await addColumn(execute, "entity_type TEXT NOT NULL DEFAULT 'attendee'");
    await addColumn(execute, "entity_id INTEGER NOT NULL DEFAULT 0");
    await moveNotesToTargets(execute);
    // The rebuild drops attendee_id, and takes the table's indexes from SCHEMA
    // as it goes, so idx_system_notes_entity arrives with it.
    await recreateTable("system_notes");
  },
);
