/** The column fragments the schema tables share: pin them exactly, because a
 * flipped word here silently changes every table that spreads the fragment. */

import { describe } from "@std/testing/bdd";
import {
  attendeeIdColumn,
  datedRowColumns,
  itemLinkColumns,
  slugNamedEntityColumns,
  sortOrderColumn,
  statefulColumns,
} from "#db/migrations/schema/columns.ts";
import { testColumnFragments } from "#test-utils/column-fragments.ts";

describe("shared schema columns", () => {
  testColumnFragments([
    {
      fragment: attendeeIdColumn,
      name: "the attendee column names the attendee and holds a whole number",
      text: ["attendee_id", "INTEGER NOT NULL"],
    },
    {
      fragment: datedRowColumns,
      name: "the dated row header is its own id and when it was made",
      text: [
        ["id", "INTEGER PRIMARY KEY AUTOINCREMENT"],
        ["created", "TEXT NOT NULL"],
      ],
    },
    {
      fragment: sortOrderColumn,
      name: "the list position starts at zero",
      text: ["sort_order", "INTEGER NOT NULL DEFAULT 0"],
    },
    {
      fragment: slugNamedEntityColumns,
      name: "the slug-named entity header is id, slug, its blind index, and name",
      text: [
        ["id", "INTEGER PRIMARY KEY AUTOINCREMENT"],
        ["slug", "TEXT NOT NULL"],
        ["slug_index", "TEXT NOT NULL"],
        ["name", "TEXT NOT NULL"],
      ],
    },
    {
      fragment: itemLinkColumns,
      name: "the item link is the polymorphic reference plus its sort order",
      text: [
        ["item_type", "TEXT NOT NULL"],
        ["item_id", "INTEGER NOT NULL"],
        ["sort_order", "INTEGER NOT NULL DEFAULT 0"],
      ],
    },
    {
      fragment: statefulColumns,
      name: "the stateful tail is the state word and the creation time",
      text: [
        ["state", "TEXT NOT NULL"],
        ["created_at", "TEXT NOT NULL"],
      ],
    },
  ]);
});
