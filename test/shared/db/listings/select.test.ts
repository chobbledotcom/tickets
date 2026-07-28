/**
 * Unit tests for the listing SELECT builder (`src/shared/db/listings/select.ts`).
 *
 * `listingStatement` is a pure string builder — no DB — so it is tested
 * directly here. This pins the filter and order SQL that every listing-record
 * read now shares, so a mutant that drops a clause, loses a join, or mis-orders
 * the bound args is caught.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { listingStatement } from "#shared/db/listings/select.ts";

const LISTINGS_FROM = "FROM listings AS listing";
const GROUPS_FROM =
  "FROM group_listings AS groupListing JOIN listings AS listing ON listing.id = groupListing.listing_id";

/**
 * The statement from its own FROM clause onwards. The projected values are
 * built from subqueries carrying their own FROM, WHERE and ORDER BY, so the
 * assertions below would match inside those without this; each of the two real
 * FROM clauses appears exactly once, so finding one is unambiguous.
 */
const tail = (sql: string): string =>
  sql.slice(Math.max(sql.indexOf(LISTINGS_FROM), sql.indexOf(GROUPS_FROM)));

describe("listingStatement", () => {
  test("an empty filter reads every listing, unordered", () => {
    const { sql, args } = listingStatement({ where: {} });
    expect(tail(sql)).toBe(LISTINGS_FROM);
    expect(args).toEqual([]);
  });

  test("always projects the money, day-price, image and count values", () => {
    const { sql } = listingStatement({ where: {} });
    for (const projection of [
      "AS income",
      "AS cost",
      "AS day_prices",
      "AS image_url",
      "listing.booked_quantity AS attendee_count",
    ]) {
      expect(sql).toContain(projection);
    }
  });

  test("filters by id with one placeholder per id", () => {
    const { sql, args } = listingStatement({ where: { ids: [7, 9] } });
    expect(tail(sql)).toBe(`${LISTINGS_FROM} WHERE listing.id IN (?, ?)`);
    expect(args).toEqual([7, 9]);
  });

  test("an empty id list matches nothing and stays valid SQL", () => {
    const { sql, args } = listingStatement({ where: { ids: [] } });
    expect(tail(sql)).toBe(`${LISTINGS_FROM} WHERE listing.id IN (NULL)`);
    expect(args).toEqual([]);
  });

  test("filters by slug index", () => {
    const { sql, args } = listingStatement({ where: { slugIndexes: ["abc"] } });
    expect(tail(sql)).toBe(`${LISTINGS_FROM} WHERE listing.slug_index IN (?)`);
    expect(args).toEqual(["abc"]);
  });

  test("an empty slug index list matches nothing", () => {
    const { sql, args } = listingStatement({ where: { slugIndexes: [] } });
    expect(tail(sql)).toBe(
      `${LISTINGS_FROM} WHERE listing.slug_index IN (NULL)`,
    );
    expect(args).toEqual([]);
  });

  test("reading by group joins the membership rows and names the groups", () => {
    const { sql, args } = listingStatement({ where: { inGroups: [3, 4] } });
    expect(sql).toContain(
      "json_group_array(groupListing.group_id) AS group_ids",
    );
    expect(tail(sql)).toBe(
      `${GROUPS_FROM} WHERE groupListing.group_id IN (?, ?) GROUP BY listing.id`,
    );
    expect(args).toEqual([3, 4]);
  });

  test("a read that is not by group has no join, group column, or grouping", () => {
    const { sql } = listingStatement({ where: { ids: [1] } });
    expect(sql).not.toContain("group_listings");
    expect(sql).not.toContain("group_ids");
    expect(tail(sql)).not.toContain("GROUP BY");
  });

  test("keeps only active listings when asked", () => {
    const { sql, args } = listingStatement({ where: { activeOnly: true } });
    expect(tail(sql)).toBe(`${LISTINGS_FROM} WHERE listing.active = 1`);
    expect(args).toEqual([]);
  });

  test("does not constrain on activity when not asked", () => {
    for (const where of [{}, { activeOnly: false }]) {
      expect(tail(listingStatement({ where }).sql)).not.toContain(
        "listing.active",
      );
    }
  });

  test("joins several filters with AND, args in clause order", () => {
    const { sql, args } = listingStatement({
      where: { activeOnly: true, ids: [5], inGroups: [8] },
    });
    expect(tail(sql)).toBe(
      `${GROUPS_FROM} WHERE listing.id IN (?)` +
        " AND groupListing.group_id IN (?) AND listing.active = 1" +
        " GROUP BY listing.id",
    );
    expect(args).toEqual([5, 8]);
  });

  test("orders newest first when asked", () => {
    const { sql } = listingStatement({ order: "created_desc", where: {} });
    expect(tail(sql)).toBe(
      `${LISTINGS_FROM} ORDER BY listing.created DESC, listing.id DESC`,
    );
  });

  test("puts the order after the grouping for a by-group read", () => {
    const { sql } = listingStatement({
      order: "created_desc",
      where: { inGroups: [1] },
    });
    expect(tail(sql)).toBe(
      `${GROUPS_FROM} WHERE groupListing.group_id IN (?)` +
        " GROUP BY listing.id ORDER BY listing.created DESC, listing.id DESC",
    );
  });
});
