import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { defineTable } from "#shared/tables/definition.ts";
import {
  combineClasses,
  renderColumnReference,
  renderTable,
  tableColumnText,
} from "#templates/components/table.tsx";

describe("typed table rendering", () => {
  test("ignores non-text and empty cell classes", () => {
    expect(combineClasses(4, true, "", false, undefined)).toBe("");
  });

  test("uses the label as the default column header", () => {
    const defaults = tableColumnText(
      () => "Name",
      () => "Stored name",
    );
    expect(defaults.label()).toBe("Name");
    expect(defaults.description()).toBe("Stored name");
    expect(defaults.header()).toBe("Name");
    expect(
      tableColumnText(
        () => "Name",
        () => "Stored name",
        () => "Listing name",
      ).header(),
    ).toBe("Listing name");
  });

  test("renders row values, attributes, classes, and an empty state", () => {
    const table = defineTable<{ amount: number }>([
      {
        cell: (row) => row.amount,
        cellAttrs: () => ({ class: "highlight", title: "Exact amount" }),
        class: "amount",
        header: "Amount",
        key: "amount",
      },
    ]);

    expect(String(renderTable(table, [{ amount: 12 }]))).toContain(
      '<td class="col-amount highlight" title="Exact amount">12</td>',
    );
    expect(String(renderTable(table, [], { empty: "None" }))).toContain(
      '<td colspan="1">None</td>',
    );
  });

  test("renders only documented columns in the reference", () => {
    const table = defineTable<{ name: string }>([
      {
        cell: (row) => row.name,
        description: "Stored name",
        header: "Name",
        key: "name",
        label: "Name",
      },
      { cell: () => "hidden", header: "Internal", key: "internal" },
    ]);

    const html = String(renderColumnReference(table));
    expect(html).toContain("{{name}}");
    expect(html).toContain("Stored name");
    expect(html).not.toContain("{{internal}}");
  });
});
