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
  removeListingGroupPricesStatement,
} from "#db/listing-prices.ts";
import { deleteListing } from "#db/listings/delete.ts";
import { listingsTable } from "#db/listings/records.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { updateTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  createDayPricedListing,
  priceRows,
} from "./listing-prices/fixtures.ts";

describe("dayCountPriceStatements", () => {
  test("emits a day_count-scoped delete then ONE multi-row insert for all day counts", () => {
    const stmts = dayCountPriceStatements(5, { 1: 750, 2: 1200 });
    // Exactly two statements regardless of how many day counts — the insert is a
    // single multi-row VALUES so the interactive-transaction round-trip stays
    // bounded (see the round-trip guard).
    expect(stmts.length).toBe(2);
    expect(stmts[0]!.sql).toBe(
      "DELETE FROM listing_prices WHERE listing_id = ? AND price_type = ?",
    );
    expect(stmts[0]!.args).toEqual([5, "day_count"]);
    expect(stmts[1]!.sql).toBe(
      "INSERT INTO listing_prices (listing_id, price_type, price_id, unit_price) VALUES (?, ?, ?, ?), (?, ?, ?, ?)",
    );
    expect(stmts[1]!.args).toEqual([
      5,
      "day_count",
      "1",
      750,
      5,
      "day_count",
      "2",
      1200,
    ]);
  });

  test("emits only the scoped delete when there are no day prices", () => {
    expect(dayCountPriceStatements(9, {}).map((s) => s.args)).toEqual([
      [9, "day_count"],
    ]);
  });

  test("treats undefined day prices as an empty map (delete only)", () => {
    expect(dayCountPriceStatements(9, undefined).map((s) => s.args)).toEqual([
      [9, "day_count"],
    ]);
  });

  test("normalises entries like every other day-price write", () => {
    // Day 0 and a negative price are dropped by parseDayPrices; the rest kept.
    const stmts = dayCountPriceStatements(9, { 0: 100, 2: -5, 4: 800 });
    expect(stmts.length).toBe(2);
    expect(stmts[1]!.args).toEqual([9, "day_count", "4", 800]);
  });
});

describe("groupDayPriceStatements", () => {
  test("emits a group-scoped LIKE delete, then ONE multi-row insert of every day price", () => {
    const stmts = groupDayPriceStatements(12, [
      { dayPrices: { 2: 1500, 3: 2000 }, listingId: 5 },
      // A member with no per-day overrides contributes no rows.
      { listingId: 6 },
    ]);
    expect(stmts.length).toBe(2);
    expect(stmts[0]!.sql).toContain("price_id LIKE ?");
    expect(stmts[0]!.args).toEqual(["group_day", "12/%"]);
    // A single multi-row insert (bounded round-trips), one row per member day.
    expect(stmts[1]!.args).toEqual([
      5,
      "group_day",
      "12/2",
      1500,
      5,
      "group_day",
      "12/3",
      2000,
    ]);
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

describe("groupFlatPriceStatements", () => {
  test("emits a group-scoped delete, then ONE multi-row insert for all overrides", () => {
    const stmts = groupFlatPriceStatements(12, [
      // A positive override and an explicit free (0) both get a row.
      { listingId: 5, price: 1500 },
      { listingId: 6, price: 0 },
    ]);
    // Two statements regardless of member count (the insert is multi-row), so the
    // interactive-transaction round-trips stay bounded.
    expect(stmts.length).toBe(2);
    // The delete scopes to this group's flat rows by exact price_id (not LIKE).
    expect(stmts[0]!.sql).toBe(
      "DELETE FROM listing_prices WHERE price_type = ? AND price_id = ?",
    );
    expect(stmts[0]!.args).toEqual(["group", "12"]);
    expect(stmts[1]!.sql).toBe(
      "INSERT INTO listing_prices (listing_id, price_type, price_id, unit_price) VALUES (?, ?, ?, ?), (?, ?, ?, ?)",
    );
    expect(stmts[1]!.args).toEqual([
      5,
      "group",
      "12",
      1500,
      6,
      "group",
      "12",
      0,
    ]);
  });

  test("skips members with a null or absent price (no override → no row)", () => {
    const stmts = groupFlatPriceStatements(3, [
      { listingId: 9, price: null },
      { listingId: 10 },
      { listingId: 11, price: 250 },
    ]);
    // Only the delete plus the one real override survive.
    expect(stmts.map((s) => s.args)).toEqual([
      ["group", "3"],
      [11, "group", "3", 250],
    ]);
  });

  test("emits only the group-scoped delete when there are no members", () => {
    expect(groupFlatPriceStatements(7, []).map((s) => s.args)).toEqual([
      ["group", "7"],
    ]);
  });
});

describe("removeListingGroupPricesStatement", () => {
  test("returns null when no groups are being left", () => {
    expect(removeListingGroupPricesStatement(5, [])).toBeNull();
  });

  test("drops the listing's flat + per-day rows for each left group in one statement", () => {
    const stmt = removeListingGroupPricesStatement(5, [1, 12])!;
    // Flat rows matched by exact group id; per-day rows by the "<id>/%" glob (the
    // trailing "/" keeps group 1's glob from matching group 12's price_ids).
    expect(stmt.args).toEqual([5, "1", "12", "1/%", "12/%"]);
    expect(stmt.sql).toContain("price_type = 'group' AND price_id IN (?, ?)");
    expect(stmt.sql).toContain("price_id LIKE ? OR price_id LIKE ?");
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
      "UPDATE listing_prices SET unit_price = 'free' " +
        "WHERE price_type = 'day_count' AND listing_id = ?",
      [listing.id],
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
      "INSERT INTO listing_prices (listing_id, price_type, price_id, unit_price) VALUES (?, 'group_day', ?, ?)",
      [listingId, priceId, price],
    );

  /** Insert a bare membership row — the readers only surface a group_day row
   * whose listing is a CURRENT member of that group. */
  const seedMembership = (groupId: number, listingId: number) =>
    queryAll(
      "INSERT INTO group_listings (group_id, listing_id) VALUES (?, ?)",
      [groupId, listingId],
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
