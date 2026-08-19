/**
 * Tests for the reads a table's reader runs (`src/shared/db/table-reader.ts`),
 * which put the chosen columns and their table together with the shared
 * filters, so an ordinary single-table read needs no SQL of its own.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb, resultRows } from "#db/client.ts";
import { listingOptionColumns, rawListingsTable } from "#db/listings/table.ts";
import {
  enableQueryLog,
  getQueryLog,
  runWithQueryLogContext,
} from "#db/query-log.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

describeWithEnv("db > table reader > reads", { db: true }, () => {
  test("reads every row when nothing is asked of it", async () => {
    const first = await createTestListing({ name: "Alpha" });
    const second = await createTestListing({ name: "Beta" });

    const rows = await listingOptionColumns.many({}, { alias: "listing" });

    expect(rows.map(({ id }) => id).toSorted()).toEqual(
      [first.id, second.id].toSorted(),
    );
  });

  test("keeps only the rows the clauses select", async () => {
    const wanted = await createTestListing({ name: "Wanted" });
    await createTestListing({ name: "Unwanted" });

    const rows = await listingOptionColumns.many(
      { id: wanted.id },
      { alias: "listing" },
    );

    expect(rows.map(({ name }) => name)).toEqual(["Wanted"]);
  });

  test("orders and caps the rows", async () => {
    const first = await createTestListing({ name: "First" });
    const second = await createTestListing({ name: "Second" });

    const rows = await listingOptionColumns.many(
      {},
      { alias: "listing", limit: 1, order: "listing.id DESC" },
    );

    expect(rows.map(({ id }) => id)).toEqual([Math.max(first.id, second.id)]);
  });

  test("reads a single row, or null when nothing matches", async () => {
    const listing = await createTestListing({ name: "Only" });

    expect(
      await listingOptionColumns.one({ id: listing.id }, { alias: "listing" }),
    ).toMatchObject({ id: listing.id, name: "Only" });
    expect(
      await listingOptionColumns.one({ id: 999_999 }, { alias: "listing" }),
    ).toBeNull();
  });

  test("fetches the row's own key even when it was not chosen", async () => {
    // A column's read transform may name the row a bad value came from, which
    // it can only do if the key came back with it — but the key is not part of
    // what the caller asked for, so it must not be handed back either.
    const listing = await createTestListing({ name: "Keyed" });
    const nameOnly = rawListingsTable.read.pick(["name"]);

    await runWithQueryLogContext(async () => {
      enableQueryLog();
      const rows = await nameOnly.many(
        { id: listing.id },
        { alias: "listing" },
      );

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
        await listingOptionColumns.many({ id: [] }, { alias: "listing" }),
      ).toEqual([]);
      expect(
        await listingOptionColumns.one({ id: [] }, { alias: "listing" }),
      ).toBeNull();
      expect(getQueryLog()).toEqual([]);
    });
  });

  test("hands out the same read as a statement, to run elsewhere", async () => {
    const wanted = await createTestListing({ name: "Batched" });
    await createTestListing({ name: "Other" });

    // A caller inside its own transaction runs the statement itself, and opens
    // the rows with the very same chosen set — so it cannot drift from what
    // `many` would have read.
    const statement = listingOptionColumns.statement({ id: wanted.id });
    const rows = await listingOptionColumns.readAll(
      resultRows(await getDb().execute(statement)),
    );

    expect(rows).toEqual(await listingOptionColumns.many({ id: wanted.id }));
    expect(rows.map(({ id }) => id)).toEqual([wanted.id]);
  });

  test("clauses the row shape cannot say narrow the read too", async () => {
    const wanted = await createTestListing({ name: "Wanted" });
    const other = await createTestListing({ name: "Other" });

    // Both must hold: the filter written as the row, and the clause written by
    // hand. A read that dropped either would keep a listing it was not asked
    // for, so each is checked by the read that only it rules out.
    const bothHold = await listingOptionColumns.many(
      { id: [wanted.id, other.id] },
      {
        alias: "listing",
        where: [{ args: [wanted.id], clause: "listing.id = ?" }],
      },
    );
    const clauseRulesOutEveryRow = await listingOptionColumns.many(
      { id: [wanted.id, other.id] },
      { alias: "listing", where: [{ args: [], clause: "listing.active = 0" }] },
    );
    const filterRulesOutTheRest = await listingOptionColumns.many(
      { id: [wanted.id] },
      { alias: "listing", where: [{ args: [], clause: "listing.active = 1" }] },
    );

    expect(bothHold.map(({ id }) => id)).toEqual([wanted.id]);
    expect(clauseRulesOutEveryRow).toEqual([]);
    expect(filterRulesOutTheRest.map(({ id }) => id)).toEqual([wanted.id]);
  });
});
