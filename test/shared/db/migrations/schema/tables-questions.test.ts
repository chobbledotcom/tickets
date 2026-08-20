import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { questionTables } from "#db/migrations/schema/tables-questions.ts";
import { jsonHash } from "#test-utils/hash.ts";

test("keeps the complete question and built-site schema exact", async () => {
  expect(await jsonHash(questionTables)).toBe(
    "ea8a403fc211af81c2805c516a458f50dcc87ad7ca86e85f76d7129d39c133e3",
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
  expect(columns.map(([name]) => name)).not.toContain("last_pruned");
});
