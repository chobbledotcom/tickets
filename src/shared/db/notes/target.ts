/**
 * What a note is about.
 *
 * A note used to belong to an attendee and nothing else. It now names the kind
 * of thing it is about and which one, so any record the operator can open can
 * carry notes. This module is pure: it says what a target is and how to ask for
 * one in SQL, and never touches the database itself.
 */

import * as v from "valibot";
import type { SqlStatement } from "#shared/db/client.ts";
import { inPlaceholders } from "#shared/db/client.ts";

/** The kinds of record a note can be about. Adding one here is what lets a
 *  page carry notes; the stored values are checked against this list. */
export const NoteEntitySchema = v.picklist(["attendee"]);

export type NoteEntity = v.InferOutput<typeof NoteEntitySchema>;

export const NOTE_ENTITIES = NoteEntitySchema.options;

export const isNoteEntity = (value: string): value is NoteEntity =>
  v.is(NoteEntitySchema, value);

/** One record a note is about: its kind, and which one of that kind. */
export interface NoteTarget {
  entity: NoteEntity;
  id: number;
}

/** Build "a note about this kind of thing" once, then name records with it. */
export const notesAbout =
  (entity: NoteEntity) =>
  (id: number): NoteTarget => ({ entity, id });

/** The record kind notes started with, and still the only one that has them. */
export const attendeeNotes = notesAbout("attendee");

/** Do these two targets name the same record? */
export const isSameTarget = (left: NoteTarget, right: NoteTarget): boolean =>
  left.entity === right.entity && left.id === right.id;

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

/** Ask for several records of one kind at once. An empty list asks for nothing,
 *  which is what `0 = 1` says: no row can answer it. */
export const targetsWhere = (
  entity: NoteEntity,
  ids: number[],
): SqlStatement =>
  ids.length === 0
    ? { args: [], sql: "0 = 1" }
    : {
        args: [entity, ...ids],
        sql: `entity_type = ? AND entity_id IN (${inPlaceholders(ids)})`,
      };

/** Ask for the notes of one kind of record, chosen by a subquery of ids. */
export const targetsSelectedBy = (
  entity: NoteEntity,
  idsQuery: SqlStatement,
): SqlStatement => ({
  args: [entity, ...idsQuery.args],
  sql: `entity_type = ? AND entity_id IN (${idsQuery.sql})`,
});
