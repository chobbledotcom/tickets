import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { queryAll } from "#db/client.ts";
import {
  dayCountPriceStatements,
  getGroupDayPrices,
  getGroupDayPricesByGroupIds,
  getListingDayPrices,
  groupDayPriceStatements,
  groupFlatPriceStatements,
  removeGroupPricesStatement,
} from "#db/listing-prices.ts";
import { deleteListing } from "#db/listings/delete.ts";
import { listingsTable } from "#db/listings/records.ts";
import { type SqlStatement, sql } from "#db/sql.ts";
import { expectIncludesAll } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { updateTestListing } from "#test-utils/db-helpers/listings.ts";
import { placed } from "#test-utils/sql-text.ts";
import {
  createDayPricedListing,
  priceRows,
} from "./listing-prices/fixtures.ts";

/** One managed price row as a writer emits it: listing, type, key, price. */
type PriceRow = readonly [number, string, string, number];

/** The insert every full-replace dimension writes: one multi-row VALUES. */
const priceInsertSql = (rowCount: number) =>
  `INSERT INTO listing_prices (listing_id, price_type, price_id, unit_price) VALUES ${Array.from(
    { length: rowCount },
    () => "(?, ?, ?, ?)",
  ).join(", ")}`;

/**
 * Asserts a full-replace price writer: the scoped delete of `deleteArgs`, then
 * ONE multi-row insert holding every `row` — never one insert per row, so a
 * replace stays two statements and its interactive-transaction round-trip stays
 * bounded. No `rows` means the write has nothing to insert.
 */
const expectScopedReplace = (
  stmts: readonly SqlStatement[],
  deleteSql: string,
  deleteArgs: readonly unknown[],
  rows: readonly PriceRow[] = [],
): void => {
  const expected = [{ args: [...deleteArgs], sql: deleteSql }];
  if (rows.length > 0) {
    expected.push({ args: rows.flat(), sql: priceInsertSql(rows.length) });
  }
  expect(stmts.map((stmt) => placed(stmt))).toEqual(expected);
};

/** The delete every day-count replace scopes on the listing row. */
const dayCountDelete =
  "DELETE FROM listing_prices WHERE listing_id = ? AND price_type = ?";

/** The delete every group day-price replace scopes on the group's LIKE prefix. */
const groupDayDelete =
  "DELETE FROM listing_prices WHERE price_type = ? AND price_id LIKE ?";

/** Assert the group day-price replace for `groupId` writes exactly `rows`. */
const expectGroupDayReplace = (
  groupId: number,
  members: Parameters<typeof groupDayPriceStatements>[1],
  rows: readonly PriceRow[],
): void => {
  expectScopedReplace(
    groupDayPriceStatements(groupId, members),
    groupDayDelete,
    ["group_day", `${groupId}/%`],
    rows,
  );
};

describe("dayCountPriceStatements", () => {
  const cases: readonly [
    name: string,
    listingId: number,
    dayPrices: Record<number, number> | undefined,
    rows: readonly PriceRow[],
  ][] = [
    [
      "emits a day_count-scoped delete then ONE multi-row insert for all day counts",
      5,
      { 1: 750, 2: 1200 },
      [
        [5, "day_count", "1", 750],
        [5, "day_count", "2", 1200],
      ],
    ],
    ["emits only the scoped delete when there are no day prices", 9, {}, []],
    [
      "treats undefined day prices as an empty map (delete only)",
      9,
      undefined,
      [],
    ],
    // Day 0 and a negative price are dropped by parseDayPrices; the rest kept.
    [
      "normalises entries like every other day-price write",
      9,
      { 0: 100, 2: -5, 4: 800 },
      [[9, "day_count", "4", 800]],
    ],
  ];

  for (const [name, listingId, dayPrices, rows] of cases) {
    test(name, () => {
      expectScopedReplace(
        dayCountPriceStatements(listingId, dayPrices),
        dayCountDelete,
        [listingId, "day_count"],
        rows,
      );
    });
  }
});

describe("groupDayPriceStatements", () => {
  const cases: readonly [
    name: string,
    groupId: number,
    members: Parameters<typeof groupDayPriceStatements>[1],
    rows: readonly PriceRow[],
  ][] = [
    [
      "emits a group-scoped LIKE delete, then ONE multi-row insert of every day price",
      12,
      [
        { dayPrices: { 2: 1500, 3: 2000 }, listingId: 5 },
        // A member with no per-day overrides contributes no rows.
        { listingId: 6 },
      ],
      [
        [5, "group_day", "12/2", 1500],
        [5, "group_day", "12/3", 2000],
      ],
    ],
    [
      "normalises day-price entries like every other day-price write",
      3,
      // Day 0 and a negative price are dropped by parseDayPrices; the valid
      // entry is kept.
      [{ dayPrices: { 0: 100, 2: -5, 4: 800 }, listingId: 9 }],
      [[9, "group_day", "3/4", 800]],
    ],
  ];

  for (const [name, groupId, members, rows] of cases) {
    test(name, () => {
      expectGroupDayReplace(groupId, members, rows);
    });
  }
});

describe("groupFlatPriceStatements", () => {
  test("emits a group-scoped delete, then ONE multi-row insert for all overrides", () => {
    // A positive override and an explicit free (0) both get a row.
    expectScopedReplace(
      groupFlatPriceStatements(12, [
        { listingId: 5, price: 1500 },
        { listingId: 6, price: 0 },
      ]),
      // The delete scopes to this group's flat rows by exact price_id (not LIKE).
      "DELETE FROM listing_prices WHERE price_type = ? AND price_id = ?",
      ["group", "12"],
      [
        [5, "group", "12", 1500],
        [6, "group", "12", 0],
      ],
    );
  });

  test("skips members with a null or absent price (no override → no row)", () => {
    // Only the delete plus the one real override survive.
    expectScopedReplace(
      groupFlatPriceStatements(3, [
        { listingId: 9, price: null },
        { listingId: 10 },
        { listingId: 11, price: 250 },
      ]),
      "DELETE FROM listing_prices WHERE price_type = ? AND price_id = ?",
      ["group", "3"],
      [[11, "group", "3", 250]],
    );
  });

  test("emits only the group-scoped delete when there are no members", () => {
    expectScopedReplace(
      groupFlatPriceStatements(7, []),
      "DELETE FROM listing_prices WHERE price_type = ? AND price_id = ?",
      ["group", "7"],
    );
  });
});

describe("removeGroupPricesStatement", () => {
  test("returns null when no groups are being left", () => {
    expect(removeGroupPricesStatement([5], [])).toBeNull();
  });

  test("returns null when no listings are named", () => {
    expect(removeGroupPricesStatement([], [1])).toBeNull();
  });

  test("drops the listing's flat + per-day rows for each left group in one statement", () => {
    const stmt = removeGroupPricesStatement([5], [1, 12])!;
    // Flat rows matched by exact group id; per-day rows by the "<id>/%" glob (the
    // trailing "/" keeps group 1's glob from matching group 12's price_ids).
    expect(placed(stmt).args).toEqual([5, "1", "12", "1/%", "12/%"]);
    expectIncludesAll(placed(stmt).sql, [
      "price_type = 'group' AND price_id IN (?, ?)",
      "price_id LIKE ? OR price_id LIKE ?",
    ]);
  });

  test("drops several listings' rows for one left group in one statement", () => {
    const stmt = removeGroupPricesStatement([5, 6, 7], [1])!;
    expect(placed(stmt).args).toEqual([5, 6, 7, "1", "1/%"]);
    assertStringIncludes(placed(stmt).sql, "listing_id IN (?, ?, ?)");
  });
});

describeWithEnv("listing_prices persistence", { db: true }, () => {
  test("admin create writes day_count rows and projects them back on read", async () => {
    // day_prices is no longer a column — the write path persists day_count rows,
    // and the entity's day_prices is projected back from them on read.
    const listing = await createDayPricedListing({ 1: 400, 3: 1000 });
    expect(await priceRows(listing.id)).toEqual([
      { price_id: "", price_type: "base", unit_price: 0 },
      { price_id: "1", price_type: "day_count", unit_price: 400 },
      { price_id: "3", price_type: "day_count", unit_price: 1000 },
    ]);
    // The returned entity (form re-fetch via the projection) carries them.
    expect(listing.day_prices).toEqual({ 1: 400, 3: 1000 });
    // And getListingDayPrices reads the same rows directly.
    expect(await getListingDayPrices(listing.id)).toEqual({ 1: 400, 3: 1000 });
  });

  test("editing day prices replaces the day_count rows (a dropped count is removed)", async () => {
    const listing = await createDayPricedListing({ 1: 500, 2: 800 });
    expect(await getListingDayPrices(listing.id)).toEqual({ 1: 500, 2: 800 });
    // Remove the 2-day price and raise the 1-day price.
    const edited = await updateTestListing(listing.id, {
      customisableDays: true,
      dayPrices: { 1: 550 },
      durationDays: 5,
    });
    expect(await getListingDayPrices(listing.id)).toEqual({ 1: 550 });
    expect(edited.day_prices).toEqual({ 1: 550 });
  });

  test("a day-count row whose price is not a number fails the read loudly", async () => {
    // Before the parse, a drifted row let parseDayPrices quietly drop the day
    // from the projection, so an editor read a price that was not the stored
    // one — or none at all.
    const listing = await createDayPricedListing({ 2: 640 });
    await queryAll(
      sql`UPDATE listing_prices SET unit_price = 'free' WHERE price_type = 'day_count' AND listing_id = ${listing.id}`,
    );
    await expect(getListingDayPrices(listing.id)).rejects.toThrow(
      "Invalid type",
    );
  });

  test("deleting a listing removes its price rows", async () => {
    const listing = await createDayPricedListing({ 1: 640 });
    expect((await priceRows(listing.id)).length).toBe(2);
    await deleteListing(listing.id);
    expect(await priceRows(listing.id)).toEqual([]);
  });

  test("updating a missing listing writes no price rows", async () => {
    // The table wrapper only re-syncs when the update returns a row; a missing
    // id yields null and must not touch listing_prices.
    expect(await listingsTable.update(987655, { unitPrice: 500 })).toBeNull();
    expect(await priceRows(987655)).toEqual([]);
  });

  test("updating day prices directly via the wrapper replaces the day_count rows", async () => {
    const listing = await createDayPricedListing({ 1: 400 });
    const updated = await listingsTable.update(listing.id, {
      customisableDays: true,
      dayPrices: { 2: 900, 3: 1300 },
      durationDays: 5,
    });
    expect(updated!.day_prices).toEqual({ 2: 900, 3: 1300 });
    expect(await getListingDayPrices(listing.id)).toEqual({ 2: 900, 3: 1300 });
  });

  test("a partial update that omits day prices leaves the day_count rows intact", async () => {
    const listing = await createDayPricedListing({ 1: 400, 2: 700 });
    // A direct partial update (no dayPrices) must not clobber the day_count rows.
    const row = await listingsTable.update(listing.id, { active: false });
    expect(row!.day_prices).toEqual({ 1: 400, 2: 700 });
    expect(await getListingDayPrices(listing.id)).toEqual({ 1: 400, 2: 700 });
  });

  /** Insert one raw `group_day` row with a crafted price_id, so the readers'
   * group scoping is exercised without needing real groups at those ids. */
  const seedGroupDayRow = (
    listingId: number,
    priceId: string,
    price: number,
  ): Promise<unknown> =>
    queryAll(
      sql`INSERT INTO listing_prices (listing_id, price_type, price_id, unit_price) VALUES (${listingId}, 'group_day', ${priceId}, ${price})`,
    );

  /** Insert a bare membership row — the readers only surface a group_day row
   * whose listing is a CURRENT member of that group. */
  const seedMembership = (groupId: number, listingId: number) =>
    queryAll(
      sql`INSERT INTO group_listings (group_id, listing_id) VALUES (${groupId}, ${listingId})`,
    );

  test("getGroupDayPrices folds only its own group's current members — a prefix-sharing id never matches and a removed member's stale rows are invisible", async () => {
    await seedMembership(1, 5);
    await seedGroupDayRow(5, "1/2", 700);
    await seedGroupDayRow(5, "1/3", 900);
    // Group 12 shares group 1's prefix; the trailing "/" keeps LIKE exact.
    await seedMembership(12, 6);
    await seedGroupDayRow(6, "12/2", 100);
    // Listing 16's rows survive its removal from the group (no membership row);
    // the reader must not resurrect them.
    await seedGroupDayRow(16, "1/2", 555);
    const map = await getGroupDayPrices(1);
    expect(map.get(5)?.get(2)).toBe(700);
    expect(map.get(5)?.get(3)).toBe(900);
    expect(map.has(6)).toBe(false);
    expect(map.has(16)).toBe(false);
  });

  test("getGroupDayPricesByGroupIds splits rows by group and skips unrequested groups and stale rows", async () => {
    await seedMembership(21, 7);
    await seedMembership(21, 17);
    await seedMembership(22, 8);
    await seedMembership(23, 9);
    await seedGroupDayRow(7, "21/2", 400);
    // A second row in the same group appends to that group's fold.
    await seedGroupDayRow(17, "21/3", 350);
    await seedGroupDayRow(8, "22/1", 250);
    await seedGroupDayRow(9, "23/2", 999);
    // A removed member's leftover row (no membership) never surfaces.
    await seedGroupDayRow(18, "22/2", 111);
    const byGroup = await getGroupDayPricesByGroupIds([21, 22]);
    expect(byGroup.get(21)?.get(7)?.get(2)).toBe(400);
    expect(byGroup.get(21)?.get(17)?.get(3)).toBe(350);
    expect(byGroup.get(22)?.get(8)?.get(1)).toBe(250);
    expect(byGroup.get(22)?.has(18)).toBe(false);
    // Group 23's rows exist but weren't requested; group 24 has none.
    expect(byGroup.has(23)).toBe(false);
    expect(byGroup.has(24)).toBe(false);
    // An empty request reads nothing.
    expect((await getGroupDayPricesByGroupIds([])).size).toBe(0);
  });
});
