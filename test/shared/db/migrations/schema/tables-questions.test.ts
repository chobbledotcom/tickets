import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { questionTables } from "#shared/db/migrations/schema/tables-questions.ts";
import { jsonHash } from "#test-utils/hash.ts";

test("keeps the complete question and built-site schema exact", async () => {
  expect(await jsonHash(questionTables)).toBe(
    "b2cb65571a95e6cad5cf42d2de7f88818719da14151f8eabbff2e761f8f52c85",
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
