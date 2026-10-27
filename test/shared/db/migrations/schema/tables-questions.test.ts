import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { questionTables } from "#db/migrations/schema/tables-questions.ts";
import { jsonHash } from "#test-utils/hash.ts";

test("keeps the complete question and built-site schema exact", async () => {
  expect(await jsonHash(questionTables)).toBe(
    "660ab4105351332370e339e05fb434f59578b52ec879324b3d7da52b1adb224b",
  );
});

test("versions built-site data without the retired prune marker", () => {
  const builtSites = questionTables.find(([name]) => name === "built_sites");
  if (!builtSites) throw new Error("built_sites schema is missing");

  const columns = builtSites[1].columns;
  expect(columns).toContainEqual([
    "site_data_revision",
    "INTEGER NOT NULL DEFAULT 0",
  ]);
  assert(!columns.map(([name]) => name).includes("last_pruned"));
});
