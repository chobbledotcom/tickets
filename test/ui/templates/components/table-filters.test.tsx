import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { defineTable } from "#shared/tables/definition.ts";
import { renderTable } from "#templates/components/table.tsx";
import { filteredTableCells } from "#templates/components/table-filters.ts";

type ValueRow = { readonly value: unknown };

const filterableTable = defineTable<ValueRow>([
  {
    cell: () => "Default value",
    header: "Value",
    key: "value",
    rawValue: (row) => row.value,
  },
]);

const renderFilteredCell = (value: unknown, expression: string): string =>
  String(
    renderTable(filterableTable, [{ value }], {
      renderCell: filteredTableCells<ValueRow, undefined, string>(
        new Map([["value", expression]]),
      ),
    }),
  );

describe("filtered table cells", () => {
  test("passes numeric values to Liquid filters", () => {
    expect(renderFilteredCell(5, "value | plus: 2")).toContain("<td>7</td>");
  });

  test("applies non-date filters to raw strings", () => {
    expect(renderFilteredCell("tickets", "value | upcase")).toContain(
      "<td>TICKETS</td>",
    );
  });

  test("passes invalid date strings through unchanged", () => {
    expect(renderFilteredCell("not-a-date", 'value | date: "%B"')).toContain(
      "<td>not-a-date</td>",
    );
  });

  test("formats a date when date is the first filter", () => {
    expect(
      renderFilteredCell("2026-04-10T12:00:00Z", 'value | date: "%B %Y"'),
    ).toContain("<td>April 2026</td>");
  });

  test("keeps the raw string when date appears later in a filter chain", () => {
    expect(
      renderFilteredCell(
        "2026-04-10",
        'value | append: "T00:00:00Z" | date: "%Y"',
      ),
    ).toContain("<td>2026</td>");
  });

  test("uses the normal cell renderer when a column has no raw value", () => {
    const table = defineTable<ValueRow>([
      { cell: () => "Default value", header: "Value", key: "value" },
    ]);
    const html = String(
      renderTable(table, [{ value: "ignored" }], {
        renderCell: filteredTableCells<ValueRow, undefined, string>(
          new Map([["value", "value | upcase"]]),
        ),
      }),
    );

    expect(html).toContain("<td>Default value</td>");
    expect(html).not.toContain("IGNORED");
  });
});
