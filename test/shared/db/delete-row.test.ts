import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { deleteById, deleteFrom } from "#db/delete-row.ts";
import { sql } from "#db/sql.ts";
import { placed } from "#test-utils/sql-text.ts";

describe("deleteFrom", () => {
  test("writes its where record as equality checks", () => {
    expect(
      placed(
        deleteFrom("listing_prices", {
          listing_id: 4,
          price_type: "group",
        }),
      ),
    ).toEqual({
      args: [4, "group"],
      sql: "DELETE FROM listing_prices WHERE listing_id = ? AND price_type = ?",
    });
  });

  test("takes a statement as a where value", () => {
    expect(
      placed(
        deleteFrom("attendee_answers", {
          attendee_id: sql`(SELECT id FROM attendees LIMIT 1)`,
        }),
      ),
    ).toEqual({
      args: [],
      sql: "DELETE FROM attendee_answers WHERE attendee_id = (SELECT id FROM attendees LIMIT 1)",
    });
  });
});

describe("deleteById", () => {
  test("matches the id column", () => {
    expect(placed(deleteById("transfers", 12))).toEqual({
      args: [12],
      sql: "DELETE FROM transfers WHERE id = ?",
    });
  });
});
