/**
 * What a note is about.
 *
 * A note names the kind of record it is about and which one of that kind, so
 * any record the operator can open can carry notes. The naming and the SQL
 * come from the shared record-target vocabulary; this module only says which
 * kinds a note may be about and which columns hold them.
 */

import * as v from "valibot";
import {
  defineRecordTarget,
  type RecordTarget,
  type RecordTargets,
} from "#shared/db/record-target.ts";

/** The kinds of record a note can be about. Adding one here is what lets a
 *  page carry notes; the stored values are checked against this list. */
export const NoteEntitySchema = v.picklist(["attendee"]);

export type NoteEntity = v.InferOutput<typeof NoteEntitySchema>;

export const NOTE_ENTITIES = NoteEntitySchema.options;

/** One record a note is about: its kind, and which one of that kind. */
export type NoteTarget = RecordTarget<NoteEntity>;

/** How to name and ask for the records notes are about. */
export const noteTargets: RecordTargets<NoteEntity> = defineRecordTarget({
  columns: { id: "entity_id", kind: "entity_type" },
  kinds: NOTE_ENTITIES,
});

/** Notes about one attendee. */
export const attendeeNotes = noteTargets.of("attendee");

/** Group notes by which record they are about — for a batch about one kind of
 *  record, where the id alone tells them apart. Input order is kept per group. */
export const groupNotesByTargetId = <Note extends { entity_id: number }>(
  notes: Note[],
): Map<number, Note[]> => Map.groupBy(notes, (note) => note.entity_id);
