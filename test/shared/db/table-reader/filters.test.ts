/**
 * Tests for `src/shared/db/table-reader.ts` — reading a table with the filter
 * written as the row. These use real tables, so the inference and the guards
 * being claimed are the ones a caller actually gets.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { attributesTable } from "#db/attributes.ts";
import { rawListingsTable } from "#db/listings/table.ts";
import { col, defineTable } from "#db/table.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

describeWithEnv("db > table reader > filters", { db: true }, () => {
  const attributes = attributesTable.read;
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

  test("existence is a yes-or-no, not a row", async () => {
    const made = await add("There");

    expect(await attributes.exists({ id: made.id })).toBe(true);
    expect(await attributes.exists({ id: made.id + 1000 })).toBe(false);
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

describeWithEnv(
  "db > table reader > a table with worked-out values",
  { db: true },
  () => {
    // listings works its image values out from other tables: they are in a
    // Listing, but they are not columns of `listings`.
    test("refuses even a single worked-out value", () => {
      // One is enough to make a whole-row read a lie, so the refusal must not
      // wait for a second.
      const oneWorkedOut = defineTable<
        { id: number; worked_out: string },
        never
      >({
        name: "attributes",
        primaryKey: "id",
        schema: {
          id: col.generated<number>(),
          worked_out: col.projected<string>(() => "from elsewhere"),
        },
      });

      expect(() => oneWorkedOut.read.many()).toThrow(
        "attributes has values that are not stored columns (worked_out)",
      );
    });

    test("refuses a whole-row read it could not answer honestly", () => {
      // Every value it could not have returned is named, and named apart, so
      // the reader is told exactly what to ask for instead.
      const refusal =
        "listings has values that are not stored columns (image_alt_text, image_thumb_url, image_url, day_prices)";

      expect(() => rawListingsTable.read.many()).toThrow(refusal);
      expect(() => rawListingsTable.read.one({ id: 1 })).toThrow(refusal);
    });

    test("refuses a filter naming a value it does not store", () => {
      // Without this the read would reach the database as
      // `WHERE image_url = ?` and fail there on a column listings has never
      // had — a mistake worth catching as the call is made.
      expect(() =>
        rawListingsTable.read.pick(["id"]).many({ image_url: "x" }),
      ).toThrow(
        "Cannot filter listings by image_url: it is not one of its columns",
      );
    });

    test("still answers whether a row is there", async () => {
      const listing = await createTestListing({ name: "Findable" });

      expect(await rawListingsTable.read.exists({ id: listing.id })).toBe(true);
      expect(await rawListingsTable.read.exists({ id: 999_999 })).toBe(false);
    });
  },
);
