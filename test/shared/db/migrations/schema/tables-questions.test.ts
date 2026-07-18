import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { questionTables } from "#shared/db/migrations/schema/tables-questions.ts";

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
