import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import type { ShownField } from "#shared/rest/field-specs.ts";
import { fieldTableColumns } from "#templates/admin/field-columns.tsx";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";

// The name header differs from the shared "Name" heading, so the field's own
// header must win over the one the name column brings.
const FIELDS = [
  {
    header: "holidays.col.end_date",
    key: "name",
    kind: "name",
    label: "fields.holiday.name",
  },
  {
    header: "holidays.col.start_date",
    key: "starts",
    kind: "date",
    label: "fields.holiday.start_date",
  },
] as const satisfies readonly ShownField[];

const row = { id: 5, name: "Fair & Fun", starts: "2026-01-02" };

const headerText = (header: unknown): string =>
  typeof header === "function" ? String(header()) : String(header);

describe("fieldTableColumns", () => {
  beforeAll(setupAdminPageTest);

  test("builds one column per field, keyed and headed by the field", () => {
    const columns = fieldTableColumns(FIELDS, (r) => `/edit/${r.id}`);
    expect(columns.map((column) => column.key)).toEqual(["name", "starts"]);
    expect(columns.map((column) => headerText(column.header))).toEqual([
      "End date",
      "Start date",
    ]);
  });

  test("a name cell links to the record and a date cell shows its text", () => {
    const columns = fieldTableColumns(FIELDS, (r) => `/edit/${r.id}`);
    expect(
      columns.map((column) => String(column.cell(row, undefined, 0, [row]))),
    ).toEqual(['<a href="/edit/5">Fair &amp; Fun</a>', "2026-01-02"]);
  });
});
