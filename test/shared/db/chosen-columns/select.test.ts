/**
 * Tests for a declared read (`select` / `selectOne` in
 * `src/shared/db/chosen-columns.ts`), which puts the chosen columns and their
 * table together with the shared filters, so an ordinary single-table read
 * needs no SQL of its own.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { chooseColumns } from "#shared/db/chosen-columns.ts";
import {
  listingOptionColumns,
  rawListingsTable,
} from "#shared/db/listings/table.ts";
import {
  enableQueryLog,
  getQueryLog,
  runWithQueryLogContext,
} from "#shared/db/query-log.ts";
import { equals, inList } from "#shared/db/where-clauses.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

describeWithEnv("db > chosen columns > declared reads", { db: true }, () => {
  test("reads every row when nothing is asked of it", async () => {
    const first = await createTestListing({ name: "Alpha" });
    const second = await createTestListing({ name: "Beta" });

    const rows = await listingOptionColumns.select({ alias: "listing" });

    expect(rows.map(({ id }) => id).toSorted()).toEqual(
      [first.id, second.id].toSorted(),
    );
  });

  test("keeps only the rows the clauses select", async () => {
    const wanted = await createTestListing({ name: "Wanted" });
    await createTestListing({ name: "Unwanted" });

    const rows = await listingOptionColumns.select({
      alias: "listing",
      where: equals("listing.id", wanted.id),
    });

    expect(rows.map(({ name }) => name)).toEqual(["Wanted"]);
  });

  test("orders and caps the rows", async () => {
    const first = await createTestListing({ name: "First" });
    const second = await createTestListing({ name: "Second" });

    const rows = await listingOptionColumns.select({
      alias: "listing",
      limit: 1,
      order: "listing.id DESC",
    });

    expect(rows.map(({ id }) => id)).toEqual([Math.max(first.id, second.id)]);
  });

  test("reads a single row, or null when nothing matches", async () => {
    const listing = await createTestListing({ name: "Only" });

    expect(
      await listingOptionColumns.selectOne({
        alias: "listing",
        where: equals("listing.id", listing.id),
      }),
    ).toMatchObject({ id: listing.id, name: "Only" });
    expect(
      await listingOptionColumns.selectOne({
        alias: "listing",
        where: equals("listing.id", 999_999),
      }),
    ).toBeNull();
  });

  test("fetches the row's own key even when it was not chosen", async () => {
    // A column's read transform may name the row a bad value came from, which
    // it can only do if the key came back with it — but the key is not part of
    // what the caller asked for, so it must not be handed back either.
    const listing = await createTestListing({ name: "Keyed" });
    const nameOnly = chooseColumns(rawListingsTable, ["name"]);

    await runWithQueryLogContext(async () => {
      enableQueryLog();
      const rows = await nameOnly.select({
        alias: "listing",
        where: equals("listing.id", listing.id),
      });

      // Only the selected columns count — the filter names the key too.
      const sql = getQueryLog()[0]?.sql ?? "";
      expect(sql.slice(0, sql.indexOf(" FROM "))).toContain("listing.id");
      expect(rows).toEqual([{ name: "Keyed" }]);
    });
  });

  test("asks the database nothing when the filter can match no row", async () => {
    await createTestListing({ name: "Present" });

    await runWithQueryLogContext(async () => {
      enableQueryLog();
      expect(
        await listingOptionColumns.select({
          alias: "listing",
          where: inList("listing.id", []),
        }),
      ).toEqual([]);
      expect(
        await listingOptionColumns.selectOne({
          alias: "listing",
          where: inList("listing.id", []),
        }),
      ).toBeNull();
      expect(getQueryLog()).toEqual([]);
    });
  });
});
