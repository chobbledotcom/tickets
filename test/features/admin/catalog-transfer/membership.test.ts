import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { PRICE_TYPE_GROUP, PRICE_TYPE_GROUP_DAY } from "#db/listing-prices.ts";
import {
  type ImportedMembership,
  membershipStatements,
} from "#routes/admin/catalog-transfer/membership.ts";

const membership = (
  overrides: Partial<ImportedMembership> = {},
): ImportedMembership => ({
  dayPrices: {},
  groupId: 4,
  listingId: 9,
  packagePrice: null,
  quantity: 1,
  ...overrides,
});

/** The statement writing `table`, or undefined when nothing writes to it. */
const statementFor = (
  statements: ReturnType<typeof membershipStatements>,
  table: string,
) => statements.find(({ sql }) => sql.startsWith(`INSERT INTO ${table} `));

describe("catalog transfer memberships", () => {
  test("writes nothing when there are no memberships", () => {
    expect(membershipStatements([])).toEqual([]);
  });

  test("writes only the membership row when nothing is overridden", () => {
    const statements = membershipStatements([membership()]);

    expect(statements).toEqual([
      {
        args: [4, 9, 1],
        sql: "INSERT INTO group_listings (group_id, listing_id, quantity) VALUES (?, ?, ?)",
      },
    ]);
  });

  test("puts a flat override in the group price dimension", () => {
    const prices = statementFor(
      membershipStatements([membership({ packagePrice: 2500 })]),
      "listing_prices",
    );

    // The column list is asserted whole: a price row that names its columns
    // wrongly writes the override into the wrong dimension, and the values
    // alone cannot show that.
    expect(prices).toEqual({
      args: [9, PRICE_TYPE_GROUP, "4", 2500],
      sql:
        "INSERT INTO listing_prices " +
        "(listing_id, price_type, price_id, unit_price) VALUES (?, ?, ?, ?)",
    });
  });

  test("keys a per-day override by its group and day count", () => {
    const prices = statementFor(
      membershipStatements([membership({ dayPrices: { 1: 1000, 2: 1800 } })]),
      "listing_prices",
    );

    expect(prices?.args).toEqual([
      9,
      PRICE_TYPE_GROUP_DAY,
      "4/1",
      1000,
      9,
      PRICE_TYPE_GROUP_DAY,
      "4/2",
      1800,
    ]);
  });

  test("drops a day price the stored shape does not allow", () => {
    const prices = statementFor(
      membershipStatements([
        membership({ dayPrices: { 0: 500, 2: 1800 } as never }),
      ]),
      "listing_prices",
    );

    expect(prices?.args).toEqual([9, PRICE_TYPE_GROUP_DAY, "4/2", 1800]);
  });

  test("writes the flat override before the per-day ones", () => {
    const prices = statementFor(
      membershipStatements([
        membership({ dayPrices: { 1: 1000 }, packagePrice: 2500 }),
      ]),
      "listing_prices",
    );

    expect(prices?.args.slice(0, 4)).toEqual([9, PRICE_TYPE_GROUP, "4", 2500]);
    expect(prices?.args.slice(4)).toEqual([
      9,
      PRICE_TYPE_GROUP_DAY,
      "4/1",
      1000,
    ]);
  });

  // A statement per member would blow past the transaction's round-trip cap
  // for a group of any size, so many members must still be two statements.
  test("batches every member into one statement per table", () => {
    const members = Array.from({ length: 30 }, (_, index) =>
      membership({
        listingId: index + 1,
        packagePrice: 100 * (index + 1),
        quantity: index + 1,
      }),
    );

    const statements = membershipStatements(members);
    const rows = statementFor(statements, "group_listings");
    const prices = statementFor(statements, "listing_prices");

    expect(statements).toHaveLength(2);
    expect(rows?.args).toHaveLength(90);
    expect(rows?.sql.match(/\(\?, \?, \?\)/gu)).toHaveLength(30);
    expect(prices?.args).toHaveLength(120);
  });

  test("separates one row's placeholders from the next", () => {
    const rows = statementFor(
      membershipStatements([
        membership(),
        membership({ groupId: 5, listingId: 10, quantity: 2 }),
      ]),
      "group_listings",
    );

    // Run the row groups together and SQLite reads one row of six columns
    // against a three-column insert, so the whole write is refused.
    expect(rows?.sql).toBe(
      "INSERT INTO group_listings (group_id, listing_id, quantity) " +
        "VALUES (?, ?, ?), (?, ?, ?)",
    );
    expect(rows?.args).toEqual([4, 9, 1, 5, 10, 2]);
  });

  test("gives every argument its own placeholder", () => {
    for (const { args, sql } of membershipStatements([
      membership({ dayPrices: { 3: 2400 }, packagePrice: 2500 }),
      membership({ groupId: 5, listingId: 10, quantity: 2 }),
    ])) {
      expect(sql.match(/\?/gu)).toHaveLength(args.length);
    }
  });
});
