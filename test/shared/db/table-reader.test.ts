/**
 * Tests for `src/shared/db/table-reader.ts` — reading a table with the filter
 * written as the row. These use the real listings table so the inference being
 * claimed is the inference a caller actually gets.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { rawListingsTable } from "#shared/db/listings/table.ts";
import { readerFor } from "#shared/db/table-reader.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

describeWithEnv("db > table reader", { db: true }, () => {
  const listings = readerFor(rawListingsTable);

  test("reads a whole row, decrypted, without naming its columns", async () => {
    const made = await createTestListing({ name: "Whole" });

    const listing = await listings.one({ id: made.id });

    // `name` is stored encrypted; the reader opens it because the table says to.
    expect(listing?.name).toBe("Whole");
  });

  test("a value filters by equals, a list by is-one-of", async () => {
    const first = await createTestListing({ name: "First" });
    const second = await createTestListing({ name: "Second" });

    const one = await listings.many({ id: first.id });
    const both = await listings.many({ id: [first.id, second.id] });

    expect(one.map((row) => row.name)).toEqual(["First"]);
    expect(both.map((row) => row.name).sort()).toEqual(["First", "Second"]);
  });

  test("several columns in one filter must all match", async () => {
    const listing = await createTestListing({ active: true, name: "Both" });

    expect(await listings.one({ active: true, id: listing.id })).not.toBeNull();
    expect(await listings.one({ active: false, id: listing.id })).toBeNull();
  });

  test("an empty filter keeps every row", async () => {
    await createTestListing({ name: "Only" });

    expect((await listings.many()).map((row) => row.name)).toEqual(["Only"]);
  });

  test("asking for none of something asks the database nothing", async () => {
    await createTestListing({ name: "Present" });

    expect(await listings.many({ id: [] })).toEqual([]);
  });

  test("one returns null when the filter keeps nothing", async () => {
    expect(await listings.one({ id: 987_654 })).toBeNull();
  });

  test("options order and cap the rows", async () => {
    await createTestListing({ name: "Alpha" });
    await createTestListing({ name: "Beta" });

    const rows = await listings.many({}, { limit: 1, order: "id DESC" });

    expect(rows.map((row) => row.name)).toEqual(["Beta"]);
  });

  test("pick selects only the named columns", async () => {
    const made = await createTestListing({ name: "Narrow" });

    const row = await listings.pick(["id", "name"]).one({ id: made.id });

    expect(row).toEqual({ id: made.id, name: "Narrow" });
  });

  test("a narrowed read can still filter on a column it does not select", async () => {
    const made = await createTestListing({ active: true, name: "Filtered" });

    const row = await listings
      .pick(["name"])
      .one({ active: true, id: made.id });

    expect(row).toEqual({ name: "Filtered" });
  });
});
