import { assert } from "@std/assert";
import { describe, it as test } from "@std/testing/bdd";
import { defineTable } from "#shared/tables/definition.ts";
import { renderTable } from "#templates/components/table.tsx";
import { says } from "#test-utils/says.ts";

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
      filters: new Map([["value", expression]]),
    }),
  );

describe("filtered table cells", () => {
  test("passes numeric values to Liquid filters", () => {
    says(renderFilteredCell(5, "value | plus: 2"), "<td>7</td>");
  });

  test("applies non-date filters to raw strings", () => {
    says(renderFilteredCell("tickets", "value | upcase"), "<td>TICKETS</td>");
  });

  test("passes invalid date strings through unchanged", () => {
    says(
      renderFilteredCell("not-a-date", 'value | date: "%B"'),
      "<td>not-a-date</td>",
    );
  });

  test("formats a date when date is the first filter", () => {
    says(
      renderFilteredCell("2026-04-10T12:00:00Z", 'value | date: "%B %Y"'),
      "<td>April 2026</td>",
    );
  });

  test("keeps the raw string when date appears later in a filter chain", () => {
    says(
      renderFilteredCell(
        "2026-04-10",
        'value | append: "T00:00:00Z" | date: "%Y"',
      ),
      "<td>2026</td>",
    );
  });

  test("uses the normal cell renderer when a column has no raw value", () => {
    const table = defineTable<ValueRow>([
      { cell: () => "Default value", header: "Value", key: "value" },
    ]);
    const html = String(
      renderTable(table, [{ value: "ignored" }], {
        filters: new Map([["value", "value | upcase"]]),
      }),
    );

    says(html, "<td>Default value</td>");
    assert(!html.includes("IGNORED"));
  });
});
