import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { questionTables } from "#db/migrations/schema/tables-questions.ts";
import { jsonHash } from "#test-utils/hash.ts";
import { sqlText } from "#test-utils/sql-text.ts";

/** The identity hash of this group's declaration. A column, index, or trigger
 * change moves it. */
const QUESTION_TABLES_HASH =
  "9f76ad79867722f23d181159436babc67baf41fc3d5302e84aa15a9f669dc821";

test("keeps the complete question and built-site schema exact", async () => {
  expect(await jsonHash(sqlText(questionTables))).toBe(QUESTION_TABLES_HASH);
});

test("lets an interned string carry a hold time that is empty by default", () => {
  const strings = questionTables.find(([name]) => name === "strings");
  if (!strings) throw new Error("strings schema is missing");

  expect(sqlText(strings[1].columns)).toContainEqual(["hold_until", "TEXT"]);
});

test("versions built-site data without the retired prune marker", () => {
  const builtSites = questionTables.find(([name]) => name === "built_sites");
  if (!builtSites) throw new Error("built_sites schema is missing");

  const columns = builtSites[1].columns;
  expect(sqlText(columns)).toContainEqual([
    "site_data_revision",
    "INTEGER NOT NULL DEFAULT 0",
  ]);
  assert(
    !columns.some(
      ([name]: readonly [string, unknown]) => name === "last_pruned",
    ),
  );
});
