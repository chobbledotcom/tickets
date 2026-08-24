import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { numberedStatement } from "#db/numbered-statement.ts";
import { defineRecordTarget, ITEM_TARGET_COLUMNS } from "#db/record-target.ts";
import {
  clauseArgs,
  rowsUnlessNoneMatch,
  whereSql,
} from "#db/where-clauses.ts";

/** A make-believe domain: notes-style columns, two kinds, tables listed. */
const targets = defineRecordTarget({
  columns: { id: "entity_id", kind: "entity_type" },
  kinds: ["attendee", "listing"] as const,
  tables: { attendee: "attendees", listing: "listings" },
});

/** The same domain without tables, so existence cannot be checked. */
const tablelessTargets = defineRecordTarget({
  columns: ITEM_TARGET_COLUMNS,
  kinds: ["listing"] as const,
});

describe("a record named by its kind and its id", () => {
  test("names a record of one kind", () => {
    expect(targets.of("attendee")(7)).toEqual({ id: 7, kind: "attendee" });
  });

  test("gives a record a stable name, and reads it back", () => {
    const key = targets.key({ id: 42, kind: "listing" });

    expect(key).toBe("listing:42");
    expect(targets.fromKey(key)).toEqual({ id: 42, kind: "listing" });
  });

  test("refuses a name of a kind this domain does not have", () => {
    expect(() => targets.fromKey("group:9" as never)).toThrow(
      "Not the name of a record here: group:9",
    );
  });

  test("refuses a name whose id is not a whole number", () => {
    expect(() => targets.fromKey("listing:seven" as never)).toThrow(
      "Not the name of a record here: listing:seven",
    );
  });

  test("drops repeats, keeping the first of each record", () => {
    const kept = targets.unique([
      { id: 1, kind: "listing" },
      { id: 1, kind: "attendee" },
      { id: 1, kind: "listing" },
      { id: 2, kind: "listing" },
    ]);

    expect(kept).toEqual([
      { id: 1, kind: "listing" },
      { id: 1, kind: "attendee" },
      { id: 2, kind: "listing" },
    ]);
  });
});

describe("asking for a record's rows", () => {
  test("uses item_type/item_id where rows hang off any record", () => {
    const where = tablelessTargets.where({ id: 8, kind: "listing" });

    expect(whereSql(where)).toBe(" WHERE item_type = ? AND item_id = ?");
    expect(clauseArgs(where)).toEqual(["listing", 8]);
  });

  test("asks by both of its parts", () => {
    const where = targets.where({ id: 4, kind: "attendee" });

    expect(whereSql(where)).toBe(" WHERE entity_type = ? AND entity_id = ?");
    expect(clauseArgs(where)).toEqual(["attendee", 4]);
  });

  test("names the table when the read joins", () => {
    const where = targets.where({ id: 4, kind: "attendee" }, "note");

    expect(whereSql(where)).toBe(
      " WHERE note.entity_type = ? AND note.entity_id = ?",
    );
  });

  test("asks for several records of one kind in one go", () => {
    const where = targets.whereMany("attendee", [4, 5]);

    expect(whereSql(where)).toBe(
      " WHERE entity_type = ? AND entity_id IN (?, ?)",
    );
    expect(clauseArgs(where)).toEqual(["attendee", 4, 5]);
  });

  test("names the table for several records too", () => {
    expect(whereSql(targets.whereMany("attendee", [4], "note"))).toBe(
      " WHERE note.entity_type = ? AND note.entity_id IN (?)",
    );
  });

  test("asking about no records is a question no row can answer", async () => {
    // The reader sees this and skips the round trip, rather than building
    // `IN ()` — SQL no database accepts.
    let asked = false;
    const rows = await rowsUnlessNoneMatch(
      targets.whereMany("attendee", []),
      () => {
        asked = true;
        return Promise.resolve([{ id: 1 }]);
      },
    );

    expect(rows).toEqual([]);
    expect(asked).toBe(false);
  });

  test("keeps another query's own arguments after the kind", () => {
    const where = targets.whereChosenBy("attendee", {
      args: [12],
      sql: "SELECT attendee_id FROM listing_attendees WHERE listing_id = ?",
    });

    expect(whereSql(where)).toBe(
      " WHERE entity_type = ? AND entity_id IN" +
        " (SELECT attendee_id FROM listing_attendees WHERE listing_id = ?)",
    );
    expect(clauseArgs(where)).toEqual(["attendee", 12]);
  });
});

describe("deleting a record's rows", () => {
  test("deletes the rows of one record", () => {
    expect(
      targets.deleteFrom("system_notes")({ id: 4, kind: "attendee" }),
    ).toEqual({
      args: ["attendee", 4],
      sql: "DELETE FROM system_notes WHERE entity_type = ? AND entity_id = ?",
    });
  });

  test("deletes the rows of the records another query names", () => {
    expect(
      targets.deleteChosenBy("system_notes")("attendee", {
        args: [12],
        sql: "SELECT attendee_id FROM listing_attendees WHERE listing_id = ?",
      }),
    ).toEqual({
      args: ["attendee", 12],
      sql:
        "DELETE FROM system_notes WHERE entity_type = ? AND entity_id IN" +
        " (SELECT attendee_id FROM listing_attendees WHERE listing_id = ?)",
    });
  });
});

describe("checking a record is really there", () => {
  test("asks the table that kind of record lives in", () => {
    const statement = numberedStatement((bind) =>
      targets.existsSql("listing", bind(4)),
    );
    expect(statement.sql).toBe("EXISTS (SELECT 1 FROM listings WHERE id = ?1)");
    expect(statement.args).toEqual([4]);
  });

  test("says so loudly when the domain listed no tables", () => {
    expect(() =>
      numberedStatement((bind) =>
        tablelessTargets.existsSql("listing", bind(1)),
      ),
    ).toThrow("No table listed for listing records");
  });
});
