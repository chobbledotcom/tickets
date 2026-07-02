import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { queryAll } from "#shared/db/client.ts";
import {
  backfillListingPrices,
  getGroupDayPrices,
  getGroupDayPricesByGroupIds,
  groupDayPriceStatements,
  listingPriceStatements,
  sourceRowStatements,
  syncListingPrices,
  syncListingPricesForIds,
} from "#shared/db/listing-prices.ts";
import { deleteListing, listingsTable } from "#shared/db/listings.ts";
import {
  createTestListing,
  describeWithEnv,
  updateTestListing,
} from "#test-utils";

describe("listingPriceStatements", () => {
  test("emits a scoped delete, a base insert, then one insert per day count", () => {
    const stmts = listingPriceStatements(5, 750, { 1: 750, 2: 1200 });
    expect(stmts.map((s) => s.args)).toEqual([
      [5, "base", "day_count"],
      [5, "base", "", 750],
      [5, "day_count", "1", 750],
      [5, "day_count", "2", 1200],
    ]);
    // The first statement scopes its delete to the two managed dimensions; the
    // rest are inserts, so reserved (group/…) rows are never disturbed.
    const sqls = stmts.map((s) => s.sql);
    expect(sqls[0]).toContain(
      "DELETE FROM listing_prices WHERE listing_id = ? AND price_type IN (?, ?)",
    );
    expect(
      sqls
        .slice(1)
        .every((sql) => sql.startsWith("INSERT INTO listing_prices")),
    ).toBe(true);
  });

  test("emits only the delete + base row when there are no day prices", () => {
    expect(listingPriceStatements(9, 0, {}).map((s) => s.args)).toEqual([
      [9, "base", "day_count"],
      [9, "base", "", 0],
    ]);
  });
});

describe("sourceRowStatements", () => {
  test("projects a raw listings row, reading NULL price + day prices", () => {
    const stmts = sourceRowStatements({
      day_prices: '{"2":900}',
      id: 3,
      unit_price: 250,
    });
    expect(stmts.map((s) => s.args)).toEqual([
      [3, "base", "day_count"],
      [3, "base", "", 250],
      [3, "day_count", "2", 900],
    ]);
  });

  test("reads a NULL price as 0 and a blank day_prices as no day rows", () => {
    expect(
      sourceRowStatements({ day_prices: "", id: 4, unit_price: null }).map(
        (s) => s.args,
      ),
    ).toEqual([
      [4, "base", "day_count"],
      [4, "base", "", 0],
    ]);
  });
});

describe("groupDayPriceStatements", () => {
  test("emits a group-scoped LIKE delete, then one insert per member day price", () => {
    const stmts = groupDayPriceStatements(12, [
      { dayPrices: { 2: 1500 }, listingId: 5 },
      // A member with no per-day overrides contributes no inserts.
      { listingId: 6 },
    ]);
    expect(stmts.map((s) => s.args)).toEqual([
      ["group_day", "12/%"],
      [5, "group_day", "12/2", 1500],
    ]);
    expect(stmts[0]!.sql).toContain("price_id LIKE ?");
  });

  test("normalises day-price entries like every other day-price write", () => {
    // Day 0 and a negative price are dropped by parseDayPrices; the valid
    // entry is kept.
    const stmts = groupDayPriceStatements(3, [
      { dayPrices: { 0: 100, 2: -5, 4: 800 }, listingId: 9 },
    ]);
    expect(stmts.map((s) => s.args)).toEqual([
      ["group_day", "3/%"],
      [9, "group_day", "3/4", 800],
    ]);
  });
});

/** The managed rows for a listing, ordered for stable assertions. */
const priceRows = (
  listingId: number,
): Promise<{ price_type: string; price_id: string; unit_price: number }[]> =>
  queryAll(
    `SELECT price_type, price_id, unit_price FROM listing_prices
      WHERE listing_id = ? ORDER BY price_type, price_id`,
    [listingId],
  );

/** Write a listing's `day_prices` column directly (bypassing the day-price form
 * plumbing), so tests can exercise the day_count branch on demand. */
const seedDayPrices = (
  listingId: number,
  dayPrices: Record<number, number>,
): Promise<unknown> =>
  queryAll("UPDATE listings SET day_prices = ? WHERE id = ?", [
    JSON.stringify(dayPrices),
    listingId,
  ]);

/** Seed a listing's day prices, re-sync, and return the resulting price_ids. */
const resyncedPriceIds = async (
  listingId: number,
  dayPrices: Record<number, number>,
): Promise<string[]> => {
  await seedDayPrices(listingId, dayPrices);
  await syncListingPrices(listingId);
  return (await priceRows(listingId)).map((r) => r.price_id);
};

describeWithEnv("listing_prices persistence", { db: true }, () => {
  test("admin create and edit keep the base price row in sync", async () => {
    // The real admin form paths go through listingsTable.insert/update, which
    // re-sync listing_prices — so a listing's base row tracks its price without
    // anyone touching listing_prices directly.
    const listing = await createTestListing({ unitPrice: 750 });
    expect(await priceRows(listing.id)).toEqual([
      { price_id: "", price_type: "base", unit_price: 750 },
    ]);
    await updateTestListing(listing.id, { unitPrice: 900 });
    expect(await priceRows(listing.id)).toEqual([
      { price_id: "", price_type: "base", unit_price: 900 },
    ]);
  });

  test("backfill populates base + day-count rows from the listings columns", async () => {
    const standard = await createTestListing({ unitPrice: 750 });
    const dated = await createTestListing({ unitPrice: 400 });
    // Seed a day-prices map directly on the row so the backfill's day_count
    // branch is exercised independently of the admin day-price form plumbing.
    await seedDayPrices(dated.id, { 1: 400, 3: 1000 });
    // Clear the dual-write's rows, then rebuild everything from listings.
    await queryAll("DELETE FROM listing_prices");
    await backfillListingPrices();
    expect(await priceRows(standard.id)).toEqual([
      { price_id: "", price_type: "base", unit_price: 750 },
    ]);
    expect(await priceRows(dated.id)).toEqual([
      { price_id: "", price_type: "base", unit_price: 400 },
      { price_id: "1", price_type: "day_count", unit_price: 400 },
      { price_id: "3", price_type: "day_count", unit_price: 1000 },
    ]);
  });

  test("re-syncing drops a day count that is no longer offered", async () => {
    const listing = await createTestListing({ unitPrice: 500 });
    expect(await resyncedPriceIds(listing.id, { 1: 500, 2: 800 })).toEqual([
      "",
      "1",
      "2",
    ]);
    // Remove the 2-day price and re-sync: only the managed rows change.
    expect(await resyncedPriceIds(listing.id, { 1: 500 })).toEqual(["", "1"]);
  });

  test("deleting a listing removes its price rows", async () => {
    const listing = await createTestListing({ unitPrice: 640 });
    expect((await priceRows(listing.id)).length).toBe(1);
    await deleteListing(listing.id);
    expect(await priceRows(listing.id)).toEqual([]);
  });

  test("syncListingPricesForIds rebuilds rows for the given listings only", async () => {
    const a = await createTestListing({ unitPrice: 300 });
    const b = await createTestListing({ unitPrice: 700 });
    await seedDayPrices(b.id, { 2: 1300 });
    await queryAll("DELETE FROM listing_prices");
    await syncListingPricesForIds([a.id, b.id]);
    expect(await priceRows(a.id)).toEqual([
      { price_id: "", price_type: "base", unit_price: 300 },
    ]);
    expect(await priceRows(b.id)).toEqual([
      { price_id: "", price_type: "base", unit_price: 700 },
      { price_id: "2", price_type: "day_count", unit_price: 1300 },
    ]);
  });

  test("syncListingPricesForIds is a no-op for an empty id list", async () => {
    await syncListingPricesForIds([]);
    expect(await priceRows(987656)).toEqual([]);
  });

  test("syncListingPrices is a no-op for a listing that does not exist", async () => {
    await syncListingPrices(987654);
    expect(await priceRows(987654)).toEqual([]);
  });

  test("updating a missing listing writes no price rows", async () => {
    // The table wrapper only re-syncs when the update returns a row; a missing
    // id yields null and must not touch listing_prices.
    expect(await listingsTable.update(987655, { unitPrice: 500 })).toBeNull();
    expect(await priceRows(987655)).toEqual([]);
  });

  /** Insert one raw `group_day` row with a crafted price_id, so the readers'
   * group scoping is exercised without needing real groups at those ids. */
  const seedGroupDayRow = (
    listingId: number,
    priceId: string,
    price: number,
  ): Promise<unknown> =>
    queryAll(
      "INSERT INTO listing_prices (listing_id, price_type, price_id, unit_price) VALUES (?, 'group_day', ?, ?)",
      [listingId, priceId, price],
    );

  test("getGroupDayPrices folds only its own group's rows — a prefix-sharing id never matches", async () => {
    await seedGroupDayRow(5, "1/2", 700);
    await seedGroupDayRow(5, "1/3", 900);
    // Group 12 shares group 1's prefix; the trailing "/" keeps LIKE exact.
    await seedGroupDayRow(6, "12/2", 100);
    const map = await getGroupDayPrices(1);
    expect(map.get(5)?.get(2)).toBe(700);
    expect(map.get(5)?.get(3)).toBe(900);
    expect(map.has(6)).toBe(false);
  });

  test("getGroupDayPricesByGroupIds splits rows by group and skips unrequested groups", async () => {
    await seedGroupDayRow(7, "21/2", 400);
    // A second row in the same group appends to that group's fold.
    await seedGroupDayRow(17, "21/3", 350);
    await seedGroupDayRow(8, "22/1", 250);
    await seedGroupDayRow(9, "23/2", 999);
    const byGroup = await getGroupDayPricesByGroupIds([21, 22]);
    expect(byGroup.get(21)?.get(7)?.get(2)).toBe(400);
    expect(byGroup.get(21)?.get(17)?.get(3)).toBe(350);
    expect(byGroup.get(22)?.get(8)?.get(1)).toBe(250);
    // Group 23's rows exist but weren't requested; group 24 has none.
    expect(byGroup.has(23)).toBe(false);
    expect(byGroup.has(24)).toBe(false);
    // An empty request reads nothing.
    expect((await getGroupDayPricesByGroupIds([])).size).toBe(0);
  });
});
