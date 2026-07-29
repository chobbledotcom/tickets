import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  attendeeNotes,
  groupNotesByTargetId,
  NOTE_ENTITIES,
  targetsSelectedBy,
  targetsWhere,
  targetWhere,
} from "#shared/db/notes/target.ts";

describe("what a note is about", () => {
  test("names a record by its kind and its id", () => {
    expect(attendeeNotes(7)).toEqual({ entity: "attendee", id: 7 });
  });

  test("lists the kinds of record a note can be about", () => {
    // The database CHECK is built from this list, so it is also what a stored
    // note is allowed to say.
    expect([...NOTE_ENTITIES]).toEqual(["attendee"]);
  });

  test("asks for one record by both of its parts", () => {
    expect(targetWhere(attendeeNotes(4))).toEqual({
      args: ["attendee", 4],
      sql: "entity_type = ? AND entity_id = ?",
    });
  });

  test("asks for several records of one kind in one go", () => {
    expect(targetsWhere("attendee", [4, 5])).toEqual({
      args: ["attendee", 4, 5],
      sql: "entity_type = ? AND entity_id IN (?, ?)",
    });
  });

  test("refuses to ask about no records at all", () => {
    // Building `IN ()` would be SQL no database accepts, and a caller with
    // nothing to ask about should not have reached here.
    expect(() => targetsWhere("attendee", [])).toThrow(
      "Asked for the notes of no attendee records",
    );
  });

  test("keeps the subquery's own arguments after the kind", () => {
    expect(
      targetsSelectedBy("attendee", {
        args: [12],
        sql: "SELECT attendee_id FROM listing_attendees WHERE listing_id = ?",
      }),
    ).toEqual({
      args: ["attendee", 12],
      sql: "entity_type = ? AND entity_id IN (SELECT attendee_id FROM listing_attendees WHERE listing_id = ?)",
    });
  });

  test("groups notes by the record they are about, keeping their order", () => {
    const notes = [
      { entity_id: 1, note: "first" },
      { entity_id: 2, note: "other" },
      { entity_id: 1, note: "second" },
    ];

    const grouped = groupNotesByTargetId(notes);

    expect(grouped.get(1)?.map((note) => note.note)).toEqual([
      "first",
      "second",
    ]);
    expect(grouped.get(2)?.map((note) => note.note)).toEqual(["other"]);
    expect(grouped.get(3)).toBeUndefined();
  });
});
