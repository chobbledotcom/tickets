import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { questionTables } from "#db/migrations/schema/tables-questions.ts";
import { jsonHash } from "#test-utils/hash.ts";

test("keeps the complete question and built-site schema exact", async () => {
  expect(await jsonHash(questionTables)).toBe(
    "e16cdb8e6cfb8b5393a97830555714adb978abc4dc701ccf9edada4f6b1521a3",
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
