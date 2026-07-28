/**
 * What a note is about.
 *
 * A note names the kind of record it is about and which one of that kind, so
 * any record the operator can open can carry notes. This module is pure: it
 * says what a target is and how to ask for one in SQL, and never touches the
 * database itself.
 */

import * as v from "valibot";
import type { SqlStatement } from "#shared/db/client.ts";
import { inPlaceholders } from "#shared/db/client.ts";

/** The kinds of record a note can be about. Adding one here is what lets a
 *  page carry notes; the stored values are checked against this list. */
export const NoteEntitySchema = v.picklist(["attendee"]);

export type NoteEntity = v.InferOutput<typeof NoteEntitySchema>;

export const NOTE_ENTITIES = NoteEntitySchema.options;

/** One record a note is about: its kind, and which one of that kind. */
export interface NoteTarget {
  entity: NoteEntity;
  id: number;
}

/** Build "a note about this kind of thing" once, then name records with it. */
const notesAbout =
  (entity: NoteEntity) =>
  (id: number): NoteTarget => ({ entity, id });

/** Notes about one attendee. */
export const attendeeNotes = notesAbout("attendee");

/** Group notes by which record they are about — for a batch about one kind of
 *  record, where the id alone tells them apart. Input order is kept per group. */
export const groupNotesByTargetId = <Note extends { entity_id: number }>(
  notes: Note[],
): Map<number, Note[]> => Map.groupBy(notes, (note) => note.entity_id);

/** Ask for one record's notes. */
export const targetWhere = ({ entity, id }: NoteTarget): SqlStatement => ({
  args: [entity, id],
  sql: "entity_type = ? AND entity_id = ?",
});

/**
 * Ask for several records of one kind at once. There must be at least one: a
 * caller with nothing to ask about has no question for the database, and asking
 * anyway would build SQL no database accepts.
 */
export const targetsWhere = (
  entity: NoteEntity,
  ids: number[],
): SqlStatement => {
  if (ids.length === 0) {
    throw new Error(`Asked for the notes of no ${entity} records`);
  }
  return {
    args: [entity, ...ids],
    sql: `entity_type = ? AND entity_id IN (${inPlaceholders(ids)})`,
  };
};

/** Ask for the notes of one kind of record, chosen by a subquery of ids. */
export const targetsSelectedBy = (
  entity: NoteEntity,
  idsQuery: SqlStatement,
): SqlStatement => ({
  args: [entity, ...idsQuery.args],
  sql: `entity_type = ? AND entity_id IN (${idsQuery.sql})`,
});
