/**
 * Reading and writing notes (the `system_notes` table).
 *
 * Every read and write names the record the notes are about, so one shape
 * serves every kind of record: see ./target.ts.
 */

import { ATTENDEE_KIND } from "#shared/db/attendees/kind.ts";
import {
  execute,
  executeBatch,
  insert,
  queryAll,
  type SqlStatement,
} from "#shared/db/client.ts";
import {
  clauseArgs,
  equals,
  rowsUnlessNoneMatch,
  type WhereClause,
  whereSql,
} from "#shared/db/where-clauses.ts";
import { nowIso } from "#shared/now.ts";
import { openNote, openNotes, sealNote } from "./sealing.ts";
import {
  type NoteEntity,
  type NoteTarget,
  targetsSelectedBy,
  targetsWhere,
  targetWhere,
} from "./target.ts";
import type { SystemNote, SystemNoteRow, SystemNoteType } from "./types.ts";

const NOTE_COLUMNS = "id, entity_type, entity_id, type, note, created";

/** Build a "record a note" function for one kind of note: it seals the text the
 *  way that kind is sealed, then stores it against the record it is about. */
const noteWriterOf =
  (type: SystemNoteType) =>
  async (target: NoteTarget, note: string): Promise<void> => {
    const { sql, args } = insert("system_notes", {
      created: nowIso(),
      entity_id: target.id,
      entity_type: target.entity,
      note: await sealNote(type, note),
      type,
    });
    await execute(sql, args);
  };

/**
 * Record a note the app wrote itself. The text MUST be free of personal
 * details: it is sealed with the symmetric DB key (readable from a database
 * dump plus that key), and exists so a path with no owner session can write it.
 */
export const createSystemNote = noteWriterOf("system");

/** Record an operator's note, sealed with the owner public key. */
export const createOwnerNote = noteWriterOf("owner");

/** The still-sealed rows matching a WHERE body, oldest first per record. Shared
 *  by every read so the column list and the ordering live in one place. */
const noteRowsWhere = (where: WhereClause[]): Promise<SystemNoteRow[]> =>
  rowsUnlessNoneMatch(where, () =>
    queryAll<SystemNoteRow>(
      `SELECT ${NOTE_COLUMNS} FROM system_notes${whereSql(where)} ORDER BY entity_id, id`,
      clauseArgs(where),
    ),
  );

/**
 * The still-sealed rows for several records of one kind, oldest first. Cheap
 * (no key material): a caller can use it to decide whether any notes exist at
 * all before working out the owner private key to open them.
 */
export const getNoteRows = (
  entity: NoteEntity,
  ids: number[],
): Promise<SystemNoteRow[]> => noteRowsWhere(targetsWhere(entity, ids));

/**
 * The still-sealed rows for every real (`kind = 'attendee'`) attendee booked
 * onto one listing, oldest first — chosen in SQL rather than by passing a list
 * of attendee ids, so the Overview never loads (nor binds) a row per attendee
 * just to find the handful with notes.
 */
export const getNoteRowsForListing = (
  listingId: number,
): Promise<SystemNoteRow[]> =>
  noteRowsWhere(
    targetsSelectedBy("attendee", {
      args: [listingId],
      sql: `SELECT listingAttendee.attendee_id
              FROM listing_attendees AS listingAttendee
              JOIN attendees AS attendee ON attendee.id = listingAttendee.attendee_id
             WHERE listingAttendee.listing_id = ? AND attendee.kind = '${ATTENDEE_KIND}'`,
    }),
  );

/** All of one record's notes, opened up, oldest first. One record is a list of
 *  one, so it is asked for the same way several are. */
export const getNotesFor = async (
  target: NoteTarget,
  privateKey: CryptoKey,
): Promise<SystemNote[]> =>
  openNotes(await getNoteRows(target.entity, [target.id]), privateKey);

/** A "load the notes for <selector>" reader: takes the selector value and a way
 *  to get the owner private key, and answers with opened-up notes. */
type NotesLoader<A> = (
  selector: A,
  getPrivateKey: () => Promise<CryptoKey>,
) => Promise<SystemNote[]>;

/**
 * Build a loader from a row-fetcher: fetch the still-sealed rows, then open
 * them, working out the owner private key only when at least one note exists —
 * so a note-free view never pays for a key unwrap.
 */
const notesLoaderVia =
  <A>(fetchRows: (selector: A) => Promise<SystemNoteRow[]>): NotesLoader<A> =>
  async (selector, getPrivateKey) => {
    const rows = await fetchRows(selector);
    return rows.length === 0 ? [] : openNotes(rows, await getPrivateKey());
  };

/**
 * The notes of several attendees, oldest first, for an attendee-list view.
 * Answers with [] when none of them have notes.
 */
export const loadNotesForAttendees: NotesLoader<number[]> = notesLoaderVia(
  (attendeeIds) => getNoteRows("attendee", attendeeIds),
);

/**
 * The notes of every real attendee on one listing, oldest first — chosen in SQL
 * (see {@link getNoteRowsForListing}). Answers with [] when none have notes, so
 * a note-free listing's Overview skips the key unwrap.
 */
export const loadNotesForListing: NotesLoader<number> = notesLoaderVia(
  getNoteRowsForListing,
);

/** One note, tied to the record it has to belong to, so a stray id can't reach
 *  another record's note. */
const noteOfTarget = (target: NoteTarget, noteId: number): WhereClause[] => [
  ...equals("id", noteId),
  ...targetWhere(target),
];

/** A delete over the notes the clauses select. */
const deleteNotesWhere = (where: WhereClause[]): SqlStatement => ({
  args: clauseArgs(where),
  sql: `DELETE FROM system_notes${whereSql(where)}`,
});

/** One record's note, opened up, or null when it isn't that record's. */
export const getNote = async (
  target: NoteTarget,
  noteId: number,
  privateKey: CryptoKey,
): Promise<SystemNote | null> => {
  const where = noteOfTarget(target, noteId);
  const rows = await queryAll<SystemNoteRow>(
    `SELECT ${NOTE_COLUMNS} FROM system_notes${whereSql(where)}`,
    clauseArgs(where),
  );
  const row = rows[0];
  return row ? openNote(row, privateKey) : null;
};

/**
 * Delete notes, tied to their record so a stray id can't reach another's. They
 * go in one batch: several stale notes cost one round trip, not one each.
 */
export const deleteNotes = (
  target: NoteTarget,
  noteIds: number[],
): Promise<void> => {
  if (noteIds.length === 0) return Promise.resolve();
  return executeBatch(
    noteIds.map((noteId) => deleteNotesWhere(noteOfTarget(target, noteId))),
  );
};

/** Delete the notes of records chosen by a subquery — for a delete path that
 *  clears a record's dependent rows in one batch. */
export const noteDeleteStatement = (
  entity: NoteEntity,
  idsQuery: SqlStatement,
): SqlStatement => deleteNotesWhere(targetsSelectedBy(entity, idsQuery));
