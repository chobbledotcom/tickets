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
import {
  clauseArgs,
  rowsUnlessNoneMatch,
  whereSql,
} from "#shared/db/where-clauses.ts";

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
    const where = targetWhere(attendeeNotes(4));
    expect(whereSql(where)).toBe(" WHERE entity_type = ? AND entity_id = ?");
    expect(clauseArgs(where)).toEqual(["attendee", 4]);
  });

  test("asks for several records of one kind in one go", () => {
    const where = targetsWhere("attendee", [4, 5]);
    expect(whereSql(where)).toBe(
      " WHERE entity_type = ? AND entity_id IN (?, ?)",
    );
    expect(clauseArgs(where)).toEqual(["attendee", 4, 5]);
  });

  test("asking about no records is a question no row can answer", async () => {
    // The reader sees this and skips the round trip, rather than building
    // `IN ()` — SQL no database accepts.
    let asked = false;
    const rows = await rowsUnlessNoneMatch(targetsWhere("attendee", []), () => {
      asked = true;
      return Promise.resolve([{ id: 1 }]);
    });

    expect(rows).toEqual([]);
    expect(asked).toBe(false);
  });

  test("keeps the subquery's own arguments after the kind", () => {
    const where = targetsSelectedBy("attendee", {
      args: [12],
      sql: "SELECT attendee_id FROM listing_attendees WHERE listing_id = ?",
    });
    expect(whereSql(where)).toBe(
      " WHERE entity_type = ? AND entity_id IN" +
        " (SELECT attendee_id FROM listing_attendees WHERE listing_id = ?)",
    );
    expect(clauseArgs(where)).toEqual(["attendee", 12]);
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
