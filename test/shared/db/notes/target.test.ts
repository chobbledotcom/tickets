import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  attendeeNotes,
  groupNotesByTargetId,
  NOTE_ENTITIES,
  noteTargets,
} from "#db/notes/target.ts";
import { whereTail } from "#db/select/expression.ts";
import { sql } from "#db/sql.ts";

describe("what a note is about", () => {
  test("names a record by its kind and its id", () => {
    expect(attendeeNotes(7)).toEqual({ id: 7, kind: "attendee" });
  });

  test("lists the kinds of record a note can be about", () => {
    // The database CHECK is built from this list, so it is also what a stored
    // note is allowed to say.
    expect([...NOTE_ENTITIES]).toEqual(["attendee", "group", "listing"]);
  });

  test("asks for a note's record by the columns notes store it in", () => {
    const where = noteTargets.where(attendeeNotes(4));
    expect(whereTail(where)).toEqual(
      sql` WHERE entity_type = ${"attendee"} AND entity_id = ${4}`,
    );
  });

  test("groups notes by the record they are about, keeping their order", () => {
    // Two of the notes name one record, one names another, so grouping must
    // both bucket and keep the order.
    const notes = [
      { entityId: 1, note: "first" },
      { entityId: 2, note: "other" },
      { entityId: 1, note: "second" },
    ];
    const grouped = groupNotesByTargetId(notes);

    // The whole map answers at once: which records carry notes, each in input
    // order, and nothing for a record with none.
    expect(Object.fromEntries(grouped)).toEqual({
      1: [
        { entityId: 1, note: "first" },
        { entityId: 1, note: "second" },
      ],
      2: [{ entityId: 2, note: "other" }],
    });
  });
});
