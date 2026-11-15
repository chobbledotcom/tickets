/**
 * Tests for the match, the column pick, and the one-answer reads of
 * `src/shared/db/select/query.ts`.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { matchesNothing } from "#db/select/expression.ts";
import { from, pick, tableNode } from "#db/select/query.ts";
import { tables } from "#db/select/tables.ts";
import { placed } from "#test-utils/sql-text.ts";

describe("a match", () => {
  test("narrows a read to the rows whose columns hold its values", () => {
    expect(
      placed(
        from(tables.listings)
          .where({ id: [3, 4], slug_index: "x" })
          .select((listing) => ({ id: listing.id })),
      ),
    ).toEqual({
      args: [3, 4, "x"],
      sql: "SELECT listing.id AS id FROM listings AS listing WHERE listing.id IN (?, ?) AND listing.slug_index = ?",
    });
  });

  test("names the columns of the first table of a read with joins", () => {
    expect(
      from(tables.listing_attendees, { listing: {} })
        .where({ quantity: 2 })
        .values((line) => line.listing.id).sql,
    ).toBe(
      "SELECT listing.id FROM listing_attendees AS listingAttendee JOIN listings AS listing ON listing.id = listingAttendee.listing_id WHERE listingAttendee.quantity = ?1",
    );
  });

  test("keeps every row when it names no column", () => {
    expect(
      from(tables.holidays)
        .where({})
        .values((holiday) => holiday.id).sql,
    ).toBe("SELECT holiday.id FROM holidays AS holiday");
  });

  test("marks a read that no row can pass", () => {
    expect(from(tables.listings).where({ id: [] }).matchesNothing()).toBe(true);
  });

  test("compares a column with another expression", () => {
    const line = tableNode(tables.listing_attendees, "line");
    expect(
      from(tables.listings)
        .where({ id: line.listing_id })
        .values((listing) => listing.id).sql,
    ).toBe(
      "SELECT listing.id FROM listings AS listing WHERE listing.id = line.listing_id",
    );
  });

  test("refuses a name that is not a column of the table", () => {
    const match: { id?: number } = Object.fromEntries([["nothing", 1]]);
    expect(() =>
      from(tables.listings)
        .where(match)
        .values((listing) => listing.id),
    ).toThrow("A match names nothing, which is not a column of its table.");
  });
});

describe("pick", () => {
  test("selects the named columns under their own names", () => {
    expect(
      from(tables.listings).select((listing) =>
        pick(listing, "id", "max_attendees"),
      ).sql,
    ).toBe(
      "SELECT listing.id AS id, listing.max_attendees AS max_attendees FROM listings AS listing",
    );
  });
});

describe("a read of one answer", () => {
  const listingSeven = from(tables.listings).where({ id: 7 });

  test("counts the rows that the read keeps", () => {
    expect(placed(listingSeven.count())).toEqual({
      args: [7],
      sql: "SELECT COUNT(*) AS count FROM listings AS listing WHERE listing.id = ?",
    });
  });

  test("probes for one row at most, and reads no column", () => {
    expect(placed(listingSeven.probe())).toEqual({
      args: [7, 1],
      sql: "SELECT 1 FROM listings AS listing WHERE listing.id = ? LIMIT ?",
    });
  });

  test("marks a probe that no row can pass", () => {
    expect(
      matchesNothing(from(tables.listings).where({ id: [] }).probe()),
    ).toBe(true);
  });
});
