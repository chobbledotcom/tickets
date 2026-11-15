import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { questionTables } from "#db/migrations/schema/tables-questions.ts";
import { jsonHash } from "#test-utils/hash.ts";
import { sqlText } from "#test-utils/sql-text.ts";

/** The identity hash of this group's declaration. A column, index, or trigger
 * change moves it. */
const QUESTION_TABLES_HASH =
  "4bc2c397a32c678529ecea1ab7b91a7ee504c9158d51ae0ab027b22848a01ff5";

test("keeps the complete question and built-site schema exact", async () => {
  expect(await jsonHash(sqlText(questionTables))).toBe(QUESTION_TABLES_HASH);
});

test("versions built-site data without the retired prune marker", () => {
  const builtSites = questionTables.find(([name]) => name === "built_sites");
  if (!builtSites) throw new Error("built_sites schema is missing");

  const columns = builtSites[1].columns;
  expect(sqlText(columns)).toContainEqual([
    "site_data_revision",
    "INTEGER NOT NULL DEFAULT 0",
  ]);
  assert(!columns.map(([name]) => name).includes("last_pruned"));
});
