/**
 * Unit tests for `src/shared/db/read.ts` — the one place a said read becomes
 * SQL. These are pure string-and-args assertions with no database, so they pin
 * the exact shape every reader now inherits: the order of the parts, and the
 * order of the values that fill them.
 */

import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { defineReader, readStatement } from "#db/read.ts";
import { sql } from "#db/sql.ts";
import { equals, inList } from "#db/where-clauses.ts";

describe("readStatement", () => {
  test("says the plainest read with nothing but columns and a table", () => {
    expect(
      readStatement({ columns: sql`id, name`, from: sql`listings` }),
    ).toEqual(sql`SELECT id, name FROM listings`);
  });

  test("assembles the parts in SQL order", () => {
    expect(
      readStatement({
        columns: sql`listing.id`,
        from: sql`listings AS listing`,
        groupBy: sql`listing.id`,
        limit: 5,
        order: sql`listing.created DESC`,
        where: equals("listing.active", 1),
      }),
    ).toEqual(
      sql`SELECT listing.id FROM listings AS listing WHERE listing.active = ${1} GROUP BY listing.id ORDER BY listing.created DESC LIMIT ${5}`,
    );
  });

  test("binds a join's own values before the filter's, then the cap", () => {
    expect(
      readStatement({
        columns: sql`question.id`,
        from: sql`questions AS question LEFT JOIN listing_questions AS listingQuestion ON listingQuestion.listing_id = ${"joined"}`,
        limit: 2,
        where: equals("question.active", "filtered"),
      }).args,
    ).toEqual(["joined", "filtered", 2]);
  });

  test("omits every part the read does not ask for", () => {
    const { sql: text } = readStatement({
      columns: sql`id`,
      from: sql`listings`,
    });

    assert(!text.includes("WHERE"));
    assert(!text.includes("GROUP BY"));
    assert(!text.includes("ORDER BY"));
    assert(!text.includes("LIMIT"));
  });

  test("an empty filter list adds no WHERE", () => {
    expect(
      readStatement({ columns: sql`id`, from: sql`listings`, where: [] }).sql,
    ).toBe("SELECT id FROM listings");
  });

  test("a filter matching nothing still says so in SQL", () => {
    // readRows skips the round trip, but a caller embedding this in a batch
    // must still get valid SQL rather than an invalid `IN ()`.
    expect(
      readStatement({
        columns: sql`id`,
        from: sql`listings`,
        where: inList("id", []),
      }).sql,
    ).toBe("SELECT id FROM listings WHERE id IN (NULL)");
  });
});

describe("defineReader", () => {
  const reader = defineReader<
    "newest" | "oldest",
    { order?: "newest" | "oldest" }
  >({ newest: sql`created DESC`, oldest: sql`created ASC` }, () => ({
    columns: sql`id`,
    from: sql`listings`,
  }));

  test("each named order becomes its own ORDER BY", () => {
    expect(reader.statement({ order: "newest" }).sql).toBe(
      "SELECT id FROM listings ORDER BY created DESC",
    );
    expect(reader.statement({ order: "oldest" }).sql).toBe(
      "SELECT id FROM listings ORDER BY created ASC",
    );
  });

  test("omitting the order omits the clause", () => {
    expect(reader.statement({}).sql).toBe("SELECT id FROM listings");
  });
});
