import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  attendeeNotes,
  groupNotesByTargetId,
  NOTE_ENTITIES,
  noteTargets,
} from "#db/notes/target.ts";
import { sql } from "#db/sql.ts";
import { whereSql } from "#db/where-clauses.ts";

/** Notes in input order: two of them name one record, one names another, so
 *  grouping must both bucket and keep the order. */
const interleavedNotes = [
  { entity_id: 1, note: "first" },
  { entity_id: 2, note: "other" },
  { entity_id: 1, note: "second" },
];

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
    expect(whereSql(where)).toEqual(
      sql` WHERE entity_type = ${"attendee"} AND entity_id = ${4}`,
    );
  });

  test("groups notes by the record they are about, keeping their order", () => {
    const grouped = groupNotesByTargetId(interleavedNotes);

    // The whole map answers at once: which records carry notes, each in input
    // order, and nothing for a record with none.
    expect(Object.fromEntries(grouped)).toEqual({
      1: [
        { entity_id: 1, note: "first" },
        { entity_id: 1, note: "second" },
      ],
      2: [{ entity_id: 2, note: "other" }],
    });
  });
});
