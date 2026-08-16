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
  type SqlStatement,
  type TxScope,
} from "#shared/db/client.ts";
import { readOneRow, readRows } from "#shared/db/read.ts";
import {
  deleteWhere,
  equals,
  type WhereClause,
} from "#shared/db/where-clauses.ts";
import { nowIso } from "#shared/now.ts";
import { openNote, openNotes, sealNote } from "./sealing.ts";
import { type NoteEntity, type NoteTarget, noteTargets } from "./target.ts";
import type {
  SystemNote,
  SystemNoteName,
  SystemNoteRow,
  SystemNoteType,
} from "./types.ts";

const NOTE_COLUMNS =
  "id, entity_type, entity_id, type, note, system_name, created";

/** Build a "record a note" function for one kind of note: it seals the text the
 *  way that kind is sealed, then stores it against the record it is about. */
type NoteWriter = (
  target: NoteTarget,
  note: string,
  transaction?: TxScope,
) => Promise<void>;

const storedSystemNoteName = ({ key, purpose }: SystemNoteName): string =>
  `system-note:1:${JSON.stringify([purpose, key])}`;

const writeNote = async (
  type: SystemNoteType,
  target: NoteTarget,
  note: string,
  name: SystemNoteName | null,
  transaction?: TxScope,
): Promise<void> => {
  if (name?.key === "") throw new Error("A named system note needs a key");
  const inserted = insert("system_notes", {
    created: nowIso(),
    entity_id: target.id,
    entity_type: target.kind,
    note: await sealNote(type, note),
    system_name: name === null ? null : storedSystemNoteName(name),
    type,
  });
  // A named note is unique by its name: a replayed write is a no-op, so a
  // resumable flow can re-run its note step without a second copy landing.
  const sql =
    name === null
      ? inserted.sql
      : inserted.sql.replace(/^INSERT INTO/, "INSERT OR IGNORE INTO");
  if (transaction === undefined) {
    await execute(sql, inserted.args);
  } else {
    await transaction.execute({ args: inserted.args, sql });
  }
};

const noteWriterOf =
  (type: SystemNoteType): NoteWriter =>
  (target, note, transaction) =>
    writeNote(type, target, note, null, transaction);

/**
 * Record a note the app wrote itself. The text MUST be free of personal
 * details: it is sealed with the symmetric DB key (readable from a database
 * dump plus that key), and exists so a path with no owner session can write it.
 */
export const createSystemNote = noteWriterOf("system");

/** Record an app-written note with an indexed purpose and opaque identity.
 * Its lifecycle can then be managed without opening any note text. */
export const createNamedSystemNote = (
  target: NoteTarget,
  note: string,
  name: SystemNoteName,
  transaction?: TxScope,
): Promise<void> => writeNote("system", target, note, name, transaction);

/** Record an operator's note, sealed with the owner public key. */
export const createOwnerNote = noteWriterOf("owner");

/** The still-sealed rows matching a WHERE body, oldest first per record. Shared
 *  by every read so the column list and the ordering live in one place. */
const noteRowsWhere = (where: WhereClause[]): Promise<SystemNoteRow[]> =>
  readRows<SystemNoteRow>({
    columns: NOTE_COLUMNS,
    from: "system_notes",
    order: "entity_id, id",
    where,
  });

/**
 * The still-sealed rows for several records of one kind, oldest first. Cheap
 * (no key material): a caller can use it to decide whether any notes exist at
 * all before working out the owner private key to open them.
 */
export const getNoteRows = (
  entity: NoteEntity,
  ids: number[],
): Promise<SystemNoteRow[]> =>
  noteRowsWhere(noteTargets.whereMany(entity, ids));

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
    noteTargets.whereChosenBy("attendee", {
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
  openNotes(await getNoteRows(target.kind, [target.id]), privateKey);

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
  ...noteTargets.where(target),
];

/** A delete over the notes the clauses select. */
const deleteNotesWhere = deleteWhere("system_notes");

/** One record's note, opened up, or null when it isn't that record's. */
export const getNote = async (
  target: NoteTarget,
  noteId: number,
  privateKey: CryptoKey,
): Promise<SystemNote | null> => {
  const row = await readOneRow<SystemNoteRow>({
    columns: NOTE_COLUMNS,
    from: "system_notes",
    where: noteOfTarget(target, noteId),
  });
  return row ? openNote(row, privateKey) : null;
};

/**
 * Delete notes, tied to their record so a stray id can't reach another's. They
 * go in one batch: several stale notes cost one round trip, not one each.
 */
export const deleteNotes = async (
  target: NoteTarget,
  noteIds: number[],
): Promise<void> => {
  if (noteIds.length === 0) return;
  const statements = noteIds.map((noteId) =>
    deleteNotesWhere(noteOfTarget(target, noteId)),
  );
  await executeBatch(statements);
};

/** Delete the notes of records chosen by a subquery — for a delete path that
 *  clears a record's dependent rows in one batch. */
export const noteDeleteStatement: (
  entity: NoteEntity,
  idsQuery: SqlStatement,
) => SqlStatement = noteTargets.deleteChosenBy("system_notes");
