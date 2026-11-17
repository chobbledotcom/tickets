/**
 * Tests for `src/shared/db/read.ts`: the runners of a read from the builder.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  readBatch,
  readBatchPrimary,
  readExists,
  readOneRow,
  readRows,
} from "#db/read.ts";
import { among } from "#db/select/expression.ts";
import { from } from "#db/select/query.ts";
import { tables } from "#db/select/tables.ts";
import { type RowsStatement, sql, typedSql } from "#db/sql.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

const listingIds = (ids: readonly number[]) =>
  from(tables.listings)
    .where((listing) => among(listing.id, ids))
    .orderBy((listing) => [listing.id])
    .select((listing) => ({ id: listing.id }));

/** The ids of two stored listings, in the order of the database. */
const twoListingIds = async (): Promise<[number, number]> => {
  const first = await createTestListing({ name: "First" });
  const second = await createTestListing({ name: "Second" });
  return [first.id, second.id];
};

describeWithEnv("readRows", { db: true }, () => {
  test("returns every row that the read keeps", async () => {
    const [first, second] = await twoListingIds();

    expect(await readRows(listingIds([second, first]))).toEqual([
      { id: first },
      { id: second },
    ]);
  });

  test("returns no row when the read keeps none", async () => {
    await createTestListing({ name: "Other" });

    expect(await readRows(listingIds([-1]))).toEqual([]);
  });
});

describe("a read that no row can pass", () => {
  // No database exists here, so a round trip would throw.
  test("is answered with no rows and no round trip", async () => {
    expect(await readRows(listingIds([]))).toEqual([]);
  });

  test("is answered with null for one row", async () => {
    expect(await readOneRow(listingIds([]))).toBe(null);
  });
});

describeWithEnv("readOneRow", { db: true }, () => {
  test("returns the first row that the read keeps", async () => {
    const [first, second] = await twoListingIds();

    expect(await readOneRow(listingIds([first, second]))).toEqual({
      id: first,
    });
  });

  test("returns null when the read keeps no row", async () => {
    expect(await readOneRow(listingIds([-1]))).toBe(null);
  });
});

describeWithEnv("readExists", { db: true }, () => {
  test("is true when the read has a row", async () => {
    const [first] = await twoListingIds();

    expect(await readExists(from(tables.listings).where({ id: first }))).toBe(
      true,
    );
  });

  test("is false when the read has no row", async () => {
    await createTestListing({ name: "Other" });

    expect(await readExists(from(tables.listings).where({ id: -1 }))).toBe(
      false,
    );
  });
});

describe("readExists of a read that no row can pass", () => {
  // No database exists here, so a round trip would throw.
  test("is false with no round trip", async () => {
    expect(await readExists(from(tables.listings).where({ id: [] }))).toBe(
      false,
    );
  });
});

for (const [name, run] of Object.entries({ readBatch, readBatchPrimary })) {
  describeWithEnv(name, { db: true }, () => {
    test("gives the rows of each read in the order of the reads", async () => {
      const [first, second] = await twoListingIds();

      const [none, ids, [counted], plain] = await run([
        listingIds([]),
        listingIds([second, first]),
        typedSql<RowsStatement<{ total: number }>>(
          sql`SELECT COUNT(*) AS total FROM listings`,
        ),
        sql`SELECT 7 AS seven`,
      ]);
      const firstId: number = ids[0]!.id;
      const total: number = counted!.total;
      // @ts-expect-error a statement that names no row gives rows of no type
      const seven: number = plain[0];

      expect({ firstId, ids, none, seven, total }).toEqual({
        firstId: first,
        ids: [{ id: first }, { id: second }],
        none: [],
        seven: { seven: 7 },
        total: 2,
      });
    });

    test("refuses a statement that writes", async () => {
      await expect(run([sql`DELETE FROM listings`])).rejects.toThrow(
        "Read-only batch executors accept only SELECT statements: DELETE FROM listings",
      );
    });
  });
}
