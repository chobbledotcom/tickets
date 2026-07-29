/**
 * Tests for `src/shared/db/table-reader.ts` — reading a table with the filter
 * written as the row. These use real tables, so the inference and the guards
 * being claimed are the ones a caller actually gets.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { attributesTable } from "#shared/db/attributes.ts";
import { rawListingsTable } from "#shared/db/listings/table.ts";
import { readerFor } from "#shared/db/table-reader.ts";
import { describeWithEnv } from "#test-utils/db.ts";

describeWithEnv("db > table reader", { db: true }, () => {
  const attributes = readerFor(attributesTable);
  const add = (name: string, sortOrder = 0) =>
    attributesTable.insert({ name, sortOrder });

  test("reads a whole row, decrypted, without naming its columns", async () => {
    const made = await add("Whole");

    const row = await attributes.one({ id: made.id });

    // `name` is stored encrypted; the reader opens it because the table says to.
    expect(row).toEqual({ id: made.id, name: "Whole", sort_order: 0 });
  });

  test("a value filters by equals, a list by is-one-of", async () => {
    const first = await add("First");
    const second = await add("Second");

    const one = await attributes.many({ id: first.id });
    const both = await attributes.many({ id: [first.id, second.id] });

    expect(one.map((row) => row.name)).toEqual(["First"]);
    expect(both.map((row) => row.name).sort()).toEqual(["First", "Second"]);
  });

  test("several columns in one filter must all match", async () => {
    const made = await add("Both", 7);

    expect(await attributes.one({ id: made.id, sort_order: 7 })).not.toBeNull();
    expect(await attributes.one({ id: made.id, sort_order: 8 })).toBeNull();
  });

  test("an empty filter keeps every row", async () => {
    await add("Only");

    expect((await attributes.many()).map((row) => row.name)).toEqual(["Only"]);
  });

  test("asking for none of something asks the database nothing", async () => {
    await add("Present");

    expect(await attributes.many({ id: [] })).toEqual([]);
  });

  test("one returns null when the filter keeps nothing", async () => {
    expect(await attributes.one({ id: 987_654 })).toBeNull();
  });

  test("options order and cap the rows", async () => {
    await add("Alpha");
    await add("Beta");

    const rows = await attributes.many({}, { limit: 1, order: "id DESC" });

    expect(rows.map((row) => row.name)).toEqual(["Beta"]);
  });

  test("pick selects only the named columns", async () => {
    const made = await add("Narrow");

    const row = await attributes.pick(["id", "name"]).one({ id: made.id });

    expect(row).toEqual({ id: made.id, name: "Narrow" });
  });

  test("a narrowed read can still filter on a column it does not select", async () => {
    const made = await add("Filtered", 3);

    const row = await attributes
      .pick(["name"])
      .one({ id: made.id, sort_order: 3 });

    expect(row).toEqual({ name: "Filtered" });
  });

  test("refuses to filter on a column stored in another form", async () => {
    await add("Sealed");

    // `name` is encrypted, so comparing it against the plain word would match
    // nothing and read as "no such attribute" rather than as a mistake. It is
    // refused as the call is made, before any query is built.
    expect(() => attributes.one({ name: "Sealed" })).toThrow(
      "Cannot filter attributes by name: it is stored in a different form",
    );
  });
});

describe("readerFor guards", () => {
  test("refuses a table whose row is more than its stored columns", () => {
    // listings works its image and day-price values out from other tables, so a
    // whole-row read cannot return a whole Listing.
    expect(() => readerFor(rawListingsTable)).toThrow(
      "listings has values that are not stored columns",
    );
  });
});
