/** The column fragments the schema tables share: pin them exactly, because a
 * flipped word here silently changes every table that spreads the fragment. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  itemLinkColumns,
  slugNamedEntityColumns,
  statefulColumns,
} from "#shared/db/migrations/schema/columns.ts";

describe("shared schema columns", () => {
  test("the slug-named entity header is id, slug, its blind index, and name", () => {
    expect(slugNamedEntityColumns).toEqual([
      ["id", "INTEGER PRIMARY KEY AUTOINCREMENT"],
      ["slug", "TEXT NOT NULL"],
      ["slug_index", "TEXT NOT NULL"],
      ["name", "TEXT NOT NULL"],
    ]);
  });

  test("the item link is the polymorphic reference plus its sort order", () => {
    expect(itemLinkColumns).toEqual([
      ["item_type", "TEXT NOT NULL"],
      ["item_id", "INTEGER NOT NULL"],
      ["sort_order", "INTEGER NOT NULL DEFAULT 0"],
    ]);
  });

  test("the stateful tail is the state word and the creation time", () => {
    expect(statefulColumns).toEqual([
      ["state", "TEXT NOT NULL"],
      ["created_at", "TEXT NOT NULL"],
    ]);
  });
});
