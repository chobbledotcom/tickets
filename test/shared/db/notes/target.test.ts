import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  attendeeNotes,
  groupNotesByTargetId,
  isNoteEntity,
  isSameTarget,
  NOTE_ENTITIES,
  notesAbout,
  targetsSelectedBy,
  targetsWhere,
  targetWhere,
} from "#shared/db/notes/target.ts";

describe("what a note is about", () => {
  test("names a record by its kind and its id", () => {
    expect(attendeeNotes(7)).toEqual({ entity: "attendee", id: 7 });
  });

  test("every listed kind can name a record", () => {
    expect(NOTE_ENTITIES).toContain("attendee");
    for (const entity of NOTE_ENTITIES) {
      expect(notesAbout(entity)(3)).toEqual({ entity, id: 3 });
    }
  });

  test("accepts only the kinds on the list", () => {
    expect(isNoteEntity("attendee")).toBe(true);
    expect(isNoteEntity("listing")).toBe(false);
    expect(isNoteEntity("")).toBe(false);
  });

  test("two targets match only when both kind and id match", () => {
    expect(isSameTarget(attendeeNotes(1), attendeeNotes(1))).toBe(true);
    expect(isSameTarget(attendeeNotes(1), attendeeNotes(2))).toBe(false);
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

  test("asks for nothing when given no ids", () => {
    // `0 = 1` is false for every row, so an empty list selects no notes rather
    // than every note of that kind.
    expect(targetsWhere("attendee", [])).toEqual({ args: [], sql: "0 = 1" });
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
