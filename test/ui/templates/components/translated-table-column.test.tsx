import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { resetI18nForTest } from "#i18n";
import { defineTable } from "#shared/tables/definition.ts";
import { renderTable } from "#templates/components/table.tsx";
import { translatedTableColumn } from "#templates/components/translated-table-column.ts";
import { withEnv } from "#test-utils/env.ts";

const nameColumn = translatedTableColumn<{ value: string }, "name">(
  "name",
  "common.name",
  (row) => row.value,
);
const exactKey: "name" = nameColumn.key;
const table = defineTable([nameColumn]);
void exactKey;

const headerWith = (replacement: string): string => {
  using _env = withEnv({ I18N_REPLACEMENTS: `name|${replacement}` });
  resetI18nForTest();
  return String(renderTable(table, [{ value: "Row" }]));
};

test("resolves translated table headings for each render", () => {
  try {
    expect(headerWith("first")).toContain("<th>First</th>");
    expect(headerWith("second")).toContain("<th>Second</th>");
  } finally {
    resetI18nForTest();
  }
});
