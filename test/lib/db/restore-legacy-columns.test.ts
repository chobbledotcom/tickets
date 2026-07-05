import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { legacyColumnRestores } from "#shared/db/restore-legacy-columns.ts";

describe("db > restore legacy columns", () => {
  const legacyInsert = `INSERT INTO "listings" ("id", "name", "image_url") VALUES (1, 'cipher', 'img');`;

  test("re-adds a column the current schema no longer declares", () => {
    expect(legacyColumnRestores([legacyInsert])).toEqual([
      `ALTER TABLE "listings" ADD COLUMN "image_url"`,
    ]);
  });

  test("returns nothing when every dump column is still declared", () => {
    expect(
      legacyColumnRestores([
        `INSERT INTO "settings" ("key", "value") VALUES ('a', 'b');`,
      ]),
    ).toEqual([]);
  });

  test("re-adds each legacy column once across repeated statements", () => {
    expect(legacyColumnRestores([legacyInsert, legacyInsert])).toEqual([
      `ALTER TABLE "listings" ADD COLUMN "image_url"`,
    ]);
  });

  test("collects legacy columns per table across the whole dump", () => {
    const statements = [
      legacyInsert,
      `INSERT INTO "holidays" ("id", "legacy_note") VALUES (1, 'x');`,
    ];
    expect(legacyColumnRestores(statements)).toEqual([
      `ALTER TABLE "listings" ADD COLUMN "image_url"`,
      `ALTER TABLE "holidays" ADD COLUMN "legacy_note"`,
    ]);
  });

  test("ignores tables the current schema does not declare", () => {
    expect(
      legacyColumnRestores([
        `INSERT INTO "events" ("id", "image_url") VALUES (1, 'img');`,
      ]),
    ).toEqual([]);
  });

  test("ignores statements that are not exportTable-shaped INSERTs", () => {
    expect(
      legacyColumnRestores([
        "DELETE FROM listings;",
        "INSERT INTO listings (id, image_url) VALUES (1, 'unquoted');",
      ]),
    ).toEqual([]);
  });

  test("leaves a column list with a non-identifier token for the INSERT to reject", () => {
    expect(
      legacyColumnRestores([
        `INSERT INTO "listings" ("id", "bad""name") VALUES (1, 'x');`,
      ]),
    ).toEqual([]);
  });
});
