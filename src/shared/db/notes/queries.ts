/**
 * Reading and writing notes (the `system_notes` table).
 *
 * Every read and write names the record the notes are about, so one shape
 * serves every kind of record: see ./target.ts.
 */

import { ATTENDEE_KIND } from "#shared/db/attendees/kind.ts";
import {
  execute,
  insert,
  queryAll,
  type SqlStatement,
} from "#shared/db/client.ts";
import { nowIso } from "#shared/now.ts";
import { openNotes, sealNote } from "./sealing.ts";
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
const noteRowsWhere = ({ args, sql }: SqlStatement): Promise<SystemNoteRow[]> =>
  queryAll<SystemNoteRow>(
    `SELECT ${NOTE_COLUMNS} FROM system_notes WHERE ${sql} ORDER BY entity_id, id`,
    args,
  );

/**
 * The still-sealed rows for several records of one kind, oldest first. Cheap
 * (no key material): a caller can use it to decide whether any notes exist at
 * all before working out the owner private key to open them.
 */
export const getNoteRows = (
  entity: NoteEntity,
  ids: number[],
): Promise<SystemNoteRow[]> =>
  ids.length === 0
    ? Promise.resolve([])
    : noteRowsWhere(targetsWhere(entity, ids));

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

/** All of one record's notes, opened up, oldest first. */
export const getNotesFor = async (
  target: NoteTarget,
  privateKey: CryptoKey,
): Promise<SystemNote[]> =>
  openNotes(await noteRowsWhere(targetWhere(target)), privateKey);

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

/** One record's note, opened up, or null when it isn't that record's. */
export const getNote = async (
  target: NoteTarget,
  noteId: number,
  privateKey: CryptoKey,
): Promise<SystemNote | null> => {
  const { args, sql } = targetWhere(target);
  const rows = await queryAll<SystemNoteRow>(
    `SELECT ${NOTE_COLUMNS} FROM system_notes WHERE id = ? AND ${sql}`,
    [noteId, ...args],
  );
  const row = rows[0];
  if (!row) return null;
  const [note] = await openNotes([row], privateKey);
  return note ?? null;
};

/** Delete one note, tied to its record so a stray id can't reach another's. */
export const deleteNote = (
  target: NoteTarget,
  noteId: number,
): Promise<unknown> => {
  const { args, sql } = targetWhere(target);
  return execute(`DELETE FROM system_notes WHERE id = ? AND ${sql}`, [
    noteId,
    ...args,
  ]);
};

/** Delete the notes of records chosen by a subquery — for a delete path that
 *  clears a record's dependent rows in one batch. */
export const noteDeleteStatement = (
  entity: NoteEntity,
  idsQuery: SqlStatement,
): SqlStatement => {
  const { args, sql } = targetsSelectedBy(entity, idsQuery);
  return { args, sql: `DELETE FROM system_notes WHERE ${sql}` };
};
