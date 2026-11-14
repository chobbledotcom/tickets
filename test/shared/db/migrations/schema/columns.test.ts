/** The column fragments the schema tables share: pin them exactly, because a
 * flipped word here silently changes every table that spreads the fragment. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  attendeeIdColumn,
  datedRowColumns,
  itemLinkColumns,
  slugNamedEntityColumns,
  sortOrderColumn,
  statefulColumns,
} from "#db/migrations/schema/columns.ts";
import { sqlText } from "#test-utils/sql-text.ts";

describe("shared schema columns", () => {
  test("the attendee column names the attendee and holds a whole number", () => {
    expect(sqlText(attendeeIdColumn)).toEqual([
      "attendee_id",
      "INTEGER NOT NULL",
    ]);
  });

  test("the dated row header is its own id and when it was made", () => {
    expect(sqlText(datedRowColumns)).toEqual([
      ["id", "INTEGER PRIMARY KEY AUTOINCREMENT"],
      ["created", "TEXT NOT NULL"],
    ]);
  });

  test("the list position starts at zero", () => {
    expect(sqlText(sortOrderColumn)).toEqual([
      "sort_order",
      "INTEGER NOT NULL DEFAULT 0",
    ]);
  });

  test("the slug-named entity header is id, slug, its blind index, and name", () => {
    expect(sqlText(slugNamedEntityColumns)).toEqual([
      ["id", "INTEGER PRIMARY KEY AUTOINCREMENT"],
      ["slug", "TEXT NOT NULL"],
      ["slug_index", "TEXT NOT NULL"],
      ["name", "TEXT NOT NULL"],
    ]);
  });

  test("the item link is the polymorphic reference plus its sort order", () => {
    expect(sqlText(itemLinkColumns)).toEqual([
      ["item_type", "TEXT NOT NULL"],
      ["item_id", "INTEGER NOT NULL"],
      ["sort_order", "INTEGER NOT NULL DEFAULT 0"],
    ]);
  });

  test("the stateful tail is the state word and the creation time", () => {
    expect(sqlText(statefulColumns)).toEqual([
      ["state", "TEXT NOT NULL"],
      ["created_at", "TEXT NOT NULL"],
    ]);
  });
});
