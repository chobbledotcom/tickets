import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { rawSql, update } from "#shared/db/client.ts";

/**
 * The update statement builder: column→value records become the SET and WHERE
 * clauses. The multi-clause shape is the one worth pinning exactly — a single
 * column never uses the joiners, so only this test proves columns are joined
 * with ", " and conditions with " AND ".
 */
describe("db > client update builder", () => {
  test("joins several SET columns with commas and WHERE keys with AND", () => {
    expect(
      update(
        "listing_attendees",
        {
          attachment_downloads: rawSql("attachment_downloads + 1"),
          price_paid: 500,
        },
        { attendee_id: 1, listing_id: 2 },
      ),
    ).toEqual({
      args: [500, 1, 2],
      sql: "UPDATE listing_attendees SET attachment_downloads = attachment_downloads + 1, price_paid = ? WHERE attendee_id = ? AND listing_id = ?",
    });
  });
});
